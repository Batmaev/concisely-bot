import asyncio
import base64
import io
import logging
import time

from aiogram import Bot, F, Router
from aiogram.types import Message
from aiogram.enums import ParseMode

from .config import BOT_TOKEN, CHAT_IDS, SUMMARY_INTERVAL, SUMMARY_INTERVALS, WIDE_LOG_DIR
from .db import (
    get_last_summary_message_id,
    get_messages_for_summary,
    get_sticker_description,
    save_message,
    save_sticker_description,
    save_summary,
    set_last_summary_message_id,
)
from .llm import (
    describe_image, describe_sticker, describe_video_note,
    generate_summary, get_model_short_name,
)
from .utils import append_wide_log, fix_html, get_attachment_info, get_message_text, get_sender_name

logger = logging.getLogger(__name__)

bot = Bot(token=BOT_TOKEN)
router = Router()

# Lock для предотвращения одновременных генераций (per-chat)
summary_locks: dict[int, asyncio.Lock] = {}
generating_chats: set[int] = set()


async def send_summary(chat_id: int, summary: str, model: str):
    """Отправляет саммари в чат."""
    summary = summary[:3000]
    summary = fix_html(summary)
    
    model_short = get_model_short_name(model)
    full_message = f"#concisely\n{summary}\n\n{model_short}"
    
    try:
        await bot.send_message(chat_id, full_message, parse_mode=ParseMode.HTML)
    except Exception as e:
        logger.warning(f"Ошибка отправки HTML, отправляем plain text: {e}")
        await bot.send_message(chat_id, full_message)


async def maybe_generate_summary(current_message_id: int, chat_id: int) -> dict:
    """Проверяет, нужно ли генерировать саммари, и генерирует если нужно."""
    summary_info: dict = {
        "attempted": False,
        "sent": False,
        "reason": None,
        "last_summary_id": None,
    }
    # Проверяем без ожидания, генерируется ли уже саммари для этого чата
    if chat_id in generating_chats:
        summary_info["reason"] = "already_generating"
        return summary_info
    
    # Получаем или создаём lock для этого чата
    if chat_id not in summary_locks:
        summary_locks[chat_id] = asyncio.Lock()
    
    async with summary_locks[chat_id]:
        if chat_id in generating_chats:
            summary_info["reason"] = "already_generating"
            return summary_info
        last_summary_id = await get_last_summary_message_id(chat_id)
        summary_info["last_summary_id"] = last_summary_id
        
        # Если это первый запуск, устанавливаем текущий ID как начальный
        if last_summary_id is None:
            await set_last_summary_message_id(chat_id, current_message_id)
            summary_info["reason"] = "first_run"
            summary_info["new_last_summary_id"] = current_message_id
            return summary_info
        
        interval = SUMMARY_INTERVALS.get(chat_id, SUMMARY_INTERVAL)
        # Проверяем, прошло ли достаточно сообщений
        if current_message_id - last_summary_id < interval:
            summary_info["reason"] = "interval_not_reached"
            summary_info["messages_since_last"] = current_message_id - last_summary_id
            summary_info["interval"] = interval
            return summary_info
        
        generating_chats.add(chat_id)
    
    start_time = None
    try:
        start_time = time.perf_counter()
        summary_info["attempted"] = True
        logger.info(f"Генерируем саммари для чата {chat_id}, сообщения {last_summary_id + 1} - {current_message_id}")
        
        messages = await get_messages_for_summary(chat_id, last_summary_id, current_message_id)
        summary_info["messages_count"] = len(messages)
        
        if not messages:
            logger.warning(f"Нет сообщений для саммаризации в чате {chat_id}")
            summary_info["reason"] = "no_messages"
            return summary_info
        
        result = await generate_summary(messages)
        await send_summary(chat_id, result.text, result.model)
        summary_info["model"] = result.model
        summary_info["summary_chars"] = len(result.text)
        summary_info["cost"] = result.cost
        
        await set_last_summary_message_id(chat_id, current_message_id)
        summary_info["new_last_summary_id"] = current_message_id
        summary_info["sent"] = True
        
        duration_ms = round((time.perf_counter() - start_time) * 1000, 2)
        await save_summary(
            chat_id=chat_id,
            from_message_id=last_summary_id,
            to_message_id=current_message_id,
            model=result.model,
            duration_ms=duration_ms,
            summary_text=result.text,
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            cost=result.cost,
        )
        
        logger.info(f"Саммари для чата {chat_id} отправлено, новый last_summary_message_id: {current_message_id}")
        
    except Exception as e:
        summary_info["reason"] = "error"
        summary_info["error"] = str(e)
        logger.error(f"Ошибка при генерации саммари для чата {chat_id}: {e}")
    finally:
        if summary_info.get("attempted"):
            summary_info["duration_ms"] = round((time.perf_counter() - start_time) * 1000, 2)
        generating_chats.discard(chat_id)
    return summary_info


