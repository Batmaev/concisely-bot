import chatsJson from './chats.json';

export const BOT_TOKEN = process.env.BOT_TOKEN!;
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
export const WIDE_LOG_DIR = process.env.WIDE_LOG_DIR ?? 'logs';
export const DB_PATH = process.env.DB_PATH ?? 'data';

export interface ChatConfig {
  interval: number;
  transcribe: boolean;
}

export const CHATS: Map<number, ChatConfig> = new Map(
  Object.entries(chatsJson).map(([k, v]) => [parseInt(k), v as ChatConfig]),
);
export const CHAT_IDS = new Set(CHATS.keys());

export const MODELS = [
  'anthropic/claude-opus-4.6',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-sonnet-4.6',

  'google/gemini-3.1-pro-preview',
  'google/gemini-2.5-pro',
  'google/gemini-3-flash-preview',
];

export const IMAGE_MODEL = 'google/gemini-3-flash-preview';
export const VIDEO_MODEL = 'google/gemini-3-flash-preview';
export const VOICE_MODEL = 'google/gemini-3-flash-preview';
