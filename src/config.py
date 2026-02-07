import json
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN = os.environ["BOT_TOKEN"]

OPENROUTER_API_KEY = os.environ["OPENROUTER_API_KEY"]

SURREALDB_URL = os.getenv("SURREALDB_URL", "ws://localhost:8000/rpc")
SURREALDB_USER = os.getenv("SURREALDB_USER", "root")
SURREALDB_PASSWORD = os.getenv("SURREALDB_PASSWORD", "root")
SURREALDB_NAMESPACE = os.getenv("SURREALDB_NAMESPACE", "concisely")
SURREALDB_DATABASE = os.getenv("SURREALDB_DATABASE", "messages")

_chats_path = Path(__file__).resolve().parent / "chats.json"
with open(_chats_path) as f:
    SUMMARY_INTERVALS = {int(k): v or 500 for k, v in json.load(f).items()}

CHAT_IDS = frozenset(SUMMARY_INTERVALS)

WIDE_LOG_DIR = "logs"

# Модели с весами
MODELS = [
    'anthropic/claude-opus-4.6',
    'anthropic/claude-opus-4.5',
    'anthropic/claude-sonnet-4.5',

    'google/gemini-3-pro-preview',
    'google/gemini-2.5-pro',
    'google/gemini-3-flash-preview',
]

IMAGE_MODEL = 'google/gemini-3-flash-preview'

VIDEO_MODEL = 'google/gemini-3-flash-preview'

VOICE_MODEL = 'google/gemini-3-flash-preview'

SYSTEM_PROMPT = """Ты — бот-саммаризатор сообщений в Telegram.

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
