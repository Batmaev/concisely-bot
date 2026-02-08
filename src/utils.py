import contextvars
import functools
import json
import os
import time
from datetime import datetime, timezone

from aiogram.types import Message
from bs4 import BeautifulSoup

log_context: contextvars.ContextVar[dict | None] = contextvars.ContextVar('log_context', default=None)


def log_warning(msg: str):
    """Добавляет предупреждение в текущий лог-контекст (попадёт в wide log)."""
    ctx = log_context.get()
    if ctx is not None:
        ctx.setdefault("warnings", []).append(msg)


def timed(fn_or_key=None):
    """Декоратор: замеряет время async-функции → timings[key] в лог-контексте.

    Использование:
        @timed              — ключ = имя функции
        @timed("my_key")    — ключ задан явно
    """
    def _wrap(fn, key):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            ctx = log_context.get()
            if ctx is None:
                return await fn(*args, **kwargs)

            timings = ctx.setdefault("timings", {})
            start = time.perf_counter()
            try:
                result = await fn(*args, **kwargs)
            finally:
                elapsed = round((time.perf_counter() - start) * 1000, 2)
                timings[key] = elapsed
            if isinstance(result, dict):
                result["timing_ms"] = elapsed
            return result
        return wrapper

    if callable(fn_or_key):
        return _wrap(fn_or_key, fn_or_key.__name__)

    def decorator(fn):
        return _wrap(fn, fn_or_key or fn.__name__)
    return decorator


def logged(fn_or_key=None):
    """Декоратор: сохраняет dict-результат async-функции в context[key].

    Использование:
        @logged              — ключ = имя функции
        @logged("my_key")    — ключ задан явно
    """
    def _wrap(fn, key):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            ctx = log_context.get()
            if ctx is None:
                return await fn(*args, **kwargs)

            result = await fn(*args, **kwargs)

            if isinstance(result, dict):
                ctx[key] = result

            return result
        return wrapper

    if callable(fn_or_key):
        return _wrap(fn_or_key, fn_or_key.__name__)

    def decorator(fn):
        return _wrap(fn, fn_or_key or fn.__name__)
    return decorator


def get_message_text(message: Message) -> str:
    if message.text:
        return message.text
    if message.caption:
        return message.caption
    return ""


_ATTACHMENT_TYPES = {
    "photo", "voice", "video_note", "sticker", "video",
    "animation", "document", "poll", "location", "new_chat_members",
}


def get_attachment_info(message: Message) -> dict | None:
    ct = message.content_type
    if ct not in _ATTACHMENT_TYPES:
        return None

    info: dict = {"type": ct}

    if ct == "sticker" and message.sticker:
        info["emoji"] = message.sticker.emoji or ""
    elif ct == "document" and message.document:
        info["file_name"] = message.document.file_name or ""
    elif ct == "poll" and message.poll:
        info["question"] = message.poll.question
        info["options"] = [opt.text for opt in message.poll.options]
    elif ct == "new_chat_members" and message.new_chat_members:
        info["type"] = "new_members"
        info["names"] = ", ".join(m.full_name for m in message.new_chat_members)

    return info


def get_sender_name(message: Message) -> str:
    if message.from_user and message.from_user.full_name:
        return message.from_user.full_name
    return "Service"


def get_forward_sender_name(message: Message) -> str | None:
    if message.forward_from:
        return message.forward_from.full_name or None
    if message.forward_sender_name:
        return message.forward_sender_name
    if message.forward_from_chat:
        return message.forward_from_chat.title
    return None


def fix_html(text: str) -> str:
    """Фиксит незакрытые теги и удаляет неподдерживаемые Telegram'ом."""
    allowed_tags = {'b', 'i', 'a', 'code', 'pre', 's', 'u'}
    
    soup = BeautifulSoup(text, 'html.parser')
    
    for tag in soup.find_all(True):
        if tag.name not in allowed_tags:
            tag.unwrap()
    
    return str(soup)


def _json_default(obj):
    from dataclasses import asdict
    if hasattr(obj, '__dataclass_fields__'):
        return asdict(obj)
    return repr(obj)


def append_wide_log(context: dict, base_dir: str):
    file_name = f"{datetime.now().date().isoformat()}.jsonl"
    path = os.path.join(base_dir, file_name)
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **context,
    }
    dir_name = os.path.dirname(path)
    if dir_name:
        os.makedirs(dir_name, exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, default=_json_default))
        handle.write("\n")
