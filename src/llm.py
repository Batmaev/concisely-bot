import random

from openai import AsyncOpenAI

from .config import OPENROUTER_API_KEY, MODELS, SYSTEM_PROMPT, IMAGE_MODEL, VIDEO_MODEL

openai_client = AsyncOpenAI(
    api_key=OPENROUTER_API_KEY,
    base_url="https://openrouter.ai/api/v1",
)


def _get_forward_sender_name(raw: dict) -> str | None:
    """Извлекает имя отправителя оригинального сообщения."""
    # Вариант 1: forward_from (пользователь с открытым профилем)
    if forward_from := raw.get("forward_from"):
        first = forward_from.get("first_name", "")
        last = forward_from.get("last_name", "")
        return f"{first} {last}".strip() or None
    
    # Вариант 2: forward_sender_name (пользователь со скрытым профилем)
    if forward_sender_name := raw.get("forward_sender_name"):
        return forward_sender_name
    
    # Вариант 3: forward_from_chat (форвард из канала)
    if forward_from_chat := raw.get("forward_from_chat"):
        return forward_from_chat.get("title")
    
    return None


def _format_attachment_block(attachment: dict | None, photo_description: str | None, sticker_description: str | None = None, video_note_description: str | None = None) -> str | None:
    """Форматирует блок вложения для промпта."""
    if not attachment:
        return None
    
    att_type = attachment.get("type")
    
    if att_type == "photo":
        if photo_description:
            # Каждая строка описания с отступом в 2 пробела
            indented_desc = "\n".join(f"  {line}" for line in photo_description.split("\n"))
            return f"<photo>\n{indented_desc}\n</photo>"
        return "<photo />"
    
    if att_type == "voice":
        return "<voice />"
    
    if att_type == "video_note":
        if video_note_description:
            indented_desc = "\n".join(f"  {line}" for line in video_note_description.split("\n"))
            return f"<video_note>\n{indented_desc}\n</video_note>"
        return "<video_note />"
    
    if att_type == "video":
        return "<video />"
    
    if att_type == "animation":
        return "<gif />"
    
    if att_type == "sticker":
        if sticker_description:
            indented_desc = "\n".join(f"  {line}" for line in sticker_description.split("\n"))
            return f"<sticker>\n{indented_desc}\n</sticker>"
        emoji = attachment.get("emoji", "")
        if emoji:
            return f"<sticker>{emoji}</sticker>"
        return "<sticker />"
    
    if att_type == "document":
        file_name = attachment.get("file_name", "файл")
        return f"<document>{file_name}</document>"
    
    if att_type == "poll":
        question = attachment.get("question", "")
        options = attachment.get("options", [])
        if options:
            options_str = "\n".join(f"  - {opt}" for opt in options)
            return f"<poll>{question}\n{options_str}\n</poll>"
        return f"<poll>{question}</poll>"
    
    if att_type == "location":
        return "<location />"
    
    if att_type == "new_members":
        names = attachment.get("names", "")
        return f"<new_members>{names}</new_members>"
    
    return None


def format_message_for_prompt(msg_data: dict) -> str:
    """Форматирует сообщение для промпта."""
    msg_id = msg_data["message_id"]
    name = msg_data["sender_name"]
    text = msg_data.get("text", "")
    reply_to = msg_data.get("reply_to_message_id")
    raw = msg_data.get("raw", {})
    attachment = msg_data.get("attachment")
    photo_description = msg_data.get("photo_description")
    sticker_description = msg_data.get("sticker_description")
    video_note_description = msg_data.get("video_note_description")
    
    # Проверяем, есть ли информация о форварде
    forward_name = _get_forward_sender_name(raw) if raw else None
    
    # Формируем метки
    labels = []
    if reply_to:
        labels.append(f"reply to {reply_to}")
    if forward_name:
        labels.append(f"forward from {forward_name}")
    
    labels_str = f" [{', '.join(labels)}]" if labels else ""
    
    # Собираем части сообщения
    parts = [f"### {msg_id} {name}{labels_str}"]
    
    # Блок вложения
    attachment_block = _format_attachment_block(attachment, photo_description, sticker_description, video_note_description)
    if attachment_block:
        parts.append(attachment_block)
    
    # Текст/caption с отступом
    if text:
        indented_text = "\n".join(f"  {line}" for line in text.split("\n"))
        parts.append(indented_text)
    
    return "\n".join(parts)


def generate_full_prompt(messages: list[dict]) -> str:
    """Генерирует полный промпт для LLM из списка сообщений."""
    messages_text = "\n\n".join(format_message_for_prompt(m) for m in messages)
    return f"\n\n<messages>\n{messages_text}\n</messages>"


async def generate_summary(messages: list[dict]) -> tuple[str, str]:
    """Генерирует саммари с помощью OpenRouter."""
    model = random.choice(MODELS)
    user_content = generate_full_prompt(messages)
    
    response = await openai_client.responses.create(
        model=model,
        input=SYSTEM_PROMPT + user_content
    )
    
    return response.output_text, model


def get_model_short_name(model: str) -> str:
    """Извлекает короткое имя модели."""
    # 'anthropic/claude-opus-4.5' -> 'claude-opus-4.5'
    return model.split('/')[-1]


async def describe_image(base64_image: str) -> str:
    """Описывает изображение с помощью vision-модели."""
    response = await openai_client.responses.create(
        model=IMAGE_MODEL,
        input=[{
            'role': 'user',
            'content': [
                {'type': 'input_text', 'text': 'Что изображено на картинке? Кратко'},
                {'type': 'input_image', 'image_url': f'data:image/jpeg;base64,{base64_image}'}
            ]
        }]
    )
    return response.output_text


async def describe_sticker(base64_image: str) -> str:
    """Описывает стикер с помощью vision-модели."""
    response = await openai_client.responses.create(
        model=IMAGE_MODEL,
        input=[{
            'role': 'user',
            'content': [
                {'type': 'input_text', 'text': 'Очень кратко опиши стикер. Если стикер представляет собой скриншот сообщения, ответь в формате "Имя:\\nтекст сообщения"'},
                {'type': 'input_image', 'image_url': f'data:image/jpeg;base64,{base64_image}'}
            ]
        }]
    )
    return response.output_text


async def describe_video_note(base64_video: str) -> str:
    """Описывает видеосообщение с помощью vision-модели."""
    response = await openai_client.responses.create(
        model=VIDEO_MODEL,
        input=[{
            'role': 'user',
            'content': [
                {'type': 'input_text', 'text': 'Что происходит / какие слова говорятся в видеосообщении?'},
                {'type': 'input_video', 'video_url': f'data:video/mp4;base64,{base64_video}'}
            ]
        }]
    )
    return response.output_text
