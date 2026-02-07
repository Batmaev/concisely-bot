#!/usr/bin/env python3
"""CLI утилита для тестирования генерации промпта из живой БД.

Использование:
    uv run -m src.test_prompt                      # последние 100 сообщений из дефолтного чата
    uv run -m src.test_prompt --limit 50           # последние 50 сообщений
    uv run -m src.test_prompt --from-id 220 --to-id 240  # конкретный диапазон
    uv run -m src.test_prompt --output prompt.txt  # вывод в файл
"""

import argparse
import asyncio
import sys

from .config import SYSTEM_PROMPT
from .db import db, get_messages
from .llm import generate_full_prompt

DEFAULT_CHAT_ID = -1001829561306
DEFAULT_LIMIT = 100


async def get_last_messages(chat_id: int, limit: int) -> list[dict]:
    """Получает последние N сообщений из чата."""
    return await db.fetch(
        f"""
        SELECT * FROM message 
        WHERE chat_id = <int> $chat_id
        ORDER BY message_id DESC
        LIMIT {int(limit)}
        """,
        {"chat_id": chat_id}
    )


async def main():
    parser = argparse.ArgumentParser(description="Генерирует промпт из живой БД")
    parser.add_argument("--chat-id", type=int, default=DEFAULT_CHAT_ID, help=f"ID чата (по умолчанию {DEFAULT_CHAT_ID})")
    parser.add_argument("--from-id", type=int, help="ID сообщения с которого начинать (exclusive)")
    parser.add_argument("--to-id", type=int, help="ID сообщения до которого (inclusive)")
    parser.add_argument("--limit", "-n", type=int, default=DEFAULT_LIMIT, help=f"Количество последних сообщений (по умолчанию {DEFAULT_LIMIT})")
    parser.add_argument("--output", "-o", type=str, help="Файл для вывода (по умолчанию stdout)")
    parser.add_argument("--full", action="store_true", help="Включить системный промпт")
    
    args = parser.parse_args()
    
    try:
        # Если указан диапазон - используем его, иначе берём последние N сообщений
        if args.from_id is not None and args.to_id is not None:
            messages = await get_messages(args.chat_id, args.from_id, args.to_id)
            range_info = f"from_id={args.from_id}, to_id={args.to_id}"
        else:
            messages = await get_last_messages(args.chat_id, args.limit)
            # Сортируем обратно в хронологическом порядке
            messages = list(reversed(messages))
            range_info = f"последние {args.limit}"
        
        if not messages:
            print(f"Сообщения не найдены для chat_id={args.chat_id}, {range_info}", file=sys.stderr)
            sys.exit(1)
        
        print(f"Найдено {len(messages)} сообщений (chat_id={args.chat_id})", file=sys.stderr)
        
        prompt = generate_full_prompt(messages)
        
        if args.full:
            prompt = SYSTEM_PROMPT + prompt
        
        if args.output:
            with open(args.output, "w") as f:
                f.write(prompt)
            print(f"Промпт записан в {args.output}", file=sys.stderr)
        else:
            print(prompt)
            
    finally:
        await db.close()


if __name__ == "__main__":
    asyncio.run(main())
