import os

from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN = os.environ["BOT_TOKEN"]

OPENROUTER_API_KEY = os.environ["OPENROUTER_API_KEY"]

SURREALDB_URL = os.getenv("SURREALDB_URL", "ws://localhost:8000/rpc")
SURREALDB_USER = os.getenv("SURREALDB_USER", "root")
SURREALDB_PASSWORD = os.getenv("SURREALDB_PASSWORD", "root")
SURREALDB_NAMESPACE = os.getenv("SURREALDB_NAMESPACE", "concisely")
SURREALDB_DATABASE = os.getenv("SURREALDB_DATABASE", "messages")

SUMMARY_INTERVAL = int(os.getenv("SUMMARY_INTERVAL", "7"))
SUMMARY_INTERVALS = {
    -1001829561306: 500,
    -1002215041522: 7,
}
CHAT_IDS = sorted(SUMMARY_INTERVALS.keys())
WIDE_LOG_DIR = os.getenv("WIDE_LOG_DIR", "logs")

# Модели с весами (4/9 для Opus, 1/9 для остальных)
MODELS = [
    'anthropic/claude-opus-4.5',
    'anthropic/claude-opus-4.5',
    'anthropic/claude-opus-4.5',
    'anthropic/claude-opus-4.5',
    'anthropic/claude-sonnet-4.5',
    'google/gemini-2.5-pro',
    'google/gemini-3-pro-preview',
    'openai/gpt-5.2',
    'x-ai/grok-4.1-fast',
]

IMAGE_MODEL = 'google/gemini-3-flash-preview'

VIDEO_MODEL = 'google/gemini-3-flash-preview'

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
