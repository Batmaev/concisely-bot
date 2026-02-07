import asyncio
import base64
import io
import logging
import time
import traceback
from typing import TypedDict

from aiogram import Bot, F, Router
from aiogram.types import Message
from aiogram.enums import ParseMode

from .config import BOT_TOKEN, CHAT_IDS, SUMMARY_INTERVALS, WIDE_LOG_DIR
from .db import (
    SummaryData,
    get_last_summary_id,
    get_messages,
    get_sticker,
    save_message,
    save_sticker,
    save_summary,
    set_last_summary_id,
)
from .llm import (
    describe_image, describe_sticker, describe_video_note, describe_voice,
    generate_summary, get_model_short_name,
)
from .utils import append_wide_log, fix_html, get_attachment_info, get_forward_sender_name, get_message_text, get_sender_name, log_context, log_warning, logged, timed

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
        log_warning(f"html_fallback: {e}")
        await bot.send_message(chat_id, full_message)


class SummaryInfo(TypedDict, total=False):
    """Результат maybe_generate_summary — данные для лога."""
    # Статус
    attempted: bool
    sent: bool
    reason: str
    error: str
    # Контекст
    last_summary_id: int | None
    messages_since_last: int
    interval: int
    timing_ms: float
    # Данные саммари (если sent)
    data: SummaryData


@timed("summary")
async def _generate_and_send_summary(chat_id: int, from_id: int, to_id: int) -> SummaryData | None:
    """Генерирует, отправляет и сохраняет саммари."""
    messages = await get_messages(chat_id, from_id, to_id)
    if not messages:
        return None
    
    result = await generate_summary(messages)
    await send_summary(chat_id, result.text, result.model)
    await set_last_summary_id(chat_id, to_id)
    
    return SummaryData(
        chat_id=chat_id,
        from_message_id=from_id,
        to_message_id=to_id,
        messages_count=len(messages),
        text=result.text,
        model=result.model,
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
        cost=result.cost,
    )


@logged("summary")
async def maybe_generate_summary(current_message_id: int, chat_id: int) -> SummaryInfo:
    """Проверяет, нужно ли генерировать саммари, и генерирует если нужно."""
    info: SummaryInfo = {"attempted": False, "sent": False}
    
    if chat_id in generating_chats:
        info["reason"] = "already_generating"
        return info
    
    if chat_id not in summary_locks:
        summary_locks[chat_id] = asyncio.Lock()
    
    async with summary_locks[chat_id]:
        if chat_id in generating_chats:
            info["reason"] = "already_generating"
            return info
        
        last_summary_id = await get_last_summary_id(chat_id)
        info["last_summary_id"] = last_summary_id
        
        if last_summary_id is None:
            await set_last_summary_id(chat_id, current_message_id)
            info["reason"] = "first_run"
            return info
        
        interval = SUMMARY_INTERVALS[chat_id]
        if current_message_id - last_summary_id < interval:
            info["reason"] = "interval_not_reached"
            info["messages_since_last"] = current_message_id - last_summary_id
            info["interval"] = interval
            return info
        
        generating_chats.add(chat_id)
    
    try:
        info["attempted"] = True
        
        data = await _generate_and_send_summary(chat_id, last_summary_id, current_message_id)
        if data:
            info["sent"] = True
            info["data"] = data
        else:
            info["reason"] = "no_messages"
        
    except Exception as e:
        info["reason"] = "error"
        info["error"] = str(e)
    finally:
        generating_chats.discard(chat_id)
    
    return info


async def _download_file_bytes(file_id: str) -> bytes:
    """Скачивает файл из Telegram и возвращает сырые байты."""
    file = await bot.get_file(file_id)
    buffer = io.BytesIO()
    await bot.download_file(file.file_path, buffer)
    buffer.seek(0)
    return buffer.read()


async def _download_file_base64(file_id: str) -> str:
    """Скачивает файл из Telegram и возвращает base64."""
    raw = await _download_file_bytes(file_id)
    return base64.b64encode(raw).decode('utf-8')


class DescribeInfo(TypedDict):
    description: str
    cost: float | None


@logged
@timed
async def describe_attachment(message: Message, attachment: dict) -> DescribeInfo | None:
    """Получает описание вложения от vision-модели."""
    att_type = attachment["type"]
    
    try:
        if att_type == "photo" and message.photo:
            b64 = await _download_file_base64(message.photo[-1].file_id)
            result = await describe_image(b64)
        
        elif att_type == "sticker" and message.sticker:
            sticker = message.sticker
            cached = await get_sticker(sticker.file_unique_id)
            if cached is not None:
                return {"description": cached, "cost": None}
            # Для анимированных/видео стикеров используем thumbnail
            if sticker.is_animated or sticker.is_video:
                if not sticker.thumbnail:
                    log_warning(f"sticker {sticker.file_unique_id}: нет thumbnail")
                    return None
                file_id = sticker.thumbnail.file_id
            else:
                file_id = sticker.file_id
            b64 = await _download_file_base64(file_id)
            result = await describe_sticker(b64)
            await save_sticker(sticker.file_unique_id, result.text)
        
        elif att_type == "voice" and message.voice:
            raw = await _download_file_bytes(message.voice.file_id)
            result = await describe_voice(raw)
        
        elif att_type == "video_note" and message.video_note:
            b64 = await _download_file_base64(message.video_note.file_id)
            result = await describe_video_note(b64)
        
        else:
            return None
    except Exception as e:
        log_warning(f"describe_{att_type}: {e}")
        return None
    
    return {"description": result.text, "cost": result.cost}


@router.message(F.chat.id.in_(CHAT_IDS))
async def handle_message(message: Message):
    """Обрабатывает все сообщения из отслеживаемых чатов."""
    context: dict = {"timings": {}}
    token = log_context.set(context)
    
    start = time.perf_counter()
    try:
        attachment = get_attachment_info(message)
        raw_message = message.model_dump(
            mode="json", exclude_none=True, exclude_unset=True, exclude_defaults=True,
        )
        context["request_id"] = f"{message.chat.id}:{message.message_id}"
        context["message"] = raw_message
        
        if attachment:
            describe = await describe_attachment(message, attachment)
            if describe:
                attachment.update(describe)
        
        await save_message({
            "chat_id": message.chat.id,
            "message_id": message.message_id,
            "sender_name": get_sender_name(message),
            "text": get_message_text(message),
            "reply_to_message_id": message.reply_to_message.message_id if message.reply_to_message else None,
            "forward_sender_name": get_forward_sender_name(message),
            "raw": raw_message,
            "attachment": attachment,
        })
        
        summary_info = await maybe_generate_summary(message.message_id, message.chat.id)
        if summary_info.get("sent"):
            await save_summary(summary_info["data"])
        
    except Exception as e:
        context["error"] = str(e)
        context["error_traceback"] = traceback.format_exc()
    finally:
        context["timings"]["total"] = round((time.perf_counter() - start) * 1000, 2)
        log_context.reset(token)
        try:
            append_wide_log(context, WIDE_LOG_DIR)
        except Exception as e:
            logger.warning(f"Не удалось записать wide log: {e}")
