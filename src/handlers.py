import asyncio
import logging
import time

from aiogram import Bot, F, Router
from aiogram.types import Message
from aiogram.enums import ParseMode

from .config import BOT_TOKEN, CHAT_IDS, SUMMARY_INTERVAL, SUMMARY_INTERVALS, WIDE_LOG_DIR
from .db import (
    get_last_summary_message_id,
    get_messages_for_summary,
    save_message,
    set_last_summary_message_id,
)
from .llm import generate_summary, get_model_short_name
from .utils import append_wide_log, fix_html, get_message_text, get_sender_name

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
        
        summary, model = await generate_summary(messages)
        await send_summary(chat_id, summary, model)
        summary_info["model"] = model
        summary_info["summary_chars"] = len(summary)
        
        await set_last_summary_message_id(chat_id, current_message_id)
        summary_info["new_last_summary_id"] = current_message_id
        summary_info["sent"] = True
        
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


@router.message(F.chat.id.in_(CHAT_IDS))
async def handle_message(message: Message):
    """Обрабатывает все сообщения из отслеживаемых чатов."""
    start_time = time.perf_counter()
    
    message_text = get_message_text(message)
    sender_name = get_sender_name(message)
    raw_message = message.model_dump(mode="json", exclude_none=True)
    
    context: dict = {
        "request_id": f"{message.chat.id}:{message.message_id}",
        "message": raw_message,
        "timings_ms": {},
    }
    try:
        save_start = time.perf_counter()
        await save_message(
            chat_id=message.chat.id,
            message_id=message.message_id,
            sender_id=message.from_user.id if message.from_user else None,
            sender_name=sender_name,
            text=message_text,
            reply_to_message_id=message.reply_to_message.message_id if message.reply_to_message else None,
            timestamp=message.date.isoformat() if message.date else None,
            raw=raw_message,
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
