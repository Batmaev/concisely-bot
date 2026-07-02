import type { Chat, Message } from 'grammy/types';
import { bot } from './bot.ts';
import { CHATS, CHAT_IDS, BOT_TOKEN, WIDE_LOG_DIR } from './config.ts';
import {
  getLastSummaryId, setLastSummaryId, saveMessage, getMessages,
  getSticker, saveSticker, saveSummary, cleanupOldMessages,
  type SummaryData, type CleanupResult,
} from './db.ts';
import {
  generateSummary, describeImage, describeSticker, describeVoice, describeVideoNote,
  getModelShortName, type MessageData,
} from './llm.ts';
import {
  logStorage, logWarning, timed, logged, timedAndLogged,
  fixHtml, getMessageText, getAttachmentInfo, getSenderName, getForwardSenderName,
  appendWideLog, type LogContext,
} from './utils.ts';

const summaryLocks = new Map<number, Promise<void>>();
const generatingChats = new Set<number>();

async function sendSummary(chatId: number, summary: string, model: string, threadId?: number): Promise<void> {
  const text = fixHtml(summary.slice(0, 3000));
  const modelShort = getModelShortName(model);
  const fullMessage = `#concisely\n${text}\n\n${modelShort}`;

  try {
    await bot.api.sendMessage(chatId, fullMessage, { parse_mode: 'HTML', message_thread_id: threadId });
  } catch (e) {
    logWarning(`html_fallback: ${e}`);
    await bot.api.sendMessage(chatId, fullMessage, { message_thread_id: threadId });
  }
}

async function keepTyping(chatId: number, signal: AbortSignal, threadId?: number): Promise<void> {
  while (!signal.aborted) {
    await bot.api.sendChatAction(chatId, 'typing', { message_thread_id: threadId });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 4000);
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    }).catch(() => {});
    if (signal.aborted) break;
  }
}

const generateAndSendSummary = timed('summary', async (chatId: number, fromId: number, toId: number, threadId?: number): Promise<SummaryData | null> => {
  const messages = await getMessages(chatId, fromId, toId) as MessageData[];
  if (!messages.length) return null;

  const ac = new AbortController();
  const typingLoop = keepTyping(chatId, ac.signal, threadId);
  let result: Awaited<ReturnType<typeof generateSummary>>;
  try {
    result = await generateSummary(messages);
  } finally {
    ac.abort();
    await typingLoop;
  }

  await sendSummary(chatId, result.text, result.model, threadId);
  await setLastSummaryId(chatId, toId);

  return {
    chat_id: chatId,
    from_message_id: fromId,
    to_message_id: toId,
    text: result.text,
    model: result.model,
    input_tokens: result.input_tokens,
    output_tokens: result.output_tokens,
    cost: result.cost,
  };
});

interface SummaryInfo {
  attempted: boolean;
  sent: boolean;
  reason?: string;
  error?: string;
  last_summary_id?: number | null;
  messages_since_last?: number;
  interval?: number;
  data?: SummaryData;
  timing_ms?: number;
  cleanup?: CleanupResult;
}

const maybeGenerateSummary = logged('summary', async (currentMessageId: number, chatId: number, threadId?: number): Promise<SummaryInfo> => {
  const info: SummaryInfo = { attempted: false, sent: false };

  if (generatingChats.has(chatId)) {
    info.reason = 'already_generating';
    return info;
  }

  // Serialize per-chat
  const prevLock = summaryLocks.get(chatId) ?? Promise.resolve();
  let resolveLock!: () => void;
  const lock = new Promise<void>(r => { resolveLock = r; });
  summaryLocks.set(chatId, prevLock.then(() => lock));

  await prevLock;

  if (generatingChats.has(chatId)) {
    resolveLock();
    info.reason = 'already_generating';
    return info;
  }

  const lastSummaryId = await getLastSummaryId(chatId);
  info.last_summary_id = lastSummaryId;

  if (lastSummaryId === null) {
    await setLastSummaryId(chatId, currentMessageId);
    resolveLock();
    info.reason = 'first_run';
    return info;
  }

  const chatConfig = CHATS.get(chatId)!;
  if (currentMessageId - lastSummaryId < chatConfig.interval) {
    resolveLock();
    info.reason = 'interval_not_reached';
    info.messages_since_last = currentMessageId - lastSummaryId;
    info.interval = chatConfig.interval;
    return info;
  }

  generatingChats.add(chatId);
  resolveLock();

  try {
    info.attempted = true;
    const data = await generateAndSendSummary(chatId, lastSummaryId, currentMessageId, threadId);
    if (data) {
      info.sent = true;
      info.data = data;
      info.cleanup = await cleanupOldMessages(chatId, data.to_message_id, chatConfig.interval);
    } else {
      info.reason = 'no_messages';
    }
  } catch (e) {
    info.reason = 'error';
    info.error = String(e);
  } finally {
    generatingChats.delete(chatId);
  }

  return info;
});

