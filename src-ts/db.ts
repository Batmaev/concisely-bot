import { Database } from 'bun:sqlite';
import { DB_PATH, DEFAULT_INTERVAL, DEFAULT_TRANSCRIBE, COST_MULTIPLIER, SLIPPAGE } from './config.ts';
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
    CREATE TABLE IF NOT EXISTS chat (
      chat_id INTEGER NOT NULL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      total_cost REAL NOT NULL DEFAULT 0,
      balance REAL NOT NULL DEFAULT 0,
      activated INTEGER NOT NULL DEFAULT 0,
      n_messages INTEGER NOT NULL DEFAULT 0,
      n_summaries INTEGER NOT NULL DEFAULT 0,
      interval INTEGER NOT NULL DEFAULT ${DEFAULT_INTERVAL},
      transcribe INTEGER NOT NULL DEFAULT 1,
      summary_topic_id INTEGER,
      last_summary_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

export interface ChatRow {
  chat_id: number;
  title: string;
  total_cost: number;
  balance: number;
  activated: number;
  n_messages: number;
  n_summaries: number;
  interval: number;
  transcribe: number;
  summary_topic_id: number | null;
  last_summary_id: number | null;
  created_at: string;
}

/** Стоимость к оплате: в БД total_cost сырой, коэффициент применяется на выходе. */
export function chargeableCost(chat: ChatRow): number {
  return chat.total_cost * COST_MULTIPLIER;
}

export function isPaused(chat: ChatRow): boolean {
  if (!chat.activated) return true;
  return chargeableCost(chat) > chat.balance + SLIPPAGE;
}

export function messagesSinceSummary(chat: ChatRow, maxMessageId: number | null): number {
  let n = (chat.last_summary_id !== null && maxMessageId != null)
    ? Math.max(0, maxMessageId - chat.last_summary_id)
    : chat.n_messages;
  if (isPaused(chat)) n = Math.min(n, chat.interval);
  return n;
}

export const getLastSummaryId = timed('get_last_summary_id', async (chatId: number): Promise<number | null> => {
  const row = db.query<{ last_summary_id: number | null }, [number]>(
    'SELECT last_summary_id FROM chat WHERE chat_id = ? LIMIT 1',
  ).get(chatId);
  return row?.last_summary_id ?? null;
});

export const getLastSummary = timed('get_last_summary', async (
  chatId: number,
): Promise<{ from_message_id: number; to_message_id: number } | null> => {
  const row = db.query<{ from_message_id: number; to_message_id: number }, [number]>(
    'SELECT from_message_id, to_message_id FROM summary WHERE chat_id = ? ORDER BY id DESC LIMIT 1',
  ).get(chatId);
  return row ?? null;
});

export const getMaxMessageId = timed('get_max_message_id', async (chatId: number): Promise<number | null> => {
  const row = db.query<{ m: number | null }, [number]>(
    'SELECT MAX(message_id) AS m FROM message WHERE chat_id = ?',
  ).get(chatId);
  return row?.m ?? null;
});

/**
 * Стартовый last_summary_id для первого саммари: такой, чтобы в него (эксклюзивно)
 * попали последние `interval` сохранённых сообщений. Если сообщений меньше `interval` —
 * возвращает точку перед самым старым (включим все накопленные). null — если сообщений нет.
 */
export const getInitialSummaryAnchor = timed('get_initial_summary_anchor', async (
  chatId: number,
  interval: number,
): Promise<number | null> => {
  // (interval+1)-е сообщение с конца: всё, что новее него, — последние `interval`.
  const nth = db.query<{ message_id: number }, [number, number]>(
    'SELECT message_id FROM message WHERE chat_id = ? ORDER BY message_id DESC LIMIT 1 OFFSET ?',
  ).get(chatId, interval);
  if (nth) return nth.message_id;

  // Сообщений меньше interval — точка перед самым старым, чтобы охватить все.
  const min = db.query<{ m: number | null }, [number]>(
    'SELECT MIN(message_id) AS m FROM message WHERE chat_id = ?',
  ).get(chatId);
  return min?.m != null ? min.m - 1 : null;
});

export const setLastSummaryId = timed('set_last_summary_id', async (chatId: number, messageId: number): Promise<void> => {
  db.query(
    'INSERT INTO chat (chat_id, last_summary_id) VALUES (?, ?) ' +
    'ON CONFLICT(chat_id) DO UPDATE SET last_summary_id = excluded.last_summary_id',
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

export interface CleanupResult {
  rows: number;
  /** freelist_count × page_size — всего свободных байт в файле БД */
  bytes_freelist: number;
}

function getFreelistBytes(): number {
  const { page_size } = db.query<{ page_size: number }, []>('PRAGMA page_size').get()!;
  const { freelist_count } = db.query<{ freelist_count: number }, []>('PRAGMA freelist_count').get()!;
  return page_size * freelist_count;
}

export const cleanupOldMessages = timed('cleanup_old_messages', async (
  chatId: number,
  lastSummaryId: number,
  interval: number,
): Promise<CleanupResult> => {
  const empty: CleanupResult = { rows: 0, bytes_freelist: 0 };
  const cutoff = lastSummaryId - 3 * interval;
  if (cutoff <= 0) return empty;

  const result = db.query(
    'DELETE FROM message WHERE chat_id = ? AND message_id < ? AND attachment IS NULL',
  ).run(chatId, cutoff);

  return { rows: result.changes, bytes_freelist: getFreelistBytes() };
});

export const getChat = timed('get_chat', async (chatId: number): Promise<ChatRow | null> => {
  const row = db.query<ChatRow, [number]>('SELECT * FROM chat WHERE chat_id = ? LIMIT 1').get(chatId);
  return row ?? null;
});

export const getAllChats = timed('get_all_chats', async (): Promise<Array<ChatRow & { max_message_id: number | null }>> => {
  return db.query<ChatRow & { max_message_id: number | null }, []>(
    `SELECT c.*, (SELECT MAX(message_id) FROM message m WHERE m.chat_id = c.chat_id) AS max_message_id
     FROM chat c
     ORDER BY (c.balance - c.total_cost * ${COST_MULTIPLIER}) ASC`,
  ).all();
});

export const findChatByCandidates = timed('find_chat_by_candidates', async (ids: number[]): Promise<ChatRow | null> => {
  for (const id of ids) {
    const row = db.query<ChatRow, [number]>('SELECT * FROM chat WHERE chat_id = ? LIMIT 1').get(id);
    if (row) return row;
  }
  return null;
});

/** Возвращает чат, создавая при необходимости. Непустой title синхронизируется с БД. */
export const getChatOrCreate = timed('get_chat_or_create', async (
  chatId: number,
  title?: string,
): Promise<ChatRow> => {
  db.query(
    `INSERT INTO chat (chat_id, title, interval, transcribe) VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title WHERE excluded.title != ''`,
  ).run(chatId, title ?? '', DEFAULT_INTERVAL, DEFAULT_TRANSCRIBE ? 1 : 0);
  const row = db.query<ChatRow, [number]>('SELECT * FROM chat WHERE chat_id = ? LIMIT 1').get(chatId);
  return row!;
});

/** Обновляет настройки из Mini App. summary_topic_id намеренно не трогаем. */
export const upsertChatSettings = timed('upsert_chat_settings', async (
  chatId: number,
  interval: number,
  transcribe: boolean,
): Promise<void> => {
  db.query(
    'UPDATE chat SET interval = ?, transcribe = ? WHERE chat_id = ?',
  ).run(interval, transcribe ? 1 : 0, chatId);
});

export const addBalance = timed('add_balance', async (chatId: number, usd: number): Promise<ChatRow | null> => {
  return db.query<ChatRow, [number, number]>(
    'UPDATE chat SET balance = balance + ?, activated = 1 WHERE chat_id = ? RETURNING *',
  ).get(usd, chatId) ?? null;
});

/** Добавить сырую стоимость (как её вернул OpenRouter) к накопленному total_cost. */
export const addCost = timed('add_cost', async (chatId: number, rawCost: number | null | undefined): Promise<void> => {
  if (!rawCost || rawCost <= 0) return;
  db.query('UPDATE chat SET total_cost = total_cost + ? WHERE chat_id = ?').run(rawCost, chatId);
});

export const incMessageCount = timed('inc_message_count', async (chatId: number): Promise<void> => {
  db.query('UPDATE chat SET n_messages = n_messages + 1 WHERE chat_id = ?').run(chatId);
});

export const incSummaryCount = timed('inc_summary_count', async (chatId: number): Promise<void> => {
  db.query('UPDATE chat SET n_summaries = n_summaries + 1 WHERE chat_id = ?').run(chatId);
});
