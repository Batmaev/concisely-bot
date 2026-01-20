import asyncio
import logging

from aiogram import Dispatcher

from .db import init_db
from .handlers import bot, router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def main():
    """Главная функция запуска бота."""
    logger.info("Запуск бота...")
    
    await init_db()
    
    dp = Dispatcher()
    dp.include_router(router)
    
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
