import type { Chat, Message } from 'grammy/types';
import { bot } from './bot.ts';
import { BOT_TOKEN, WIDE_LOG_DIR, OWNER_ID, APP_SHORT_NAME, BOT_USERNAME } from './config.ts';
import {
  getLastSummaryId, getLastSummary, setLastSummaryId, getInitialSummaryAnchor, getMaxMessageId, saveMessage, getMessages,
  getSticker, saveSticker, saveSummary, cleanupOldMessages,
  getChatOrCreate, addCost, addBalance,
  incMessageCount, incSummaryCount, findChatByCandidates, getAllChats, isPaused, messagesSinceSummary, chargeableCost,
  type SummaryData, type CleanupResult, type ChatRow,
} from './db.ts';
import {
  generateSummary, describeImage, describeSticker, describeVoice, describeVideoNote,
  getModelShortName, type MessageData,
} from './llm.ts';
import {
  logStorage, logWarning, timed, logged, timedAndLogged,
  fixHtml, getMessageText, getAttachmentInfo, getSenderName, getForwardSenderName,
  appendWideLog, chatShiftId, chatIdCandidates, usd, payUrl, type LogContext,
} from './utils.ts';
import { parseAmount, convertToUsd, getUsdRubRate } from './currency.ts';

const summaryLocks = new Map<number, Promise<void>>();
const generatingChats = new Set<number>();
// message_id последней чистки для чатов на паузе (троттлинг ~раз в interval).
const pausedCleanupAt = new Map<number, number>();

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
  retry?: boolean;
  reason?: string;
  error?: string;
  last_summary_id?: number | null;
  messages_since_last?: number;
  interval?: number;
  data?: SummaryData;
  timing_ms?: number;
  cleanup?: CleanupResult;
}

