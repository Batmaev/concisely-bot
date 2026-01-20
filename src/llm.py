import random

from openai import AsyncOpenAI

from .config import OPENROUTER_API_KEY, MODELS, SYSTEM_PROMPT

openai_client = AsyncOpenAI(
    api_key=OPENROUTER_API_KEY,
    base_url="https://openrouter.ai/api/v1",
)


def format_message_for_prompt(msg_data: dict) -> str:
    """Форматирует сообщение для промпта."""
    msg_id = msg_data["message_id"]
    name = msg_data["sender_name"]
    text = msg_data["text"]
    reply_to = msg_data.get("reply_to_message_id")
    
    # Добавляем отступ в 2 пробела к каждой строке текста
    indented_text = "\n".join(f"  {line}" for line in text.split("\n"))
    
    if reply_to:
        return f"### {msg_id} {name} [reply to {reply_to}]\n{indented_text}"
    return f"### {msg_id} {name}\n{indented_text}"


async def generate_summary(messages: list[dict]) -> tuple[str, str]:
    """Генерирует саммари с помощью OpenRouter."""
    model = random.choice(MODELS)
    
    # Формируем текст сообщений
    messages_text = "\n\n".join(format_message_for_prompt(m) for m in messages)
    user_content = f"\n\n<messages>\n{messages_text}\n</messages>"
    
    response = await openai_client.responses.create(
        model=model,
        input=SYSTEM_PROMPT + user_content
    )
    
    return response.output_text, model


def get_model_short_name(model: str) -> str:
    """Извлекает короткое имя модели."""
    # 'anthropic/claude-opus-4.5' -> 'claude-opus-4.5'
    return model.split('/')[-1]