async function downloadFileBytes(fileId: string): Promise<Uint8Array> {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  return new Uint8Array(await res.arrayBuffer());
}

async function downloadFileBase64(fileId: string): Promise<string> {
  const bytes = await downloadFileBytes(fileId);
  return Buffer.from(bytes).toString('base64');
}

interface DescribeInfo {
  description: string;
  cost: number | null;
}

const describeAttachment = timedAndLogged('describe_attachment', async (message: Message, attachment: Record<string, unknown>): Promise<DescribeInfo | null> => {
  const attType = attachment.type as string;
  try {
    if (attType === 'photo' && message.photo) {
      const b64 = await downloadFileBase64(message.photo.at(-1)!.file_id);
      const result = await describeImage(b64);
      return { description: result.text, cost: result.cost };
    }

    if (attType === 'sticker' && message.sticker) {
      const sticker = message.sticker;
      const cached = await getSticker(sticker.file_unique_id);
      if (cached !== null) return { description: cached, cost: null };

      const fileId = (sticker.is_animated || sticker.is_video)
        ? sticker.thumbnail?.file_id
        : sticker.file_id;

      if (!fileId) {
        logWarning(`sticker ${sticker.file_unique_id}: нет thumbnail`);
        return null;
      }
      const b64 = await downloadFileBase64(fileId);
      const result = await describeSticker(b64);
      await saveSticker(sticker.file_unique_id, result.text);
      return { description: result.text, cost: result.cost };
    }

    if (attType === 'voice' && message.voice) {
      const raw = await downloadFileBytes(message.voice.file_id);
      const result = await describeVoice(raw);
      return { description: result.text, cost: result.cost };
    }

    if (attType === 'video_note' && message.video_note) {
      const b64 = await downloadFileBase64(message.video_note.file_id);
      const result = await describeVideoNote(b64);
      return { description: result.text, cost: result.cost };
    }
  } catch (e) {
    logWarning(`describe_${attType}: ${e}`);
  }
  return null;
});

function chatShiftId(chatId: number): string {
  return String(chatId).replace('-100', '');
}

function messageLink(chat: Chat, messageId: number, threadId?: number): string {
  const username = chat.type !== 'group' ? chat.username : undefined;
  const base = username ? `https://t.me/${username}` : `https://t.me/c/${chatShiftId(chat.id)}`;
  return threadId ? `${base}/${threadId}/${messageId}` : `${base}/${messageId}`;
}

async function sendTranscription(chat: Chat, messageId: number, text: string, threadId?: number): Promise<void> {
  const link = messageLink(chat, messageId, threadId);
  const html = `<blockquote expandable><a href="${link}">↑</a> ${fixHtml(text)}</blockquote>`;
  try {
    await bot.api.sendMessage(chat.id, html, { parse_mode: 'HTML', message_thread_id: threadId });
  } catch (e) {
    logWarning(`send_transcription: ${e}`);
  }
}

export function registerHandlers(): void {
  bot.on('message', async (ctx) => {
    const message = ctx.message;
    if (!CHAT_IDS.has(message.chat.id)) return;

    const context: LogContext = { timings: {} };
    await logStorage.run(context, async () => {
      const start = performance.now();
      try {
        const attachment = getAttachmentInfo(message);
        context.request_id = `${message.chat.id}:${message.message_id}`;
        context.message = message;

        const chatConfig = CHATS.get(message.chat.id)!;

        if (attachment) {
          const describe = await describeAttachment(message, attachment);
          if (describe) {
            Object.assign(attachment, describe);
            if ((attachment.type === 'voice' || attachment.type === 'video_note') && chatConfig.transcribe) {
              await sendTranscription(message.chat, message.message_id, describe.description, message.message_thread_id);
            }
          }
        }

        const messageData = {
          chat_id: message.chat.id,
          message_id: message.message_id,
          sender_name: getSenderName(message),
          text: getMessageText(message),
          reply_to_message_id: message.reply_to_message?.message_id ?? null,
          forward_sender_name: getForwardSenderName(message),
          raw: message,
          attachment: attachment ?? null,
        };
        await saveMessage(messageData);

        const summaryInfo = await maybeGenerateSummary(message.message_id, message.chat.id, chatConfig.summary_topic_id);
        if (summaryInfo.sent && summaryInfo.data) {
          await saveSummary(summaryInfo.data);
        }
      } catch (e) {
        context.error = String(e);
        context.error_stack = e instanceof Error ? e.stack : undefined;
      } finally {
        context.timings.total = Math.round((performance.now() - start) * 10) / 10;
      }
    });

    appendWideLog(context, WIDE_LOG_DIR);
  });
}
