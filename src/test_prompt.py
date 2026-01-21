#!/usr/bin/env python3
"""CLI утилита для тестирования генерации промпта из живой БД.

Использование:
    uv run -m src.test_prompt --chat-id -1002215041522 --from-id 220 --to-id 240
    uv run -m src.test_prompt --chat-id -1002215041522 --from-id 220 --to-id 240 --output prompt.txt
"""

import argparse
import asyncio
import sys

from .config import SYSTEM_PROMPT
from .db import db, get_messages_for_summary
from .llm import generate_full_prompt


async def main():
    parser = argparse.ArgumentParser(description="Генерирует промпт из живой БД")
    parser.add_argument("--chat-id", type=int, required=True, help="ID чата")
    parser.add_argument("--from-id", type=int, required=True, help="ID сообщения с которого начинать (exclusive)")
    parser.add_argument("--to-id", type=int, required=True, help="ID сообщения до которого (inclusive)")
    parser.add_argument("--output", "-o", type=str, help="Файл для вывода (по умолчанию stdout)")
    parser.add_argument("--full", action="store_true", help="Включить системный промпт")
    
    args = parser.parse_args()
    
    try:
        messages = await get_messages_for_summary(args.chat_id, args.from_id, args.to_id)
        
        if not messages:
            print(f"Сообщения не найдены для chat_id={args.chat_id}, from_id={args.from_id}, to_id={args.to_id}", file=sys.stderr)
            sys.exit(1)
        
        print(f"Найдено {len(messages)} сообщений", file=sys.stderr)
        
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
