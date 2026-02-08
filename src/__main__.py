import asyncio
import logging

from aiogram import Dispatcher

from .db import db, init_db
from .handlers import bot, router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def main():
    logger.info("Запуск бота...")
    
    await init_db()
    
    dp = Dispatcher()
    dp.include_router(router)
    
    try:
        await dp.start_polling(bot)
    finally:
        await db.close()


if __name__ == "__main__":
    asyncio.run(main())
