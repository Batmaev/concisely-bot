import logging
from contextlib import asynccontextmanager

from surrealdb import AsyncSurreal

from .config import (
    SURREALDB_DATABASE,
    SURREALDB_NAMESPACE,
    SURREALDB_PASSWORD,
    SURREALDB_URL,
    SURREALDB_USER,
)

logger = logging.getLogger(__name__)


def _normalize_query_result(result) -> list[dict]:
    """Нормализует ответ SurrealDB query в список записей."""
    if isinstance(result, list) and result:
        first = result[0]
        if isinstance(first, dict) and "result" in first:
            return first["result"] or []
        if isinstance(first, dict):
            return result
    return []


@asynccontextmanager
async def get_db():
    """Контекстный менеджер для работы с SurrealDB."""
    db = AsyncSurreal(SURREALDB_URL)
    try:
        await db.connect()
        await db.signin({'username': SURREALDB_USER, 'password': SURREALDB_PASSWORD})
        await db.use(SURREALDB_NAMESPACE, SURREALDB_DATABASE)
        yield db
    finally:
        await db.close()


async def init_db():
    """Инициализирует структуру БД."""
    async with get_db() as db:
        # Определяем таблицу сообщений
        await db.query("""
            DEFINE TABLE IF NOT EXISTS message SCHEMALESS;
        """)
        
        # Индекс для поиска сообщений по чату и диапазону ID
        await db.query("""
            DEFINE INDEX IF NOT EXISTS chat_message_idx ON TABLE message COLUMNS chat_id, message_id UNIQUE;
        """)
        
        # Определяем таблицу состояния чатов
        await db.query("""
            DEFINE TABLE IF NOT EXISTS chat_state SCHEMALESS;
        """)
        
        # Индекс для быстрого поиска состояния чата
        await db.query("""
            DEFINE INDEX IF NOT EXISTS chat_state_idx ON TABLE chat_state COLUMNS chat_id UNIQUE;
        """)
        
        logger.info("База данных инициализирована")


async def get_last_summary_message_id(chat_id: int) -> int | None:
    """Получает ID последнего саммаризованного сообщения для чата."""
    async with get_db() as db:
        result = await db.query(
            "SELECT last_summary_message_id FROM chat_state WHERE chat_id = $chat_id LIMIT 1",
            {"chat_id": chat_id}
        )
        rows = _normalize_query_result(result)
        if rows and "last_summary_message_id" in rows[0]:
            return rows[0]["last_summary_message_id"]
    return None


async def set_last_summary_message_id(chat_id: int, message_id: int):
    """Устанавливает ID последнего саммаризованного сообщения для чата."""
    async with get_db() as db:
        await db.query(
            "UPSERT chat_state SET chat_id = $chat_id, last_summary_message_id = $message_id WHERE chat_id = $chat_id",
            {"chat_id": chat_id, "message_id": message_id}
        )


async def save_message(chat_id: int, message_id: int, sender_id: int | None, 
                       sender_name: str, text: str, reply_to_message_id: int | None, 
                       timestamp: str | None, raw: dict):
    """Сохраняет сообщение в БД."""
    msg_data = {
        "message_id": message_id,
        "chat_id": chat_id,
        "sender_id": sender_id,
        "sender_name": sender_name,
        "text": text,
        "reply_to_message_id": reply_to_message_id,
        "timestamp": timestamp,
        "raw": raw,
    }
    
    # ID записи включает chat_id для уникальности между чатами
    record_id = f"message:{chat_id}_{message_id}"
    async with get_db() as db:
        await db.create(record_id, msg_data)


async def get_messages_for_summary(chat_id: int, from_id: int, to_id: int) -> list[dict]:
    """Получает сообщения для саммаризации."""
    async with get_db() as db:
        result = await db.query(
            """
            SELECT * FROM message 
            WHERE chat_id = $chat_id AND message_id > $from_id AND message_id <= $to_id
            ORDER BY message_id ASC
            """,
            {"chat_id": chat_id, "from_id": from_id, "to_id": to_id}
        )
        return _normalize_query_result(result)
