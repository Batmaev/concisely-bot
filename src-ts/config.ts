import chatsJson from './chats.json';

export const BOT_TOKEN = process.env.BOT_TOKEN!;
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
export const WIDE_LOG_DIR = process.env.WIDE_LOG_DIR ?? 'logs';
export const DB_PATH = process.env.DB_PATH ?? 'data';

export interface ChatConfig {
  interval: number;
  transcribe: boolean;
  /** Топик для саммари в форум-чатах. Не указывать для General (1 передавать нельзя — Bot API вернёт ошибку) */
  summary_topic_id?: number;
}

export const CHATS: Map<number, ChatConfig> = new Map(
  Object.entries(chatsJson).map(([k, v]) => [parseInt(k), v as ChatConfig]),
);
export const CHAT_IDS = new Set(CHATS.keys());

export const MODELS = [
  'anthropic/claude-5-fable',
  'anthropic/claude-opus-4.8',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-sonnet-5',

  'google/gemini-3.1-pro-preview',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3.5-flash',
  'google/gemini-3.5-flash',

  'tencent/hy3-preview',
  'qwen/qwen3.7-max',
  'openai/gpt-5.5',
  'z-ai/glm-5.2',
  'z-ai/glm-5.2',
];

export const IMAGE_MODEL = 'google/gemini-3-flash-preview';
export const VIDEO_MODEL = 'google/gemini-3-flash-preview';
export const VOICE_MODEL = 'google/gemini-3-flash-preview';
