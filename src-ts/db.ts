import { Database } from 'bun:sqlite';
import { DB_PATH } from './config.ts';
import { timed } from './utils.ts';

let db: Database;

export async function initDb(): Promise<void> {
  db = new Database(`${DB_PATH}/concisely.db`);
  db.run('PRAGMA journal_mode=WAL;');

  db.run(`
    CREATE TABLE IF NOT EXISTS message (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      sender_name TEXT,
      text TEXT,
      reply_to_message_id INTEGER,
      forward_sender_name TEXT,
      raw TEXT,
      attachment TEXT,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS chat_state (
      chat_id INTEGER NOT NULL PRIMARY KEY,
      last_summary_message_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS sticker_cache (
      file_unique_id TEXT NOT NULL PRIMARY KEY,
      description TEXT
    );
    CREATE TABLE IF NOT EXISTS summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      from_message_id INTEGER,
      to_message_id INTEGER,
      text TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost REAL,
      timing_ms REAL,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS summary_chat_idx ON summary (chat_id);
  `);

  console.log('База данных инициализирована');
}

export async function closeDb(): Promise<void> {
  db.close();
  console.log('База данных закрыта');
}

export interface MessageData {
  chat_id: number;
  message_id: number;
  sender_name: string;
  text: string;
  reply_to_message_id: number | null;
  forward_sender_name: string | null;
  raw: unknown;
  attachment: Record<string, unknown> | null;
}

export interface SummaryData {
  chat_id: number;
  from_message_id: number;
  to_message_id: number;
  text: string;
  model: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost?: number | null;
  timing_ms?: number | null;
}

export const getLastSummaryId = timed('get_last_summary_id', async (chatId: number): Promise<number | null> => {
  const row = db.query<{ last_summary_message_id: number }, [number]>(
    'SELECT last_summary_message_id FROM chat_state WHERE chat_id = ? LIMIT 1',
  ).get(chatId);
  return row?.last_summary_message_id ?? null;
});

export const setLastSummaryId = timed('set_last_summary_id', async (chatId: number, messageId: number): Promise<void> => {
  db.query(
    'INSERT INTO chat_state (chat_id, last_summary_message_id) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET last_summary_message_id = excluded.last_summary_message_id',
  ).run(chatId, messageId);
});

export const saveMessage = timed('save_message', async (data: MessageData): Promise<void> => {
  db.query(
    'INSERT OR IGNORE INTO message (chat_id, message_id, sender_name, text, reply_to_message_id, forward_sender_name, raw, attachment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    data.chat_id, data.message_id, data.sender_name, data.text,
    data.reply_to_message_id, data.forward_sender_name,
    JSON.stringify(data.raw), data.attachment ? JSON.stringify(data.attachment) : null,
  );
});

export const getMessages = timed('get_messages', async (chatId: number, fromId: number, toId: number): Promise<MessageData[]> => {
  const rows = db.query<{ chat_id: number; message_id: number; sender_name: string; text: string; reply_to_message_id: number | null; forward_sender_name: string | null; raw: string; attachment: string | null }, [number, number, number]>(
    'SELECT * FROM message WHERE chat_id = ? AND message_id > ? AND message_id <= ? ORDER BY message_id ASC',
  ).all(chatId, fromId, toId);

  return rows.map(r => ({
    ...r,
    raw: JSON.parse(r.raw),
    attachment: r.attachment ? JSON.parse(r.attachment) : null,
  }));
});

export const getSticker = timed('get_sticker', async (fileUniqueId: string): Promise<string | null> => {
  const row = db.query<{ description: string }, [string]>(
    'SELECT description FROM sticker_cache WHERE file_unique_id = ? LIMIT 1',
  ).get(fileUniqueId);
  return row?.description ?? null;
});

export const saveSticker = timed('save_sticker', async (fileUniqueId: string, description: string): Promise<void> => {
  db.query('INSERT OR IGNORE INTO sticker_cache (file_unique_id, description) VALUES (?, ?)').run(fileUniqueId, description);
});

export const saveSummary = timed('save_summary', async (data: SummaryData): Promise<void> => {
  db.query(
    'INSERT INTO summary (chat_id, from_message_id, to_message_id, text, model, input_tokens, output_tokens, cost, timing_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    data.chat_id, data.from_message_id, data.to_message_id, data.text, data.model,
    data.input_tokens ?? null, data.output_tokens ?? null, data.cost ?? null, data.timing_ms ?? null,
    new Date().toISOString(),
  );
});
