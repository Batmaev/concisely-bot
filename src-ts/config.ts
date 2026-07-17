export const BOT_TOKEN = process.env.BOT_TOKEN!;
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
export const WIDE_LOG_DIR = process.env.WIDE_LOG_DIR ?? 'logs';
export const DB_PATH = process.env.DB_PATH ?? 'data';

export const OWNER_ID = Number(process.env.OWNER_ID ?? 0);

export const WEBAPP_URL = process.env.WEBAPP_URL ?? 'https://concisely.slay.place';
export const WEBAPP_PORT = Number(process.env.WEBAPP_PORT ?? 3000);

/** Short name Mini App в BotFather (создаётся через /newapp). Используется для direct-link. */
export const APP_SHORT_NAME = process.env.APP_SHORT_NAME ?? 'app';

/** Username бота (без @). Для direct-link на Mini App, чтобы не дёргать getMe. */
export const BOT_USERNAME = process.env.BOT_USERNAME ?? 'ConciselyBot';

/** Username админа (без @), которому пишут для пополнения баланса. */
export const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? 'batmaev';

/** Допустимое превышение cost над balance до того, как бот встанет на паузу (USD). */
export const SLIPPAGE = Number(process.env.SLIPPAGE ?? 50);

export const DEFAULT_INTERVAL = Number(process.env.DEFAULT_INTERVAL ?? 400);
export const DEFAULT_TRANSCRIBE = (process.env.DEFAULT_TRANSCRIBE ?? 'true') !== 'false';

/** Множитель стоимости: 5% комиссия OpenRouter + потери на конвертации. */
export const COST_MULTIPLIER = 1.05;

export const CBR_URL = process.env.CBR_URL ?? 'https://www.cbr-xml-daily.ru/daily_json.js';

export const MODELS = [
  'anthropic/claude-opus-5.5',
  'anthropic/claude-opus-5.5',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-opus-4.6',

  'google/gemini-3.1-pro-preview',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3.8-flash',
  'google/gemini-3.8-flash',

  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-luna',
  'openai/gpt-6.1-sol',

  'tencent/hy3-preview',
  'qwen/qwen3.7-max',
  'z-ai/glm-5.2',
  'moonshotai/kimi-k3',
];

export const IMAGE_MODEL = 'google/gemini-3-flash-preview';
export const VIDEO_MODEL = 'google/gemini-3.8-flash';
export const VOICE_MODEL = 'google/gemini-3-flash-preview';
