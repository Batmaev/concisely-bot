import json
import os
from datetime import datetime, timezone

from aiogram.types import Message
from bs4 import BeautifulSoup


def get_message_text(message: Message) -> str:
    """Извлекает текст из сообщения с учетом разных типов."""
    if message.text:
        return message.text
    if message.caption:
        return message.caption
    if message.sticker:
        emoji = message.sticker.emoji or ""
        return f"Sticker [{emoji}]"
    if message.photo:
        return "[Фото]"
    if message.video:
        return "[Видео]"
    if message.voice:
        return "[Голосовое сообщение]"
    if message.video_note:
        return "[Видеосообщение]"
    if message.document:
        return f"[Документ: {message.document.file_name or 'файл'}]"
    if message.animation:
        return "[GIF]"
    if message.poll:
        return f"[Опрос: {message.poll.question}]"
    if message.location:
        return "[Геолокация]"
    if message.new_chat_members:
        return f"[{', '.join(m.full_name for m in message.new_chat_members)}] принят(а) в группу"
    return "[Сообщение без текста]"


def get_sender_name(message: Message) -> str:
    """Получает имя отправителя сообщения."""
    if message.from_user and message.from_user.full_name:
        return message.from_user.full_name
    return "Service"


def fix_html(text: str) -> str:
    """Исправляет незакрытые HTML-теги."""
    # Разрешённые теги в Telegram
    allowed_tags = {'b', 'i', 'a', 'code', 'pre', 's', 'u'}
    
    soup = BeautifulSoup(text, 'html.parser')
    
    # Удаляем запрещённые теги, оставляя их содержимое
    for tag in soup.find_all(True):
        if tag.name not in allowed_tags:
            tag.unwrap()
    
    return str(soup)


def append_wide_log(context: dict, base_dir: str):
    """Добавляет один JSON-лог на запрос."""
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
        handle.write(json.dumps(record, ensure_ascii=False))
        handle.write("\n")
