/**
 * CLI утилита для тестирования генерации промпта из живой БД.
 *
 * Использование:
 *   bun run src-ts/test-prompt.ts                          # последние 100 сообщений из дефолтного чата
 *   bun run src-ts/test-prompt.ts --limit 50               # последние 50 сообщений
 *   bun run src-ts/test-prompt.ts --from-id 220 --to-id 240
 *   bun run src-ts/test-prompt.ts --output prompt.md
 */
import { parseArgs } from 'util';
import { Database } from 'bun:sqlite';
import { DB_PATH } from './config.ts';
import { generateFullPrompt, type MessageData } from './llm.ts';

const DEFAULT_CHAT_ID = -1001829561306;
const DEFAULT_LIMIT = 100;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'chat-id': { type: 'string', default: String(DEFAULT_CHAT_ID) },
    'from-id': { type: 'string' },
    'to-id':   { type: 'string' },
    'limit':   { type: 'string', short: 'n', default: String(DEFAULT_LIMIT) },
    'output':  { type: 'string', short: 'o' },
  },
});

const chatId = parseInt(values['chat-id']!);
const limit = parseInt(values['limit']!);
const fromId = values['from-id'] ? parseInt(values['from-id']) : undefined;
const toId = values['to-id'] ? parseInt(values['to-id']) : undefined;

const db = new Database(`${DB_PATH}/concisely.db`, { readonly: true });

let messages: MessageData[];
let rangeInfo: string;

if (fromId != null && toId != null) {
  messages = db.query<any, [number, number, number]>(
    'SELECT * FROM message WHERE chat_id = ? AND message_id > ? AND message_id <= ? ORDER BY message_id ASC',
  ).all(chatId, fromId, toId).map(parseRow);
  rangeInfo = `from_id=${fromId}, to_id=${toId}`;
} else {
  messages = db.query<any, [number, number]>(
    'SELECT * FROM message WHERE chat_id = ? ORDER BY message_id DESC LIMIT ?',
  ).all(chatId, limit).reverse().map(parseRow);
  rangeInfo = `последние ${limit}`;
}

if (!messages.length) {
  console.error(`Сообщения не найдены для chat_id=${chatId}, ${rangeInfo}`);
  process.exit(1);
}

console.error(`Найдено ${messages.length} сообщений (chat_id=${chatId})`);

const prompt = generateFullPrompt(messages);

if (values.output) {
  await Bun.write(values.output, prompt);
  console.error(`Промпт записан в ${values.output}`);
} else {
  console.log(prompt);
}

db.close();

function parseRow(r: any): MessageData {
  return {
    ...r,
    attachment: r.attachment ? JSON.parse(r.attachment) : null,
  };
}
