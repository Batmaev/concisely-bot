import asyncio
import base64
import random
from dataclasses import dataclass

from openai import AsyncOpenAI

from .config import OPENROUTER_API_KEY, MODELS, IMAGE_MODEL, VIDEO_MODEL, VOICE_MODEL
from .utils import timed

SUMMARIZATION_PROMPT = """Ты — бот-саммаризатор сообщений в Telegram.

Сообщения поступают в формате:
```
### ID Name
  text
```

Перескажи самые интересные / смешные моменты. 

Требования:
0. Язык ответа — русский
1. Длина — приблизительно до 1200 символов
2. Пиши только сам пересказ! Без фразы "Вот основные моменты", без заголовка "Пересказ", без рассуждений о чате в целом.
3. Для форматирования используй html (не markdown).
4. Используй только теги, поддерживаемые Telegram:
   - <b>текст</b> (жирный)
   - <i>текст</i> (курсив)
   - <a href="URL">текст</a> (ссылки)
5. Вместо списков (<ul>) используй символы-буллеты (• или -) и обычный перенос строки (\\n).
6. Обязательно закрывай все теги."""

openai_client = AsyncOpenAI(
    api_key=OPENROUTER_API_KEY,
    base_url="https://openrouter.ai/api/v1",
)


def _indent(text: str) -> str:
    return "\n".join(f"  {line}" for line in text.split("\n"))


def _format_attachment_block(attachment: dict | None, description: str | None = None) -> str | None:
    if not attachment:
        return None
    
    att_type = attachment.get("type")
    
    if att_type == "photo":
        if description:
            return f"<photo>\n{_indent(description)}\n</photo>"
        return "<photo />"
    
    if att_type == "voice":
        if description:
            return f"<voice>\n{_indent(description)}\n</voice>"
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
    attachment = msg_data.get("attachment")
    if attachment:
        return attachment.get("description")
    return None


def format_message_for_prompt(msg_data: dict) -> str:
    msg_id = msg_data["message_id"]
    name = msg_data["sender_name"]
    text = msg_data.get("text", "")
    reply_to = msg_data.get("reply_to_message_id")
    attachment = msg_data.get("attachment")
    forward_name = msg_data.get("forward_sender_name")
    
    labels = []
    if reply_to:
        labels.append(f"reply to {reply_to}")
    if forward_name:
        labels.append(f"forward from {forward_name}")
    
    labels_str = f" [{', '.join(labels)}]" if labels else ""
    
    parts = [f"### {msg_id} {name}{labels_str}"]
    
    if text:
        parts.append(_indent(text))
    
    attachment_block = _format_attachment_block(attachment, _get_attachment_description(msg_data))
    if attachment_block:
        parts.append(attachment_block)
    
    return "\n".join(parts)


def generate_full_prompt(messages: list[dict]) -> str:
    messages_text = "\n\n".join(format_message_for_prompt(m) for m in messages)
    return SUMMARIZATION_PROMPT + f"\n\n<messages>\n{messages_text}\n</messages>"


@dataclass
class SummaryResult:
    text: str
    model: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost: float | None = None


async def generate_summary(messages: list[dict]) -> SummaryResult:
    model = random.choice(MODELS)
    prompt = generate_full_prompt(messages)
    
    response = await openai_client.responses.create(
        model=model,
        input=prompt
    )
    
    result = SummaryResult(text=response.output_text, model=model)
    result.cost = extract_cost(response)
    
    if usage := getattr(response, 'usage', None):
        result.input_tokens = getattr(usage, 'input_tokens', None)
        result.output_tokens = getattr(usage, 'output_tokens', None)
    
    return result


@dataclass
class DescribeResult:
    text: str
    cost: float | None = None


def get_model_short_name(model: str) -> str:
    # 'anthropic/claude-opus-4.5' -> 'claude-opus-4.5'
    return model.split('/')[-1]


def extract_cost(response) -> float | None:
    if usage := getattr(response, 'usage', None):
        return getattr(usage, 'cost', None)
    return None


async def call_multimodal(model: str, prompt: str, media_content: dict) -> DescribeResult:
    response = await openai_client.responses.create(
        model=model,
        input=[{
            'role': 'user',
            'content': [
                {'type': 'input_text', 'text': prompt},
                media_content,
            ]
        }]
    )
    return DescribeResult(text=response.output_text, cost=extract_cost(response))


async def describe_image(base64_image: str) -> DescribeResult:
    return await call_multimodal(IMAGE_MODEL, 'Что изображено на картинке? Кратко',
        {'type': 'input_image', 'image_url': f'data:image/jpeg;base64,{base64_image}'})


async def describe_sticker(base64_image: str) -> DescribeResult:
    return await call_multimodal(IMAGE_MODEL,
        'Очень кратко опиши стикер. Если стикер представляет собой скриншот сообщения, ответь в формате "Имя:\\nтекст сообщения"',
        {'type': 'input_image', 'image_url': f'data:image/jpeg;base64,{base64_image}'})


async def describe_video_note(base64_video: str) -> DescribeResult:
    return await call_multimodal(VIDEO_MODEL, 'Что происходит / какие слова говорятся в видеосообщении?',
        {'type': 'input_video', 'video_url': f'data:video/mp4;base64,{base64_video}'})


@timed
async def convert_ogg_to_mp3(audio_bytes: bytes) -> bytes:
    proc = await asyncio.create_subprocess_exec(
        'ffmpeg', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'mp3', 'pipe:1',
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate(audio_bytes)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg error: {stderr.decode()}")
    return stdout


async def describe_voice(audio_bytes: bytes) -> DescribeResult:
    """Конвертирует ogg в mp3 — Responses API не принимает ogg."""
    mp3_bytes = await convert_ogg_to_mp3(audio_bytes)
    base64_audio = base64.b64encode(mp3_bytes).decode()

    return await call_multimodal(
        VOICE_MODEL,
        'Расшифруй это голосовое сообщение. Выведи только текст.',
        {'type': 'input_audio', 'input_audio': {'data': base64_audio, 'format': 'mp3'}},
    )


