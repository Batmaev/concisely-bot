import { bot } from './bot.ts';
import { initDb, closeDb } from './db.ts';
import { registerHandlers } from './handlers.ts';

async function main() {
  console.log('Запуск бота...');
  await initDb();
  registerHandlers();

  const stop = async () => {
    await bot.stop();
    await closeDb();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await bot.start();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
