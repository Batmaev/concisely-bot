import json
import os
from datetime import datetime, timezone

from aiogram.types import Message
from bs4 import BeautifulSoup


def get_message_text(message: Message) -> str:
    """Извлекает текст/caption из сообщения."""
    if message.text:
        return message.text
    if message.caption:
        return message.caption
    return ""


def get_attachment_info(message: Message) -> dict | None:
    """Возвращает информацию о вложении сообщения.
    
    Returns:
        dict с ключами:
            - type: тип вложения (photo, voice, video_note, sticker, video, document, animation, poll, location)
            - emoji: эмодзи стикера (только для sticker)
            - file_name: имя файла (только для document)
            - question: вопрос опроса (только для poll)
            - options: варианты ответа (только для poll)
        или None если вложения нет
    """
    if message.photo:
        return {"type": "photo"}
    if message.voice:
        return {"type": "voice"}
    if message.video_note:
        return {"type": "video_note", "duration": message.video_note.duration}
    if message.sticker:
        return {
            "type": "sticker",
            "emoji": message.sticker.emoji or "",
            "file_id": message.sticker.file_id,
            "file_unique_id": message.sticker.file_unique_id,
            "is_animated": message.sticker.is_animated,
            "is_video": message.sticker.is_video,
            "thumbnail_file_id": message.sticker.thumbnail.file_id if message.sticker.thumbnail else None,
        }
    if message.video:
        return {"type": "video"}
    if message.animation:
        return {"type": "animation"}
    if message.document:
        return {"type": "document", "file_name": message.document.file_name or "файл"}
    if message.poll:
        options = [opt.text for opt in message.poll.options]
        return {"type": "poll", "question": message.poll.question, "options": options}
    if message.location:
        return {"type": "location"}
    if message.new_chat_members:
        names = ", ".join(m.full_name for m in message.new_chat_members)
        return {"type": "new_members", "names": names}
    return None


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
