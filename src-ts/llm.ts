import OpenAI from 'openai';
import { OPENROUTER_API_KEY, MODELS, IMAGE_MODEL, VIDEO_MODEL, VOICE_MODEL } from './config.ts';
import { logWarning, timed } from './utils.ts';

const CONTENT_FILTER_MESSAGE = '[тема слишком опасна]';

const SUMMARIZATION_PROMPT = `Ты — бот-саммаризатор сообщений в Telegram.

Сообщения поступают в формате:
\`\`\`
### ID Name
  text
\`\`\`

Перескажи самые интересные / смешные моменты.

Требования:
0. Язык ответа — русский
1. Длина — приблизительно до 1200 символов
2. Пиши только сам пересказ! Без фразы "Вот основные моменты", без заголовка "Пересказ", без рассуждений о чате в целом.
3. Для форматирования используй html (не markdown).
4. Используй только теги, поддерживаемые Telegram:
   - <b>текст</b> (жирный)
   - <i>текст</i> (курсив)`;

const openai = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

function indent(text: string): string {
  return text.split('\n').map(l => `  ${l}`).join('\n');
}

function formatAttachmentBlock(attachment: Record<string, unknown> | null | undefined, description?: string | null): string | null {
  if (!attachment) return null;
  const type = attachment.type as string;

  if (type === 'photo') return description ? `<photo>\n${indent(description)}\n</photo>` : '<photo />';
  if (type === 'voice') return description ? `<voice>\n${indent(description)}\n</voice>` : '<voice />';
  if (type === 'video_note') return description ? `<video_note>\n${indent(description)}\n</video_note>` : '<video_note />';
  if (type === 'video') return '<video />';
  if (type === 'animation') return '<gif />';
  if (type === 'sticker') {
    if (description) return `<sticker>\n${indent(description)}\n</sticker>`;
    const emoji = attachment.emoji as string | undefined;
    return emoji ? `<sticker>${emoji}</sticker>` : '<sticker />';
  }
  if (type === 'document') return `<document>${attachment.file_name ?? 'файл'}</document>`;
  if (type === 'poll') {
    const question = attachment.question as string ?? '';
    const options = attachment.options as string[] ?? [];
    if (options.length) return `<poll>${question}\n${options.map(o => `  - ${o}`).join('\n')}\n</poll>`;
    return `<poll>${question}</poll>`;
  }
  if (type === 'location') return '<location />';
  if (type === 'new_members') return `<new_members>${attachment.names ?? ''}</new_members>`;
  return null;
}

export interface MessageData {
  message_id: number;
  sender_name: string;
  text?: string;
  reply_to_message_id?: number | null;
  forward_sender_name?: string | null;
  attachment?: Record<string, unknown> | null;
}

export function formatMessageForPrompt(msg: MessageData): string {
  const labels: string[] = [];
  if (msg.reply_to_message_id) labels.push(`reply to ${msg.reply_to_message_id}`);
  if (msg.forward_sender_name) labels.push(`forward from ${msg.forward_sender_name}`);

  const labelsStr = labels.length ? ` [${labels.join(', ')}]` : '';
  const parts = [`### ${msg.message_id} ${msg.sender_name}${labelsStr}`];

  if (msg.text) parts.push(indent(msg.text));

  const description = (msg.attachment as Record<string, unknown> | null | undefined)?.description as string | null | undefined;
  const block = formatAttachmentBlock(msg.attachment, description);
  if (block) parts.push(block);

  return parts.join('\n');
}

export function generateFullPrompt(messages: MessageData[]): string {
  const messagesText = messages.map(formatMessageForPrompt).join('\n\n');
  return `${SUMMARIZATION_PROMPT}\n\n<messages>\n${messagesText}\n</messages>`;
}

export interface SummaryResult {
  text: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number | null;
}

function extractCost(response: { usage?: unknown }): number | null {
  return (response.usage as Record<string, unknown> | null | undefined)?.cost as number ?? null;
}

export async function generateSummary(messages: MessageData[]): Promise<SummaryResult> {
  const model = MODELS[Math.floor(Math.random() * MODELS.length)];
  const prompt = generateFullPrompt(messages);

  const response = await openai.responses.create({ model, input: prompt });

  if (response.incomplete_details?.reason === 'content_filter') {
    throw new Error(`content_filter: ${model}`);
  }

  return {
    text: response.output_text,
    model,
    input_tokens: response.usage?.input_tokens ?? null,
    output_tokens: response.usage?.output_tokens ?? null,
    cost: extractCost(response),
  };
}

export interface DescribeResult {
  text: string;
  cost: number | null;
}

async function callMultimodal(model: string, prompt: string, mediaContent: unknown): Promise<DescribeResult> {
  const response = await openai.responses.create({
    model,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: prompt },
        mediaContent,
      ],
    }] as Parameters<typeof openai.responses.create>[0]['input'],
  });
  if (response.incomplete_details?.reason === 'content_filter') {
    logWarning(`content_filter: ${model}`);
    return { text: CONTENT_FILTER_MESSAGE, cost: extractCost(response) };
  }
  return { text: response.output_text, cost: extractCost(response) };
}

export function describeImage(base64Image: string): Promise<DescribeResult> {
  return callMultimodal(IMAGE_MODEL, 'Что изображено на картинке? Кратко',
    { type: 'input_image', image_url: `data:image/jpeg;base64,${base64Image}` });
}

export function describeSticker(base64Image: string): Promise<DescribeResult> {
  return callMultimodal(IMAGE_MODEL,
    'Очень кратко опиши стикер. Если стикер представляет собой скриншот сообщения, ответь в формате "Имя:\\nтекст сообщения"',
    { type: 'input_image', image_url: `data:image/jpeg;base64,${base64Image}` });
}

export function describeVideoNote(base64Video: string): Promise<DescribeResult> {
  return callMultimodal(VIDEO_MODEL, 'Что происходит / какие слова говорятся в видеосообщении (если говорятся)?',
    { type: 'input_video', video_url: `data:video/mp4;base64,${base64Video}` });
}

export const convertOggToMp3 = timed('convert_ogg_to_mp3', async (audioBytes: Uint8Array): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const ffmpeg = spawn('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-f', 'mp3', 'pipe:1']);
    const chunks: Buffer[] = [];
    ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (data: Buffer) => {
      // Collected if needed
    });
    ffmpeg.on('close', (code: number) => {
      if (code !== 0) reject(new Error(`ffmpeg exited with code ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    ffmpeg.on('error', reject);
    ffmpeg.stdin.write(audioBytes);
    ffmpeg.stdin.end();
  });
});

export async function describeVoice(audioBytes: Uint8Array): Promise<DescribeResult> {
  const mp3 = await convertOggToMp3(audioBytes);
  const base64Audio = mp3.toString('base64');
  return callMultimodal(VOICE_MODEL,
    'Расшифруй это голосовое сообщение. Выведи только текст.',
    { type: 'input_audio', input_audio: { data: base64Audio, format: 'mp3' } });
}

const OBVIOUS_PROVIDERS = new Set(['google', 'anthropic', 'deepseek', 'qwen', 'x-ai']);

export function getModelShortName(model: string): string {
  const [provider, modelShort] = model.split('/');
  if (modelShort && OBVIOUS_PROVIDERS.has(provider)) return modelShort;
  return model;
}
