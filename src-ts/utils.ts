import { AsyncLocalStorage } from 'async_hooks';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import sanitizeHtml from 'sanitize-html';
import type { Message } from 'grammy/types';

export interface LogContext {
  timings: Record<string, number>;
  [key: string]: unknown;
}

export const logStorage = new AsyncLocalStorage<LogContext>();

export function logWarning(msg: string): void {
  const ctx = logStorage.getStore();
  if (ctx) {
    (ctx.warnings ??= [] as string[]);
    (ctx.warnings as string[]).push(msg);
  }
}

export function timed<Args extends unknown[], R>(
  key: string,
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    const ctx = logStorage.getStore();
    if (!ctx) return fn(...args);

    const start = performance.now();
    try {
      const result = await fn(...args);
      const elapsed = Math.round((performance.now() - start) * 10) / 10;
      ctx.timings[key] = elapsed;
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        (result as Record<string, unknown>).timing_ms = elapsed;
      }
      return result;
    } catch (e) {
      ctx.timings[key] = Math.round((performance.now() - start) * 10) / 10;
      throw e;
    }
  };
}

export function logged<Args extends unknown[], R>(
  key: string,
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    const ctx = logStorage.getStore();
    const result = await fn(...args);
    if (ctx) ctx[key] = result;
    return result;
  };
}

export function timedAndLogged<Args extends unknown[], R>(
  key: string,
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return logged(key, timed(key, fn));
}

export function fixHtml(text: string): string {
  return sanitizeHtml(text, {
    allowedTags: ['b', 'i', 'a', 'code', 'pre', 's', 'u'],
    allowedAttributes: { a: ['href'] },
  });
}

export function getMessageText(message: Message): string {
  return message.text ?? message.caption ?? '';
}

export function getAttachmentInfo(message: Message): Record<string, unknown> | null {
  // Determine content type from which field is set
  let ct: string | null = null;
  if (message.photo) ct = 'photo';
  else if (message.voice) ct = 'voice';
  else if (message.video_note) ct = 'video_note';
  else if (message.sticker) ct = 'sticker';
  else if (message.video) ct = 'video';
  else if (message.animation) ct = 'animation';
  else if (message.document) ct = 'document';
  else if (message.poll) ct = 'poll';
  else if (message.location) ct = 'location';
  else if (message.new_chat_members) ct = 'new_chat_members';

  if (!ct) return null;

  const info: Record<string, unknown> = { type: ct };

  if (ct === 'sticker' && message.sticker) {
    info.emoji = message.sticker.emoji ?? '';
  } else if (ct === 'document' && message.document) {
    info.file_name = message.document.file_name ?? '';
  } else if (ct === 'poll' && message.poll) {
    info.question = message.poll.question;
    info.options = message.poll.options.map(o => o.text);
  } else if (ct === 'new_chat_members' && message.new_chat_members) {
    info.type = 'new_members';
    info.names = message.new_chat_members.map(m => `${m.first_name} ${m.last_name ?? ''}`.trim()).join(', ');
  }

  return info;
}

export function getSenderName(message: Message): string {
  const user = message.from;
  if (user) {
    return `${user.first_name} ${user.last_name ?? ''}`.trim() || 'Unknown';
  }
  return 'Service';
}

export function getForwardSenderName(message: Message): string | null {
  const origin = message.forward_origin;
  if (!origin) return null;
  if (origin.type === 'user') return `${origin.sender_user.first_name} ${origin.sender_user.last_name ?? ''}`.trim();
  if (origin.type === 'hidden_user') return origin.sender_user_name;
  if (origin.type === 'chat') return origin.sender_chat.title ?? null;
  if (origin.type === 'channel') return origin.chat.title ?? null;
  return null;
}

export function appendWideLog(context: LogContext, baseDir: string): void {
  const date = new Date().toISOString().slice(0, 10);
  const filePath = join(baseDir, `${date}.jsonl`);
  const record = { timestamp: new Date().toISOString(), ...context };
  try {
    mkdirSync(baseDir, { recursive: true });
    appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
  } catch (e) {
    console.warn('Не удалось записать wide log:', e);
  }
}