const maybeGenerateSummary = logged('summary', async (
  currentMessageId: number,
  chat: ChatRow,
  opts?: { retry?: boolean },
): Promise<SummaryInfo> => {
  const info: SummaryInfo = { attempted: false, sent: false, retry: opts?.retry };
  const chatId = chat.chat_id;

  if (generatingChats.has(chatId)) {
    info.reason = 'already_generating';
    return info;
  }

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

  let lastSummaryId: number | null;

  if (opts?.retry) {
    // Как если бы last_summary_id на мгновение откатился к началу прошлого саммари.
    const prev = await getLastSummary(chatId);
    if (!prev) {
      resolveLock();
      info.reason = 'no_previous_summary';
      return info;
    }
    lastSummaryId = prev.from_message_id;
  } else {
    lastSummaryId = await getLastSummaryId(chatId);

    if (lastSummaryId === null) {
      // Первое саммари (обычно сразу после активации): охватываем последние
      // `interval` накопленных сообщений, в т.ч. пришедшие, пока чат был на паузе.
      const anchor = await getInitialSummaryAnchor(chatId, chat.interval);
      if (anchor === null) {
        resolveLock();
        info.reason = 'no_messages';
        return info;
      }
      lastSummaryId = anchor;
      await setLastSummaryId(chatId, anchor);
    }

    if (currentMessageId - lastSummaryId < chat.interval) {
      resolveLock();
      info.reason = 'interval_not_reached';
      info.messages_since_last = currentMessageId - lastSummaryId;
      info.interval = chat.interval;
      info.last_summary_id = lastSummaryId;
      return info;
    }
  }
  info.last_summary_id = lastSummaryId;

  generatingChats.add(chatId);
  resolveLock();

  try {
    info.attempted = true;
    const data = await generateAndSendSummary(chatId, lastSummaryId, currentMessageId, chat.summary_topic_id ?? undefined);
    if (data) {
      info.sent = true;
      info.data = data;
      await addCost(chatId, data.cost);
      await incSummaryCount(chatId);
      info.cleanup = await cleanupOldMessages(chatId, data.to_message_id, chat.interval);
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

function settingsKeyboard(chatId: number) {
  const url = `https://t.me/${BOT_USERNAME}/${APP_SHORT_NAME}?startapp=${chatId}`;
  return {
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [[
        { text: 'Настройки и статистика', url },
      ]],
    },
  };
}

async function sendOnboarding(chatId: number): Promise<void> {
  try {
    await bot.api.sendMessage(
      chatId,
      'Этот бот умеет писать саммари, а также расшифровывать кружочки и голосовые сообщения. \n\n' +
      `Чтобы начать, <a href="${payUrl(chatId)}">пополните баланс у админа</a>. Типичная стоимость — $0.25 за тысячу сообщений. \n\n` +
      'Настройки и статистика — /settings',
      { parse_mode: 'HTML', ...settingsKeyboard(chatId) },
    );
  } catch (e) {
    console.error(`onboarding_button: ${e}`);
  }
}

export function registerHandlers(): void {
  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    const oldStatus = update.old_chat_member.status;
    const newStatus = update.new_chat_member.status;
    const chat = update.chat;

    // Онбординг только при добавлении в чат: был вне чата → стал участником.
    // Иначе (повышение до админа, смена прав и т.п.) приветствие не шлём.
    const wasOut = oldStatus === 'left' || oldStatus === 'kicked';
    const isIn = newStatus === 'member' || newStatus === 'administrator' || newStatus === 'restricted';
    if (!wasOut || !isIn) return;

    if (chat.type === 'private') return;

    await getChatOrCreate(chat.id, chat.title ?? '');
    await sendOnboarding(chat.id);
  });

  bot.command('settings', async (ctx) => {
    if (ctx.chat.type === 'private') {
      await ctx.reply('Добавьте бота в групповой чат — настройки доступны там.').catch(() => {});
      return;
    }

    const chatId = ctx.chat.id;
    await getChatOrCreate(chatId, ctx.chat.title ?? '');
    try {
      await ctx.reply('Настройки и статистика:', settingsKeyboard(chatId));
    } catch (e) {
      console.error(`settings: ${e}`);
    }
  });

  bot.command('retry', async (ctx) => {
    if (ctx.chat.type === 'private') {
      await ctx.reply('Добавьте бота в групповой чат — команда доступна там.').catch(() => {});
      return;
    }

    const context: LogContext = { timings: {} };
    await logStorage.run(context, async () => {
      const start = performance.now();
      try {
        context.request_id = `${ctx.chat.id}:${ctx.msg.message_id}`;
        context.message = ctx.msg;

        const chat = await getChatOrCreate(ctx.chat.id, ctx.chat.title ?? '');
        if (isPaused(chat)) {
          context.paused = true;
          await ctx.reply('Бот на паузе до оплаты.').catch(() => {});
          return;
        }

        const lastMessageId = await getMaxMessageId(chat.chat_id);
        if (lastMessageId === null) {
          await ctx.reply('Ещё не было саммари — нечего перегенерировать.').catch(() => {});
          return;
        }

        const summaryInfo = await maybeGenerateSummary(lastMessageId, chat, { retry: true });
        if (summaryInfo.sent && summaryInfo.data) {
          await saveSummary(summaryInfo.data);
        } else if (summaryInfo.reason === 'no_previous_summary') {
          await ctx.reply('Ещё не было саммари — нечего перегенерировать.').catch(() => {});
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

  bot.command('add', async (ctx) => {
    if (ctx.from?.id !== OWNER_ID) return;
    if (ctx.chat.type !== 'private') return;

    const args = ctx.msg.text?.split(/\s+/).slice(1) ?? [];
    const chatIdStr = args[0];
    const sumStr = args.slice(1).join(' ').trim();
    if (!chatIdStr || !sumStr) {
      await ctx.reply('Использование: /add {chat_id} {сумма} (напр. /add 1234567890 1000₽)');
      return;
    }

    const candidates = chatIdCandidates(chatIdStr);
    if (!candidates.length) {
      await ctx.reply('Неверный chat_id');
      return;
    }
    // shift-id неоднозначен: берём тот вариант, что уже есть в БД, иначе — наиболее вероятный.
    const existing = await findChatByCandidates(candidates);
    const chatId = existing?.chat_id ?? candidates[0];

    const parsed = parseAmount(sumStr);
    if (!parsed) {
      await ctx.reply('Не удалось распознать сумму. Примеры: 1000₽, 1000, $10, 10 USD');
      return;
    }

    let usdAmount: number;
    try {
      usdAmount = await convertToUsd(parsed.amount, parsed.currency);
    } catch (e) {
      await ctx.reply(`Ошибка получения курса: ${e}`);
      return;
    }
    usdAmount = Math.round(usdAmount * 1e6) / 1e6;

    const before = await getChatOrCreate(chatId);
    const updated = await addBalance(chatId, usdAmount);
    if (!updated) {
      await ctx.reply(`Чат ${chatShiftId(chatId)} не найден и не создан`);
      return;
    }

    const paused = isPaused(updated);
    const rate = parsed.currency === 'RUB' ? await getUsdRubRate().catch(() => null) : null;
    const rateInfo = rate ? ` (курс ${rate.toFixed(2)} ₽/$)` : '';
    await ctx.reply(
      `Чат ${chatShiftId(chatId)} — ${updated.title || 'без названия'}\n` +
      `Сообщений: ${updated.n_messages}\n` +
      `Саммари: ${updated.n_summaries}\n` +
      `Траты за всё время: ${usd(chargeableCost(updated))}\n` +
      `Пополнение: ${parsed.amount} ${parsed.currency} = ${usd(usdAmount)}${rateInfo}\n` +
      `Баланс: ${usd(before.balance)} → ${usd(updated.balance)}\n` +
      `Статус: ${paused ? 'на паузе до оплаты' : 'подключён'}`
    );
  });

  bot.command('stats', async (ctx) => {
    if (ctx.from?.id !== OWNER_ID) return;
    if (ctx.chat.type !== 'private') return;

    const chats = await getAllChats();
    if (!chats.length) {
      await ctx.reply('Чатов нет');
      return;
    }

    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const blocks = chats.map((c) => {
      const cost = chargeableCost(c);
      const left = c.balance - cost;
      const accumulated = messagesSinceSummary(c, c.max_message_id);
      const status = !c.activated ? 'не активирован'
        : isPaused(c) ? 'на паузе'
        : 'работает';
      return (
        `${esc(c.title || 'без названия')} | <code>${chatShiftId(c.chat_id)}</code>\n` +
        `Статус: ${status}\n` +
        `Баланс: ${usd(c.balance)} - ${usd(cost)} = ${usd(left)}\n` +
        `Осталось: ${accumulated} / ${c.interval}\n` +
        `Сообщений: ${c.n_messages}\n` +
        `Саммари: ${c.n_summaries}`
      );
    });

    // Группами по 10, чтобы не упереться в лимит длины сообщения.
    for (let i = 0; i < blocks.length; i += 10) {
      const text = blocks.slice(i, i + 10).join('\n\n');
      try {
        await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      } catch (e) {
        console.error(`stats: ${e}`);
      }
    }
  });

  bot.on('message', async (ctx) => {
    const message = ctx.message;

    if (message.chat.type === 'private') return;

    const context: LogContext = { timings: {} };
    await logStorage.run(context, async () => {
      const start = performance.now();
      try {
        const attachment = getAttachmentInfo(message);
        context.request_id = `${message.chat.id}:${message.message_id}`;
        context.message = message;

        const chat = await getChatOrCreate(message.chat.id, message.chat.title ?? '');
        const paused = isPaused(chat);

        if (attachment && !paused) {
          const describe = await describeAttachment(message, attachment);
          if (describe) {
            Object.assign(attachment, describe);
            await addCost(message.chat.id, describe.cost);
            if ((attachment.type === 'voice' || attachment.type === 'video_note') && chat.transcribe) {
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
        await incMessageCount(message.chat.id);

        if (paused) {
          context.paused = true;
          // Даже на паузе чистим очень старые сообщения (то же правило 3×interval),
          // чтобы БД не разрасталась у неоплаченных чатов. Троттлим ~раз в interval.
          const lastCleanup = pausedCleanupAt.get(message.chat.id) ?? 0;
          if (message.message_id - lastCleanup >= chat.interval) {
            pausedCleanupAt.set(message.chat.id, message.message_id);
            context.cleanup = await cleanupOldMessages(message.chat.id, message.message_id, chat.interval);
          }
          return;
        }

        const summaryInfo = await maybeGenerateSummary(message.message_id, chat);
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
