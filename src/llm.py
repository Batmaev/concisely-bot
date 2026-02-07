import random
from dataclasses import dataclass

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


def _indent(text: str) -> str:
    return "\n".join(f"  {line}" for line in text.split("\n"))


def _format_attachment_block(attachment: dict | None, description: str | None = None) -> str | None:
    """Форматирует блок вложения для промпта."""
    if not attachment:
        return None
    
    att_type = attachment.get("type")
    
    if att_type == "photo":
        if description:
            return f"<photo>\n{_indent(description)}\n</photo>"
        return "<photo />"
    
    if att_type == "voice":
        return "<voice />"
    
    if att_type == "video_note":
        if description:
            return f"<video_note>\n{_indent(description)}\n</video_note>"
        return "<video_note />"
    
    if att_type == "video":
        return "<video />"
    
    if att_type == "animation":
        return "<gif />"
    
    if att_type == "sticker":
        if description:
            return f"<sticker>\n{_indent(description)}\n</sticker>"
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


def _get_attachment_description(msg_data: dict) -> str | None:
    """Извлекает описание вложения: новый формат (attachment.description) или legacy-поля."""
    attachment = msg_data.get("attachment")
    if attachment and (desc := attachment.get("description")):
        return desc
    # Фолбек на старый формат
    return (msg_data.get("photo_description")
            or msg_data.get("sticker_description")
            or msg_data.get("video_note_description"))


def format_message_for_prompt(msg_data: dict) -> str:
    """Форматирует сообщение для промпта."""
    msg_id = msg_data["message_id"]
    name = msg_data["sender_name"]
    text = msg_data.get("text", "")
    reply_to = msg_data.get("reply_to_message_id")
    raw = msg_data.get("raw", {})
    attachment = msg_data.get("attachment")
    
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
    
    if text:
        parts.append(_indent(text))
    
    attachment_block = _format_attachment_block(attachment, _get_attachment_description(msg_data))
    if attachment_block:
        parts.append(attachment_block)
    
    return "\n".join(parts)


def generate_full_prompt(messages: list[dict]) -> str:
    """Генерирует полный промпт для LLM из списка сообщений."""
    messages_text = "\n\n".join(format_message_for_prompt(m) for m in messages)
    return f"\n\n<messages>\n{messages_text}\n</messages>"


@dataclass
class DescribeResult:
    text: str
    cost: float | None = None


@dataclass
class SummaryResult:
    text: str
    model: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost: float | None = None


async def generate_summary(messages: list[dict]) -> SummaryResult:
    """Генерирует саммари с помощью OpenRouter."""
    model = random.choice(MODELS)
    user_content = generate_full_prompt(messages)
    
    response = await openai_client.responses.create(
        model=model,
        input=SYSTEM_PROMPT + user_content
    )
    
    result = SummaryResult(text=response.output_text, model=model)
    result.cost = _extract_cost(response)
    
    if usage := getattr(response, 'usage', None):
        result.input_tokens = getattr(usage, 'input_tokens', None)
        result.output_tokens = getattr(usage, 'output_tokens', None)
    
    return result


def get_model_short_name(model: str) -> str:
    """Извлекает короткое имя модели."""
    # 'anthropic/claude-opus-4.5' -> 'claude-opus-4.5'
    return model.split('/')[-1]


def _extract_cost(response) -> float | None:
    if usage := getattr(response, 'usage', None):
        return getattr(usage, 'cost', None)
    return None


async def describe_image(base64_image: str) -> DescribeResult:
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
    return DescribeResult(text=response.output_text, cost=_extract_cost(response))


async def describe_sticker(base64_image: str) -> DescribeResult:
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
    return DescribeResult(text=response.output_text, cost=_extract_cost(response))


async def describe_video_note(base64_video: str) -> DescribeResult:
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
    return DescribeResult(text=response.output_text, cost=_extract_cost(response))