async def _download_file_base64(file_id: str) -> str:
    """Скачивает файл из Telegram и возвращает base64."""
    file = await bot.get_file(file_id)
    buffer = io.BytesIO()
    await bot.download_file(file.file_path, buffer)
    buffer.seek(0)
    return base64.b64encode(buffer.read()).decode('utf-8')


async def _describe_attachment(message: Message, attachment: dict | None) -> float | None:
    """Получает описание вложения и записывает его в attachment['description'].
    
    Возвращает время выполнения в ms (или None если описание не требуется).
    """
    if not attachment:
        return None
    
    att_type = attachment["type"]
    start = time.perf_counter()
    
    try:
        if att_type == "photo" and message.photo:
            b64 = await _download_file_base64(message.photo[-1].file_id)
            result = await describe_image(b64)
            attachment["description"] = result.text
            attachment["describe_cost"] = result.cost
        
        elif att_type == "sticker" and message.sticker:
            sticker = message.sticker
            # Сначала проверяем кэш
            cached = await get_sticker_description(sticker.file_unique_id)
            if cached is not None:
                attachment["description"] = cached
            else:
                # Для анимированных/видео стикеров используем thumbnail
                if sticker.is_animated or sticker.is_video:
                    if not sticker.thumbnail:
                        logger.warning(f"У анимированного стикера {sticker.file_unique_id} нет thumbnail")
                        return round((time.perf_counter() - start) * 1000, 2)
                    file_id = sticker.thumbnail.file_id
                else:
                    file_id = sticker.file_id
                b64 = await _download_file_base64(file_id)
                result = await describe_sticker(b64)
                attachment["description"] = result.text
                attachment["describe_cost"] = result.cost
                await save_sticker_description(sticker.file_unique_id, result.text)
        
        elif att_type == "video_note" and message.video_note:
            b64 = await _download_file_base64(message.video_note.file_id)
            result = await describe_video_note(b64)
            attachment["description"] = result.text
            attachment["describe_cost"] = result.cost
        
        else:
            return None
    except Exception as e:
        logger.warning(f"Не удалось получить описание {att_type}: {e}")
    
    return round((time.perf_counter() - start) * 1000, 2)


@router.message(F.chat.id.in_(CHAT_IDS))
async def handle_message(message: Message):
    """Обрабатывает все сообщения из отслеживаемых чатов."""
    start_time = time.perf_counter()
    
    attachment = get_attachment_info(message)
    raw_message = message.model_dump(mode="json", exclude_none=True)
    
    context: dict = {
        "request_id": f"{message.chat.id}:{message.message_id}",
        "message": raw_message,
        "timings_ms": {},
    }
    try:
        describe_ms = await _describe_attachment(message, attachment)
        if describe_ms is not None:
            context["timings_ms"]["describe_attachment"] = describe_ms
            if attachment and attachment.get("description"):
                context["attachment_description"] = attachment["description"]
            if attachment and attachment.get("describe_cost") is not None:
                context["describe_cost"] = attachment["describe_cost"]
        
        save_start = time.perf_counter()
        await save_message(
            chat_id=message.chat.id,
            message_id=message.message_id,
            sender_id=message.from_user.id if message.from_user else None,
            sender_name=get_sender_name(message),
            text=get_message_text(message),
            reply_to_message_id=message.reply_to_message.message_id if message.reply_to_message else None,
            timestamp=message.date.isoformat() if message.date else None,
            raw=raw_message,
            attachment=attachment,
        )
        context["timings_ms"]["save_message"] = round((time.perf_counter() - save_start) * 1000, 2)
        
        summary_info = await maybe_generate_summary(message.message_id, message.chat.id)
        context["summary"] = summary_info
        
    except Exception as e:
        context["error"] = str(e)
        logger.error(f"Ошибка обработки сообщения: {e}", exc_info=True)
    finally:
        context["timings_ms"]["total"] = round((time.perf_counter() - start_time) * 1000, 2)
        try:
            append_wide_log(context, WIDE_LOG_DIR)
        except Exception as e:
            logger.warning(f"Не удалось записать wide log: {e}")
