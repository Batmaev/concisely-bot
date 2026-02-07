import asyncio
import logging
from typing import TypedDict

from surrealdb import AsyncSurreal

from .config import (
    SURREALDB_DATABASE,
    SURREALDB_NAMESPACE,
    SURREALDB_PASSWORD,
    SURREALDB_URL,
    SURREALDB_USER,
)
from .utils import timed

logger = logging.getLogger(__name__)


def _normalize_query_result(result) -> list[dict]:
    """Нормализует ответ SurrealDB query в список записей.
    
    Формат ответа Surreal SDK непоследователен: иногда [{"result": [...]}], иногда просто [...]"""
    if isinstance(result, list) and result:
        first = result[0]
        if isinstance(first, dict) and "result" in first:
            return first["result"] or []
        if isinstance(first, dict):
            return result
    return []


class Database:
    def __init__(self):
        self._client: AsyncSurreal | None = None
        self._lock: asyncio.Lock | None = None

    @property
    def lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def connect(self) -> AsyncSurreal:
        if self._client is None:
            self._client = AsyncSurreal(SURREALDB_URL)
            await self._client.connect()
            await self._client.signin({'username': SURREALDB_USER, 'password': SURREALDB_PASSWORD})
            await self._client.use(SURREALDB_NAMESPACE, SURREALDB_DATABASE)
            logger.info("Установлено соединение с SurrealDB")
        return self._client

    async def close(self):
        if self._client is not None:
            await self._client.close()
            self._client = None
            logger.info("Соединение с SurrealDB закрыто")

    async def query(self, sql: str, params: dict | None = None):
        async with self.lock:
            client = await self.connect()
            return await client.query(sql, params)

    async def fetch(self, sql: str, params: dict | None = None) -> list[dict]:
        """SELECT-запрос с нормализацией результата."""
        result = await self.query(sql, params)
        return _normalize_query_result(result)

    async def create(self, record_id: str, data: dict):
        async with self.lock:
            client = await self.connect()
            return await client.create(record_id, data)


db = Database()


async def init_db():
    """Инициализирует структуру БД."""
    await db.query("DEFINE TABLE IF NOT EXISTS message SCHEMALESS;")
    await db.query("DEFINE INDEX IF NOT EXISTS chat_message_idx ON TABLE message COLUMNS chat_id, message_id UNIQUE;")
    await db.query("DEFINE TABLE IF NOT EXISTS chat_state SCHEMALESS;")
    await db.query("DEFINE INDEX IF NOT EXISTS chat_state_idx ON TABLE chat_state COLUMNS chat_id UNIQUE;")
    await db.query("DEFINE TABLE IF NOT EXISTS sticker_cache SCHEMALESS;")
    await db.query("DEFINE INDEX IF NOT EXISTS sticker_cache_idx ON TABLE sticker_cache COLUMNS file_unique_id UNIQUE;")
    await db.query("DEFINE TABLE IF NOT EXISTS summary SCHEMALESS;")
    await db.query("DEFINE INDEX IF NOT EXISTS summary_chat_idx ON TABLE summary COLUMNS chat_id;")
    logger.info("База данных инициализирована")


@timed
async def get_last_summary_id(chat_id: int) -> int | None:
    """Получает ID последнего саммаризованного сообщения для чата."""
    rows = await db.fetch(
        "SELECT last_summary_message_id FROM chat_state WHERE chat_id = $chat_id LIMIT 1",
        {"chat_id": chat_id}
    )
    if rows and "last_summary_message_id" in rows[0]:
        return rows[0]["last_summary_message_id"]
    return None


@timed
async def set_last_summary_id(chat_id: int, message_id: int):
    """Устанавливает ID последнего саммаризованного сообщения для чата."""
    await db.query(
        "UPSERT chat_state SET chat_id = $chat_id, last_summary_message_id = $message_id WHERE chat_id = $chat_id",
        {"chat_id": chat_id, "message_id": message_id}
    )


class MessageData(TypedDict):
    chat_id: int
    message_id: int
    sender_id: int | None
    sender_name: str
    text: str
    reply_to_message_id: int | None
    timestamp: str | None
    raw: dict
    attachment: dict | None


class SummaryData(TypedDict):
    chat_id: int
    from_message_id: int
    to_message_id: int
    timing_ms: float
    text: str
    model: str
    input_tokens: int | None
    output_tokens: int | None
    cost: float | None


@timed
async def save_message(data: MessageData):
    """Сохраняет сообщение в БД.
    
    Описание вложения берётся из attachment["description"] (если есть).
    Для обратной совместимости дублируется в legacy-поля photo_description и т.д.
    """
    record = dict(data)
    # Временно: дублируем описание в legacy-поля для обратной совместимости
    if attachment := record.get("attachment"):
        if desc := attachment.get("description"):
            legacy_field = {"photo": "photo_description",
                            "sticker": "sticker_description",
                            "video_note": "video_note_description"}.get(attachment["type"])
            if legacy_field:
                record[legacy_field] = desc
    await db.create("message", record)


@timed
async def get_messages(chat_id: int, from_id: int, to_id: int) -> list[dict]:
    """Получает сообщения для саммаризации."""
    return await db.fetch(
        """
        SELECT * FROM message 
        WHERE chat_id = $chat_id AND message_id > $from_id AND message_id <= $to_id
        ORDER BY message_id ASC
        """,
        {"chat_id": chat_id, "from_id": from_id, "to_id": to_id}
    )


@timed
async def get_sticker(file_unique_id: str) -> str | None:
    """Получает описание стикера из кэша."""
    rows = await db.fetch(
        "SELECT description FROM sticker_cache WHERE file_unique_id = $file_unique_id LIMIT 1",
        {"file_unique_id": file_unique_id}
    )
    if rows and "description" in rows[0]:
        return rows[0]["description"]
    return None


@timed
async def save_summary(data: SummaryData):
    """Сохраняет сгенерированное саммари в БД."""
    from datetime import datetime, timezone
    record = {**data, "created_at": datetime.now(timezone.utc).isoformat()}
    await db.create("summary", record)


@timed
async def save_sticker(file_unique_id: str, description: str):
    """Сохраняет описание стикера в кэш."""
    await db.create("sticker_cache", {
        "file_unique_id": file_unique_id,
        "description": description,
    })
