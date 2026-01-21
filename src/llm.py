import random

from openai import AsyncOpenAI

from .config import OPENROUTER_API_KEY, MODELS, SYSTEM_PROMPT

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


def format_message_for_prompt(msg_data: dict) -> str:
    """Форматирует сообщение для промпта."""
    msg_id = msg_data["message_id"]
    name = msg_data["sender_name"]
    text = msg_data["text"]
    reply_to = msg_data.get("reply_to_message_id")
    raw = msg_data.get("raw", {})
    
    # Проверяем, есть ли информация о форварде
    forward_name = _get_forward_sender_name(raw) if raw else None
    
    # Формируем метки
    labels = []
    if reply_to:
        labels.append(f"reply to {reply_to}")
    if forward_name:
        labels.append(f"forward from {forward_name}")
    
    labels_str = f" [{', '.join(labels)}]" if labels else ""
    
    # Добавляем отступ в 2 пробела к каждой строке текста
    indented_text = "\n".join(f"  {line}" for line in text.split("\n"))
    
    return f"### {msg_id} {name}{labels_str}\n{indented_text}"


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
