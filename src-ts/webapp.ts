/**
 * Telegram Mini App: статус, статистика и настройки чата.
 * Запускается в том же процессе, что и бот (Bun.serve).
 *
 * Mini App открывается по direct-link `https://t.me/<bot>/<app>?startapp=<chat_id>`
 * (url-кнопка работает в группах, в отличие от web_app-кнопки).
 * chat_id берётся из start_param — он входит в initData и покрывается подписью,
 * поэтому отдельный параметр chat_id от клиента не принимаем.
 * Безопасность: подпись initData (timing-safe) + TTL по auth_date;
 * редактировать настройки может только админ чата (getChatMember).
 *
 * Маршруты:
 *   GET  /            — одностраничный HTML (Telegram WebApp SDK)
 *   GET  /api/chat    — статус + статистика + настройки (initData в заголовке Authorization: tma …)
 *   POST /api/chat    — {interval, transcribe}  обновить настройки (только админ)
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { BOT_TOKEN, WEBAPP_PORT } from './config.ts';
import { getChat, getChatOrCreate, upsertChatSettings, getMaxMessageId, findChatByCandidates, isPaused, messagesSinceSummary, chargeableCost, type ChatRow } from './db.ts';
import { chatShiftId, chatIdCandidates, payUrl } from './utils.ts';
import { bot } from './bot.ts';

/** initData старше суток считаем невалидным (защита от переиспользования украденного). */
const INIT_DATA_MAX_AGE_S = 24 * 60 * 60;

interface InitDataUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface InitDataChat {
  id: number;
  title?: string;
  type?: string;
}

interface ParsedInit {
  user: InitDataUser;
  chat?: InitDataChat;
  startParam?: string;
  auth_date: number;
}

function validateInitData(initData: string): ParsedInit | null {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    const pairs: string[] = [];
    for (const [k, v] of params.entries()) {
      if (k === 'hash') continue;
      pairs.push(`${k}=${v}`);
    }
    pairs.sort();
    const dataCheckString = pairs.join('\n');

    const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computed = createHmac('sha256', secret).update(dataCheckString).digest();
    const received = Buffer.from(hash, 'hex');
    if (computed.length !== received.length || !timingSafeEqual(computed, received)) return null;

    const auth_date = Number(params.get('auth_date') ?? 0);
    if (!auth_date || Date.now() / 1000 - auth_date > INIT_DATA_MAX_AGE_S) return null;

    const user = params.get('user') ? JSON.parse(params.get('user')!) as InitDataUser : null;
    if (!user) return null;
    const chat = params.get('chat') ? JSON.parse(params.get('chat')!) as InitDataChat : undefined;
    const startParam = params.get('start_param') ?? undefined;
    return { user, chat, startParam, auth_date };
  } catch {
    return null;
  }
}

function chatPublicView(chat: ChatRow, lastMessageId: number | null) {
  return {
    chat_id: chat.chat_id,
    shift_id: chatShiftId(chat.chat_id),
    title: chat.title,
    status: isPaused(chat) ? 'на паузе до оплаты' : 'подключён',
    paused: isPaused(chat),
    activated: !!chat.activated,
    total_cost: chargeableCost(chat),
    balance: chat.balance,
    n_messages: chat.n_messages,
    n_summaries: chat.n_summaries,
    interval: chat.interval,
    transcribe: !!chat.transcribe,
    messages_since_summary: messagesSinceSummary(chat, lastMessageId),
    pay_url: payUrl(chat.chat_id),
  };
}

const HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>Concisely</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,sans-serif; background:var(--tg-theme-bg-color,#fff); color:var(--tg-theme-text-color,#000); }
  .wrap { padding:20px 16px 32px; max-width:520px; margin:0 auto; }

  h1 { font-size:22px; font-weight:700; margin:0; text-align:center; line-height:1.25; }

  .idrow { text-align:center; margin-top:6px; }
  .idwrap { position:relative; display:inline-block; }
  .idwrap code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13px; opacity:.7; }
  .copybtn { position:absolute; left:100%; top:50%; transform:translateY(-50%); width:auto; padding:2px 6px; border:none; border-radius:6px; background:transparent; color:inherit; opacity:.6; font-size:14px; cursor:pointer; line-height:1; }
  .copybtn:active { opacity:1; }

  .counter { text-align:center; margin:26px 0 18px; }
  .counter-label { font-size:14px; opacity:.7; }
  .counter-value { font-size:44px; font-weight:700; margin-top:4px; line-height:1.1; }

  .badge { display:block; text-align:center; padding:10px; border-radius:12px; font-size:15px; font-weight:600; margin-bottom:20px; }
  .badge.active { background:rgba(34,197,94,.18); color:#16a34a; }
  .badge.paused { background:rgba(239,68,68,.18); color:#ef4444; }

  .stats { margin-bottom:16px; }
  .stats .line { padding:5px 0; font-size:15px; }
  .stats .line b { font-weight:600; }

  .pay { display:block; text-align:center; margin-bottom:24px; color:var(--tg-theme-link-color,#3390ec); font-size:15px; text-decoration:underline; cursor:pointer; }
  .pay:active { opacity:.7; }

  .settings { border-top:1px solid var(--tg-theme-secondary-bg-color,#e5e5e5); padding-top:18px; }
  .setting { display:flex; align-items:center; gap:12px; margin:14px 0; }
  .setting label { margin:0; font-size:15px; opacity:1; }
  /* 16px предотвращает авто-зум при фокусе на iOS; фикс. ширина под ~4 цифры */
  .setting input[type=number] { flex:none; width:64px; text-align:center; padding:11px 6px; border-radius:10px; border:1px solid var(--tg-theme-hint-color,#ccc); background:var(--tg-theme-bg-color,#fff); color:inherit; font-size:16px; }
  .setting input[type=checkbox] { flex:none; width:22px; height:22px; margin:0 21px; }
  button.save { width:100%; padding:13px; border:none; border-radius:12px; background:var(--tg-theme-button-color,#3390ec); color:var(--tg-theme-button-text-color,#fff); font-size:16px; font-weight:600; margin-top:24px; margin-bottom:12px; cursor:pointer; }
  button.save:disabled, input:disabled { opacity:.5; }
  .settings.readonly { opacity:.85; }
  #msg { text-align:center; }
  .err { color:#ef4444; font-size:14px; margin-top:10px; white-space:pre-wrap; }
  .ok { color:#16a34a; font-size:14px; margin-top:10px; animation:fadeout 2.5s forwards; }
  @keyframes fadeout { 0%,40% { opacity:1; } 100% { opacity:0; } }
  .card { background:var(--tg-theme-secondary-bg-color,#f2f2f2); border-radius:12px; padding:14px; }
</style>
</head>
<body>
<div class="wrap">
  <div id="app" style="display:none">
    <h1 id="title"></h1>
    <div class="idrow">
      <span class="idwrap">
        <code id="shift"></code>
        <button id="copy" class="copybtn" title="Скопировать id">⧉</button>
      </span>
    </div>

    <div class="counter">
      <div class="counter-label">Сообщений до саммари</div>
      <div class="counter-value"><span id="progress">0</span> / <span id="interval-val">0</span></div>
    </div>

    <div id="badge" class="badge"></div>

    <div class="stats">
      <div class="line" id="messages-line"></div>
      <div class="line" id="balance-line"></div>
    </div>

    <a id="pay" class="pay">Оплатить у админа</a>

    <div class="settings" id="settings">
      <div class="setting">
        <input id="interval" type="number" min="1" inputmode="numeric">
        <label for="interval">Интервал между саммари в сообщениях</label>
      </div>
      <div class="setting">
        <input id="transcribe" type="checkbox">
        <label for="transcribe">Присылать расшифровки голосовых и кружочков</label>
      </div>
      <button id="save" class="save">Сохранить</button>
      <div id="msg"></div>
    </div>
  </div>

  <div id="status" class="card">Загрузка…</div>
  <div id="nochat" class="card" style="display:none">Чат не найден. Откройте Mini App кнопкой из чата с ботом.</div>
</div>
<script>
const tg = window.Telegram?.WebApp;
tg?.expand();
const initData = tg?.initData || '';
const startParam = (tg?.initDataUnsafe?.start_param) || (new URLSearchParams(location.search).get('tgWebAppStartParam')) || '';
const $ = id => document.getElementById(id);

function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function money(n){ n = Number(n); return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2); }

function render(r) {
  $('status').style.display = 'none';
  $('app').style.display = 'block';

  $('title').textContent = r.title || 'Без названия';
  $('shift').textContent = r.shift_id;

  $('progress').textContent = r.messages_since_summary;
  $('interval-val').textContent = r.interval;

  $('badge').className = 'badge ' + (r.paused ? 'paused' : 'active');
  $('badge').textContent = r.status;

  const remaining = r.balance - r.total_cost;
  $('messages-line').innerHTML = 'Уже отправлено <b>' + r.n_messages + '</b> сообщений и <b>' + r.n_summaries + '</b> саммари';
  $('balance-line').innerHTML = 'На балансе осталось ' + money(r.balance) + ' − ' + money(r.total_cost) + ' = <b>' + money(remaining) + '</b>';

  $('pay').onclick = () => {
    if (tg && tg.openTelegramLink) tg.openTelegramLink(r.pay_url);
    else window.open(r.pay_url, '_blank');
  };

  $('interval').value = r.interval;
  $('transcribe').checked = r.transcribe;

  const canEdit = !!r.can_edit;
  $('interval').disabled = !canEdit;
  $('transcribe').disabled = !canEdit;
  $('save').style.display = canEdit ? 'block' : 'none';
  $('settings').classList.toggle('readonly', !canEdit);
}

const authHeaders = { 'Authorization': 'tma ' + initData };

async function load() {
  if (!initData) { $('status').textContent = 'Mini App открыт вне Telegram'; return; }
  if (!startParam) { $('status').style.display='none'; $('nochat').style.display='block'; return; }
  const r = await fetch('/api/chat', { headers: authHeaders }).then(r=>r.json()).catch(e=>({error:String(e)}));
  if (r.error) { $('status').innerHTML = '<span class="err">'+esc(r.error)+'</span>'; return; }
  if (r.not_found) { $('status').style.display='none'; $('nochat').style.display='block'; return; }
  render(r);
  $('save').onclick = save;
  $('copy').onclick = copyId;
}

function copyId() {
  const text = $('shift').textContent;
  const done = () => { const b=$('copy'); const o=b.textContent; b.textContent='✓'; setTimeout(()=>{b.textContent=o;},1200); };
  if (navigator.clipboard) { navigator.clipboard.writeText(text).then(done).catch(()=>{}); }
}

async function save() {
  $('msg').textContent=''; $('save').disabled=true;
  const body = { interval: parseInt($('interval').value), transcribe: $('transcribe').checked };
  const r = await fetch('/api/chat',{method:'POST',headers:{...authHeaders,'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).catch(e=>({error:String(e)}));
  $('save').disabled=false;
  if (r.error) { $('msg').innerHTML='<span class="err">'+esc(r.error)+'</span>'; return; }
  render(r);
  $('msg').innerHTML='<span class="ok">Сохранено</span>';
}

document.addEventListener('touchstart', e => {
  const a = document.activeElement;
  if (a && a.tagName === 'INPUT' && a !== e.target) a.blur();
}, { passive: true });

load();
</script>
</body>
</html>`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Разрешает чат из подписанного start_param (direct-link несёт полный id) либо
 * из initData.chat. Оба источника покрыты подписью initData — chat_id от клиента
 * отдельным параметром не принимаем. На случай, если придёт shift-id (напр.
 * введённый вручную), ищем в БД всех кандидатов; не нашли — создаём по наиболее вероятному.
 */
async function resolveChat(parsed: ParsedInit): Promise<ChatRow | null> {
  if (parsed.startParam) {
    const candidates = chatIdCandidates(parsed.startParam);
    if (!candidates.length) return null;
    const found = await findChatByCandidates(candidates);
    return found ?? await getChatOrCreate(candidates[0]);
  }
  if (parsed.chat?.id != null) {
    return await getChat(parsed.chat.id) ?? await getChatOrCreate(parsed.chat.id);
  }
  return null;
}

async function isAdminOfChat(chatId: number, userId: number): Promise<boolean> {
  try {
    const member = await bot.api.getChatMember(chatId, userId);
    return member.status === 'administrator' || member.status === 'creator';
  } catch {
    return false;
  }
}

/** initData передаётся в заголовке Authorization: tma <initData>, чтобы не оседать в логах прокси. */
function initDataFromHeader(req: Request): string {
  const auth = req.headers.get('authorization') ?? '';
  return auth.startsWith('tma ') ? auth.slice(4) : '';
}

async function handleGetChat(req: Request): Promise<Response> {
  const parsed = validateInitData(initDataFromHeader(req));
  if (!parsed) return json({ error: 'invalid_init_data' }, 401);
  const chat = await resolveChat(parsed);
  if (!chat) return json({ not_found: true }, 404);

  const isAdmin = await isAdminOfChat(chat.chat_id, parsed.user.id);
  const lastMessageId = await getMaxMessageId(chat.chat_id);
  return json({ ...chatPublicView(chat, lastMessageId), can_edit: isAdmin });
}

async function handlePostChat(req: Request): Promise<Response> {
  let body: { interval?: number; transcribe?: boolean };
  try {
    body = await req.json() as typeof body;
  } catch {
    return json({ error: 'bad_json' }, 400);
  }
  const parsed = validateInitData(initDataFromHeader(req));
  if (!parsed) return json({ error: 'invalid_init_data' }, 401);
  const resolved = await resolveChat(parsed);
  if (!resolved) return json({ error: 'no_chat' }, 400);
  const chatId = resolved.chat_id;

  const interval = Math.floor(Number(body.interval));
  if (!Number.isFinite(interval) || interval < 1) return json({ error: 'bad_interval' }, 400);
  const transcribe = !!body.transcribe;

  const isAdmin = await isAdminOfChat(chatId, parsed.user.id);
  if (!isAdmin) return json({ error: 'not_admin' }, 403);

  await upsertChatSettings(chatId, interval, transcribe);
  const chat = await getChat(chatId);
  if (!chat) return json({ error: 'not_found' }, 404);
  const lastMessageId = await getMaxMessageId(chatId);
  return json({ ...chatPublicView(chat, lastMessageId), can_edit: true });
}

export function startWebApp(): void {
  const server = Bun.serve({
    port: WEBAPP_PORT,
    fetch(req): Response | Promise<Response> {
      const url = new URL(req.url);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      if (req.method === 'GET' && url.pathname === '/api/chat') return handleGetChat(req);
      if (req.method === 'POST' && url.pathname === '/api/chat') return handlePostChat(req);
      return new Response('Not Found', { status: 404 });
    },
  });
  console.log(`Mini App слушает на http://localhost:${server.port}`);
}
