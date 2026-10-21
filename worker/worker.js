// Сервер топа для Telegram-версии игры (Cloudflare Worker + база D1).
// Нужны: привязка D1 с именем DB и секрет BOT_TOKEN (токен бота из @BotFather).
// Необязательно: ADMIN_USERNAME (по умолчанию zenix228) — кто может скрывать игроков из топа и делать возвраты,
//                GAME_URL — адрес игры для кнопки «Играть» в ответ на /start.
// Покупки за звёзды: один раз откройте <адрес воркера>/setup — Telegram начнёт присылать сюда оплаты.
// Личность игрока проверяется по подписи Telegram (initData), подделать чужой аккаунт нельзя.

import { CH_START, chParse, chPlay } from './chess.js';

const LIMIT = 100;
const MAX_AGE = 7 * 24 * 3600;       // initData старше недели не принимаем
const MIN_GAP = 5000;                 // одна запись от игрока не чаще раза в 5 секунд
const NUM_RE = /^\d+(\.\d+)?(e[+-]?\d+)?$/i;
const enc = new TextEncoder();

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  },
});

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

// Проверка initData по документации Telegram Mini Apps
async function checkInit(initData, token) {
  if (typeof initData !== 'string' || initData.length > 4096 || !token) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash'); if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = await hmac('WebAppData', token);
  if (hex(await hmac(secret, dcs)) !== hash) return null;
  const at = Number(p.get('auth_date')) || 0;
  if (Date.now() / 1000 - at > MAX_AGE) return null;
  let u; try { u = JSON.parse(p.get('user') || 'null'); } catch (e) { return null; }
  if (!u || !u.id) return null;
  u._start = String(p.get('start_param') || ''); // реф-код, если игру открыли по ссылке t.me/бот?startapp=…
  return u;
}

// короткий публичный ключ игрока вместо его Telegram id
const keyOf = async (id, token) => hex(await hmac(token, 'k:' + id)).slice(0, 12);
const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);

let ready = false, memo = null;

// Товары за звёзды. Цена — в звёздах (XTR). Меняя цену здесь, поменяйте её и в игре (TG_ITEMS).
const ITEMS = {
  autoall: { title: 'Авто олл-ин навсегда', description: 'Кнопка «Авто олл-ин»: игра сама ставит весь баланс серия за серией, пока вы не нажмёте «Стоп». Покупка навсегда, на всех устройствах.', price: 149 },
  gold: { title: 'Золотой ник в топе', description: 'Ваше имя в общем топе горит золотом. Первым 10 покупателям — корона у ника, самому первому — ещё и звёздочки. Покупка навсегда.', price: 49 },
};
const GAME_URL_DEFAULT = 'https://zayac.pages.dev/';
const tg = async (env, method, params) => {
  const r = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  return r.json();
};
const hookSecret = async env => hex(await hmac(env.BOT_TOKEN, 'webhook')).slice(0, 48);
// Первые 10 покупателей золотого ника получают корону, самый первый — ещё и звёздочки.
// Считаются только не возвращённые покупки: если кто-то вернул звёзды, его место переходит дальше.
const CROWNS = 10;
async function crowns(db) {
  const { results } = await db.prepare("SELECT user_id, MIN(ts) AS t FROM purchases WHERE item = 'gold' AND refunded = 0 GROUP BY user_id ORDER BY t LIMIT ?").bind(CROWNS).all();
  const rank = new Map(results.map((r, i) => [r.user_id, i + 1]));
  return { rank, left: Math.max(0, CROWNS - results.length) };
}
// ---- Рефералы: друг, впервые открывший игру по твоей ссылке, засчитывается тебе ----
const REF_RAINBOW = 5;
let botName = null;
const botUser = async env => { if (!botName) { const r = await tg(env, 'getMe', {}); botName = r.ok ? r.result.username : ''; } return botName; };
// друзья = реальные приглашённые + бонусные (выдаются вручную, таблица ref_bonus)
const OWNER_BONUS_REFS = 9; // владельцу игры (ADMIN_USERNAME) засчитано 9 друзей
const refCount = async (db, uid) => ((await db.prepare('SELECT (SELECT COUNT(*) FROM players WHERE ref_by = ?1 AND ok = 1) + COALESCE((SELECT n FROM ref_bonus WHERE id = ?1), 0) AS n').bind(uid).first()) || {}).n || 0;
// реф-код — это публичный ключ игрока (k), по нему находим пригласившего
async function inviterOf(db, code, selfId) {
  const m = /^r_([0-9a-f]{12})$/.exec(String(code || '')); if (!m) return null;
  const inv = await db.prepare('SELECT id FROM players WHERE k = ?').bind(m[1]).first();
  return inv && inv.id !== selfId ? inv.id : null;
}
// «новый» игрок — тот, кого сервер ещё ни разу не видел ни в игре, ни в топе
const isNew = async (db, id) => !(await db.prepare('SELECT 1 FROM players WHERE id = ?').bind(id).first()) && !(await db.prepare('SELECT 1 FROM top WHERE id = ?').bind(id).first());
async function refDone(env, inviter, friendName) {
  const n = await refCount(env.DB, inviter);
  const extra = n === REF_RAINBOW ? '\n🌈 Это пятый друг — твой ник в топе теперь радужный!' : n < REF_RAINBOW ? `\nДо радужного ника: ещё ${REF_RAINBOW - n}.` : '';
  try { await tg(env, 'sendMessage', { chat_id: inviter, text: `🎉 ${friendName || 'Друг'} зашёл в игру по твоей ссылке! Друзей: ${n}, бонус к выплатам ×${(1 + 0.1 * Math.min(n, REF_CAP)).toFixed(1)}.${extra}` }); } catch (e) {}
}
const REF_CAP = 20; // больше 20 друзей бонус не растёт (×3.0) — защита от накрутки фейковыми аккаунтами
// вызывается при каждом заходе игрока в игру
async function touchPlayer(env, user, k) {
  const db = env.DB, now = Date.now();
  // юзернейм нужен, чтобы игрока можно было вызвать на шахматы по @нику
  await db.prepare('INSERT INTO names (id, uname, first, ts) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET uname = ?2, first = ?3, ts = ?4 WHERE names.uname IS NOT ?2 OR names.first IS NOT ?3')
    .bind(user.id, String(user.username || '').toLowerCase() || null, cleanName(user.first_name) || 'Игрок', now).run();
  const p = await db.prepare('SELECT ref_by, ok, k FROM players WHERE id = ?').bind(user.id).first();
  if (!p) {
    const ref = (await isNew(db, user.id)) ? await inviterOf(db, user._start, user.id) : null;
    await db.prepare('INSERT OR IGNORE INTO players (id, k, ref_by, ok, ts) VALUES (?, ?, ?, ?, ?)').bind(user.id, k, ref, ref ? 1 : 0, now).run();
    if (ref) await refDone(env, ref, cleanName(user.first_name));
  } else {
    if (p.k !== k) await db.prepare('UPDATE players SET k = ? WHERE id = ?').bind(k, user.id).run();
    if (p.ref_by && !p.ok) { await db.prepare('UPDATE players SET ok = 1 WHERE id = ?').bind(user.id).run(); await refDone(env, p.ref_by, cleanName(user.first_name)); }
  }
}
async function refInfo(env, user, k) {
  const n = await refCount(env.DB, user.id), bot = await botUser(env);
  const fl = await env.DB.prepare('SELECT rainbow FROM flags WHERE id = ?').bind(user.id).first();
  const admin = String(user.username || '').toLowerCase() === String(env.ADMIN_USERNAME || 'zenix228').toLowerCase();
  return { refs: n, refLink: bot ? `https://t.me/${bot}?start=r_${k}` : '', rainbow: n >= REF_RAINBOW || !!(fl && fl.rainbow), chess: await chessAllowed(env.DB, user.id, admin) };
}
// ---- Шахматы 1 на 1: вызов по юзернейму, ставка игровыми деньгами, ходы проверяет сервер ----
const CH_PENDING_TTL = 48 * 3600e3, CH_IDLE_TTL = 72 * 3600e3;
const chSideOf = (g, uid) => g.w === uid ? 'w' : g.b === uid ? 'b' : '';
const chTurn = fen => (String(fen).split(' ')[1] === 'b' ? 'b' : 'w');
const chOpp = c => (c === 'w' ? 'b' : 'w');
// просроченные вызовы и брошенные партии закрываются при первом обращении
async function chTidy(db, g) {
  const now = Date.now();
  if (g.status === 'pending' && now - g.created > CH_PENDING_TTL) { g.status = 'expired'; g.updated = now; await db.prepare("UPDATE chess SET status = 'expired', updated = ? WHERE id = ? AND status = 'pending'").bind(now, g.id).run(); }
  if (g.status === 'active' && now - g.updated > CH_IDLE_TTL) {
    const loser = chTurn(g.fen); g.status = 'done'; g.result = loser === 'w' ? '0-1' : '1-0'; g.reason = 'timeout'; g.updated = now;
    await db.prepare("UPDATE chess SET status = 'done', result = ?, reason = 'timeout', updated = ? WHERE id = ? AND status = 'active'").bind(g.result, now, g.id).run();
  }
  return g;
}
function chView(g, uid, full) {
  const me = chSideOf(g, uid), op = chOpp(me);
  const v = { id: g.id, me, opp: op === 'w' ? g.wname : g.bname, myStyle: me === 'w' ? g.wstyle : g.bstyle, oppStyle: op === 'w' ? g.wstyle : g.bstyle,
    mine: g.ch === uid, stake: g.stake, label: g.label, status: g.status, turn: chTurn(g.fen), result: g.result, reason: g.reason, updated: g.updated,
    paid: !!(me === 'w' ? g.wpaid : g.bpaid), n: g.moves ? g.moves.split(' ').length : 0, last: g.moves ? g.moves.split(' ').pop() : '' };
  if (full) { v.fen = g.fen; v.moves = g.moves; }
  return v;
}
// Шахматы пока закрытые: владелец игры, приглашённые им друзья (по реф-ссылке) и те, кого он сам вызвал
async function chessAllowed(db, uid, admin) {
  if (admin) return true;
  const a = await db.prepare("SELECT val FROM kv WHERE key = 'admin_id'").first(); if (!a) return false;
  const aid = +a.val;
  if (await db.prepare('SELECT 1 FROM players WHERE id = ? AND ref_by = ?').bind(uid, aid).first()) return true;
  return !!(await db.prepare('SELECT 1 FROM chess WHERE (w = ?1 AND b = ?2) OR (w = ?2 AND b = ?1) LIMIT 1').bind(uid, aid).first());
}
async function chGet(db, id) { return db.prepare('SELECT * FROM chess WHERE id = ?').bind(String(id || '')).first(); }
async function chessApi(path, body, env, user, ctx, admin) {
  const db = env.DB, now = Date.now(), uid = user.id, name = cleanName(user.first_name) || 'Игрок';
  if (!(await chessAllowed(db, uid, admin))) return json({ error: 'closed' }, 403);
  const url = env.GAME_URL || GAME_URL_DEFAULT;
  const ping = (chat, text) => ctx.waitUntil(tg(env, 'sendMessage', { chat_id: chat, text, reply_markup: { inline_keyboard: [[{ text: '♟ Открыть шахматы', web_app: { url: url + '#chess' } }]] } }).catch(() => {}));
  if (path === '/chess/challenge') {
    const un = String(body.username || '').trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{4,32}$/.test(un)) return json({ error: 'bad_username' }, 400);
    const stake = String(body.stake || ''), label = cleanName(body.label).slice(0, 24);
    if (stake.length > 40 || !NUM_RE.test(stake) || !(Number(stake) > 0)) return json({ error: 'bad_stake' }, 400);
    const opp = await db.prepare('SELECT id, first FROM names WHERE uname = ?').bind(un).first();
    if (!opp) return json({ error: 'no_player' }, 404);
    if (opp.id === uid) return json({ error: 'self' }, 400);
    if (!admin && !(await chessAllowed(db, opp.id, false))) return json({ error: 'opp_closed' }, 403);
    const open = await db.prepare("SELECT COUNT(*) AS n FROM chess WHERE ch = ? AND status = 'pending'").bind(uid).first();
    if (open && open.n >= 5) return json({ error: 'too_many' }, 429);
    const id = hex(crypto.getRandomValues(new Uint8Array(6))), meWhite = crypto.getRandomValues(new Uint8Array(1))[0] < 128;
    const style = Math.max(0, Math.min(63, body.style | 0));
    const [w, b, wn, bn] = meWhite ? [uid, opp.id, name, opp.first] : [opp.id, uid, opp.first, name];
    await db.prepare('INSERT INTO chess (id, w, b, wname, bname, wstyle, bstyle, ch, stake, label, status, fen, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, w, b, wn, bn, meWhite ? style : 0, meWhite ? 0 : style, uid, stake, label, 'pending', CH_START, now, now).run();
    ping(opp.id, `♟ ${name} вызывает тебя на шахматы!${label ? ' Ставка: ' + label + '.' : ''} Открой игру, чтобы принять вызов.`);
    return json({ ok: true, game: chView(await chGet(db, id), uid) });
  }
  if (path === '/chess/list') {
    const { results } = await db.prepare("SELECT * FROM chess WHERE (w = ?1 OR b = ?1) AND (status IN ('pending','active') OR updated > ?2 OR (w = ?1 AND wpaid = 0) OR (b = ?1 AND bpaid = 0)) ORDER BY updated DESC LIMIT 40").bind(uid, now - 7 * 86400e3).all();
    const games = []; for (const g of results) games.push(chView(await chTidy(db, g), uid));
    return json({ ok: true, games });
  }
  const g0 = await chGet(db, body.id); if (!g0) return json({ error: 'no_game' }, 404);
  const g = await chTidy(db, g0), me = chSideOf(g, uid); if (!me) return json({ error: 'forbidden' }, 403);
  if (path === '/chess/state') {
    ctx.waitUntil(db.prepare(`UPDATE chess SET ${me}seen = ? WHERE id = ?`).bind(now, g.id).run());
    return json({ ok: true, game: chView(g, uid, true) });
  }
  if (path === '/chess/respond') {
    if (g.status !== 'pending' || g.ch === uid) return json({ error: 'not_pending' }, 409);
    if (body.accept) {
      const style = Math.max(0, Math.min(63, body.style | 0));
      const r = await db.prepare(`UPDATE chess SET status = 'active', ${me}style = ?, updated = ? WHERE id = ? AND status = 'pending'`).bind(style, now, g.id).run();
      if (!((r.meta ? r.meta.changes : r.changes) > 0)) return json({ error: 'not_pending' }, 409);
      ping(g.ch, `♟ ${name} принял вызов! ${chTurn(g.fen) === chSideOf(g, g.ch) ? 'Ты играешь белыми — твой ход.' : 'Ты играешь чёрными — ждём ход соперника.'}`);
    } else {
      await db.prepare("UPDATE chess SET status = 'declined', updated = ? WHERE id = ? AND status = 'pending'").bind(now, g.id).run();
      ping(g.ch, `♟ ${name} отклонил вызов. Ставка вернётся, когда откроешь игру.`);
    }
    return json({ ok: true, game: chView(await chGet(db, g.id), uid, true) });
  }
  if (path === '/chess/cancel') {
    if (g.status !== 'pending' || g.ch !== uid) return json({ error: 'not_pending' }, 409);
    await db.prepare("UPDATE chess SET status = 'cancelled', updated = ? WHERE id = ? AND status = 'pending'").bind(now, g.id).run();
    return json({ ok: true, game: chView(await chGet(db, g.id), uid) });
  }
  if (path === '/chess/move') {
    if (g.status !== 'active') return json({ error: 'not_active' }, 409);
    if (chTurn(g.fen) !== me) return json({ error: 'not_your_turn' }, 409);
    const n = g.moves ? g.moves.split(' ').length : 0;
    if ((body.n | 0) !== n) return json({ error: 'stale', game: chView(g, uid, true) }, 409);
    const r = chPlay(g.fen, body.uci); if (!r) return json({ error: 'illegal', game: chView(g, uid, true) }, 400);
    const moves = (g.moves ? g.moves + ' ' : '') + body.uci, st = r.status;
    const u = await db.prepare(`UPDATE chess SET fen = ?, moves = ?, updated = ?, status = ?, result = ?, reason = ? WHERE id = ? AND moves = ? AND status = 'active'`)
      .bind(r.fen, moves, now, st.over ? 'done' : 'active', st.result, st.reason, g.id, g.moves || '').run();
    if (!((u.meta ? u.meta.changes : u.changes) > 0)) return json({ error: 'stale' }, 409);
    const ng = await chGet(db, g.id), opp = me === 'w' ? g.b : g.w, oppSeen = me === 'w' ? g.bseen : g.wseen;
    if (st.over) ping(opp, st.reason === 'mate' ? `♟ Мат! ${name} выиграл партию.` : `♟ Партия с ${name} закончилась вничью.`);
    else if (now - (oppSeen || 0) > 90e3) ping(opp, `♟ ${name} сделал ход — теперь твоя очередь.`);
    return json({ ok: true, game: chView(ng, uid, true) });
  }
  if (path === '/chess/resign') {
    if (g.status !== 'active') return json({ error: 'not_active' }, 409);
    await db.prepare("UPDATE chess SET status = 'done', result = ?, reason = 'resign', updated = ? WHERE id = ? AND status = 'active'").bind(me === 'w' ? '0-1' : '1-0', now, g.id).run();
    ping(me === 'w' ? g.b : g.w, `♟ ${name} сдался — победа твоя!`);
    return json({ ok: true, game: chView(await chGet(db, g.id), uid, true) });
  }
  // расчёт ставки: каждая сторона забирает свой итог ровно один раз (даже с двух устройств)
  if (path === '/chess/settle') {
    if (!['done', 'declined', 'cancelled', 'expired'].includes(g.status)) return json({ error: 'not_over' }, 409);
    const r = await db.prepare(`UPDATE chess SET ${me}paid = 1 WHERE id = ? AND ${me}paid = 0`).bind(g.id).run();
    return json({ ok: true, first: ((r.meta ? r.meta.changes : r.changes) || 0) > 0, game: chView(await chGet(db, g.id), uid) });
  }
  return json({ error: 'not_found' }, 404);
}

const owned = async (db, uid) => (await db.prepare('SELECT item FROM purchases WHERE user_id = ? AND refunded = 0').bind(uid).all()).results.map(r => r.item);

async function onUpdate(u, env) {
  const db = env.DB;
  // 1) Telegram спрашивает, можно ли провести оплату — проверяем товар, цену и что он ещё не куплен
  if (u.pre_checkout_query) {
    const q = u.pre_checkout_query, [item, uid] = String(q.invoice_payload || '').split(':'), it = ITEMS[item];
    let err = '';
    if (!it || q.currency !== 'XTR' || q.total_amount !== it.price) err = 'Цена изменилась, откройте покупку заново.';
    else if (String(q.from.id) !== uid) err = 'Покупка оформлена на другой аккаунт.';
    else if ((await owned(db, q.from.id)).includes(item)) err = 'Это у вас уже куплено.';
    await tg(env, 'answerPreCheckoutQuery', err ? { pre_checkout_query_id: q.id, ok: false, error_message: err } : { pre_checkout_query_id: q.id, ok: true });
    return;
  }
  const m = u.message; if (!m) return;
  // 2) Оплата прошла — записываем покупку
  if (m.successful_payment) {
    const sp = m.successful_payment, [item] = String(sp.invoice_payload || '').split(':');
    if (ITEMS[item]) {
      await db.prepare('INSERT OR IGNORE INTO purchases (charge, user_id, name, item, stars, ts) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(sp.telegram_payment_charge_id, m.from.id, cleanName(m.from.first_name), item, sp.total_amount, Date.now()).run();
      memo = null;
      await tg(env, 'sendMessage', { chat_id: m.chat.id, text: '⭐ Спасибо за покупку! «' + ITEMS[item].title + '» уже в игре.' });
    }
    return;
  }
  if (m.refunded_payment) {
    await db.prepare('UPDATE purchases SET refunded = 1 WHERE charge = ?').bind(m.refunded_payment.telegram_payment_charge_id).run();
    memo = null; return;
  }
  // 3) Команды бота
  const text = String(m.text || '');
  if (/^\/start\b/.test(text)) {
    // /start r_<код> — пришёл по ссылке друга: запоминаем, засчитаем, когда он откроет игру
    const code = text.split(/\s+/)[1] || '';
    let invited = false;
    if (code && await isNew(db, m.from.id)) {
      const ref = await inviterOf(db, code, m.from.id);
      if (ref) { await db.prepare('INSERT OR IGNORE INTO players (id, k, ref_by, ok, ts) VALUES (?, NULL, ?, 0, ?)').bind(m.from.id, ref, Date.now()).run(); invited = true; }
    }
    await tg(env, 'sendMessage', { chat_id: m.chat.id, text: invited ? '🐰 Тебя позвал друг! Открой игру — и он получит бонус. Крути, собирай зайцев и попади в топ!' : '🐰 Крути, собирай зайцев и попади в топ!', reply_markup: { inline_keyboard: [[{ text: 'Играть', web_app: { url: env.GAME_URL || GAME_URL_DEFAULT } }]] } });
  } else if (/^\/paysupport\b/.test(text)) {
    await tg(env, 'sendMessage', { chat_id: m.chat.id, text: 'Вопросы по покупкам за звёзды: напишите @' + String(env.ADMIN_USERNAME || 'zenix228') + ' — опишите, что купили и когда. Если покупка не появилась в игре, сначала перезапустите игру.' });
  } else if (/^\/terms\b/.test(text)) {
    await tg(env, 'sendMessage', { chat_id: m.chat.id, text: 'Покупки — это цифровые улучшения внутри игры. Игровые деньги нельзя вывести или обменять на реальные. Покупка привязана к вашему аккаунту Telegram. Возврат — через /paysupport.' });
  }
}
async function ensure(db) {
  if (ready) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS top (id INTEGER PRIMARY KEY, k TEXT, name TEXT, lg REAL, money TEXT, best TEXT, rare INTEGER, ts INTEGER, banned INTEGER DEFAULT 0)'),
    db.prepare('CREATE INDEX IF NOT EXISTS top_lg ON top (banned, lg DESC)'),
    db.prepare('CREATE INDEX IF NOT EXISTS top_k ON top (k)'),
    db.prepare('CREATE TABLE IF NOT EXISTS purchases (charge TEXT PRIMARY KEY, user_id INTEGER, name TEXT, item TEXT, stars INTEGER, ts INTEGER, refunded INTEGER DEFAULT 0)'),
    db.prepare('CREATE INDEX IF NOT EXISTS purchases_user ON purchases (user_id)'),
    db.prepare('CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY, k TEXT, ref_by INTEGER, ok INTEGER DEFAULT 0, ts INTEGER)'),
    db.prepare('CREATE INDEX IF NOT EXISTS players_k ON players (k)'),
    db.prepare('CREATE INDEX IF NOT EXISTS players_ref ON players (ref_by, ok)'),
    db.prepare('CREATE TABLE IF NOT EXISTS flags (id INTEGER PRIMARY KEY, rainbow INTEGER DEFAULT 0)'),
    db.prepare('CREATE TABLE IF NOT EXISTS ref_bonus (id INTEGER PRIMARY KEY, n INTEGER DEFAULT 0)'),
    db.prepare('CREATE TABLE IF NOT EXISTS names (id INTEGER PRIMARY KEY, uname TEXT, first TEXT, ts INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, val TEXT)'),
    db.prepare('CREATE INDEX IF NOT EXISTS names_u ON names (uname)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS chess (id TEXT PRIMARY KEY, w INTEGER, b INTEGER, wname TEXT, bname TEXT, wstyle INTEGER, bstyle INTEGER, ch INTEGER,
      stake TEXT, label TEXT, status TEXT, fen TEXT, moves TEXT DEFAULT '', result TEXT DEFAULT '', reason TEXT DEFAULT '', created INTEGER, updated INTEGER,
      wpaid INTEGER DEFAULT 0, bpaid INTEGER DEFAULT 0, wseen INTEGER DEFAULT 0, bseen INTEGER DEFAULT 0)`),
    db.prepare('CREATE INDEX IF NOT EXISTS chess_w ON chess (w, updated)'),
    db.prepare('CREATE INDEX IF NOT EXISTS chess_b ON chess (b, updated)'),
  ]);
  ready = true;
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return json({});
    const url = new URL(req.url);
    if (!env.DB) return json({ error: 'no_db' }, 500);
    if (!env.BOT_TOKEN) return json({ error: 'no_token' }, 500);
    await ensure(env.DB);

    if (req.method === 'GET' && url.pathname === '/top') {
      // топ кэшируется в памяти на 15 секунд, чтобы не тратить лимит чтений базы
      if (!memo || Date.now() - memo.at > 15000) {
        const { results } = await env.DB.prepare(`SELECT id, k, name, lg, money, best, rare, ts,
          EXISTS (SELECT 1 FROM purchases p WHERE p.user_id = top.id AND p.item = 'gold' AND p.refunded = 0) AS gold,
          ((SELECT COUNT(*) FROM players pl WHERE pl.ref_by = top.id AND pl.ok = 1) + COALESCE((SELECT n FROM ref_bonus rb WHERE rb.id = top.id), 0) >= ${REF_RAINBOW} OR EXISTS (SELECT 1 FROM flags f WHERE f.id = top.id AND f.rainbow = 1)) AS rainbow
          FROM top WHERE banned = 0 ORDER BY lg DESC LIMIT ?`).bind(LIMIT).all();
        const c = await crowns(env.DB);
        memo = { rows: results.map(({ id, ...r }) => ({ ...r, crown: c.rank.get(id) || 0 })), crownsLeft: c.left, at: Date.now() };
      }
      return json(memo);
    }

    // Подключение оплат: Telegram будет присылать сюда счета и платежи (повторный вызов ничего не ломает)
    if (req.method === 'GET' && url.pathname === '/setup') {
      const r = await tg(env, 'setWebhook', { url: url.origin + '/tg-webhook', secret_token: await hookSecret(env), allowed_updates: ['message', 'pre_checkout_query'] });
      await tg(env, 'setMyCommands', { commands: [{ command: 'start', description: 'Играть' }, { command: 'paysupport', description: 'Помощь с покупками' }, { command: 'terms', description: 'Условия покупок' }] });
      return json({ webhook: r });
    }
    if (req.method === 'POST' && url.pathname === '/tg-webhook') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await hookSecret(env)) return json({ error: 'forbidden' }, 403);
      let u; try { u = await req.json(); } catch (e) { return json({ ok: true }); }
      try { await onUpdate(u, env); } catch (e) { console.log('update error', e && e.message); }
      return json({ ok: true });
    }

    if (req.method !== 'POST') return json({ error: 'not_found' }, 404);
    let body; try { body = await req.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }
    const user = await checkInit(body.initData, env.BOT_TOKEN);
    if (!user) return json({ error: 'bad_auth' }, 401);
    const k = await keyOf(user.id, env.BOT_TOKEN);
    const admin = String(user.username || '').toLowerCase() === String(env.ADMIN_USERNAME || 'zenix228').toLowerCase();

    if (url.pathname === '/score' || url.pathname === '/me') {
      await touchPlayer(env, user, k);
      // владельцу игры — радужный ник навсегда (без бонуса к выплатам)
      if (admin) await env.DB.batch([
        env.DB.prepare("INSERT INTO kv (key, val) VALUES ('admin_id', ?1) ON CONFLICT(key) DO UPDATE SET val = ?1 WHERE kv.val IS NOT ?1").bind(String(user.id)),
        env.DB.prepare('INSERT OR IGNORE INTO flags (id, rainbow) VALUES (?, 1)').bind(user.id),
        env.DB.prepare('INSERT INTO ref_bonus (id, n) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET n = excluded.n WHERE ref_bonus.n != excluded.n').bind(user.id, OWNER_BONUS_REFS), // пишет в базу, только если число поменялось
      ]);
    }

    if (url.pathname === '/score') {
      const lg = Number(body.lg);
      if (!isFinite(lg) || lg < -1 || lg > 1e9) return json({ error: 'bad_lg' }, 400);
      const money = String(body.money || ''), best = String(body.best || '0');
      if (money.length > 40 || !NUM_RE.test(money) || best.length > 40 || !NUM_RE.test(best)) return json({ error: 'bad_num' }, 400);
      const rare = Number.isInteger(body.rare) && body.rare >= -1 && body.rare < 64 ? body.rare : -1;
      const name = cleanName(body.nick) || cleanName(user.first_name) || 'Игрок';
      const now = Date.now();
      const r = await env.DB.prepare(`INSERT INTO top (id, k, name, lg, money, best, rare, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET k = ?2, name = ?3, lg = ?4, money = ?5, best = ?6, rare = ?7, ts = ?8 WHERE top.ts < ?9`)
        .bind(user.id, k, name, lg, money, best, rare, now, now - MIN_GAP).run();
      const saved = ((r.meta ? r.meta.changes : r.changes) || 0) > 0;
      if (saved) memo = null;
      const row = await env.DB.prepare('SELECT banned FROM top WHERE id = ?').bind(user.id).first();
      const c = await crowns(env.DB);
      return json({ ok: true, saved, k, admin, banned: !!(row && row.banned), items: await owned(env.DB, user.id), crown: c.rank.get(user.id) || 0, crownsLeft: c.left, ...(await refInfo(env, user, k)) });
    }

    if (url.pathname === '/me') { const c = await crowns(env.DB); return json({ ok: true, k, admin, items: await owned(env.DB, user.id), crown: c.rank.get(user.id) || 0, crownsLeft: c.left, ...(await refInfo(env, user, k)) }); }

    // Счёт на оплату звёздами: игра открывает его через Telegram.WebApp.openInvoice
    if (url.pathname === '/invoice') {
      const item = String(body.item || ''), it = ITEMS[item];
      if (!it) return json({ error: 'bad_item' }, 400);
      if ((await owned(env.DB, user.id)).includes(item)) return json({ error: 'owned' }, 409);
      const r = await tg(env, 'createInvoiceLink', { title: it.title, description: it.description, payload: item + ':' + user.id, currency: 'XTR', prices: [{ label: it.title, amount: it.price }] });
      if (!r.ok) return json({ error: 'tg', detail: r.description }, 502);
      return json({ ok: true, link: r.result });
    }

    if (url.pathname.startsWith('/chess/')) return chessApi(url.pathname, body, env, user, ctx, admin);

    if (url.pathname === '/admin') {
      if (!admin) return json({ error: 'forbidden' }, 403);
      const tk = String(body.k || '');
      if (body.action === 'purchases') {
        const { results } = await env.DB.prepare('SELECT charge, user_id, name, item, stars, ts, refunded FROM purchases ORDER BY ts DESC LIMIT 100').all();
        return json({ ok: true, rows: results });
      }
      if (body.action === 'refund') {
        const p = await env.DB.prepare('SELECT charge, user_id, refunded FROM purchases WHERE charge = ?').bind(String(body.charge || '')).first();
        if (!p) return json({ error: 'no_purchase' }, 404);
        if (!p.refunded) {
          const r = await tg(env, 'refundStarPayment', { user_id: p.user_id, telegram_payment_charge_id: p.charge });
          if (!r.ok && !/ALREADY/i.test(r.description || '')) return json({ error: 'tg', detail: r.description }, 502);
          await env.DB.prepare('UPDATE purchases SET refunded = 1 WHERE charge = ?').bind(p.charge).run();
          memo = null;
        }
        return json({ ok: true });
      }
      if (body.action === 'list_banned') {
        const { results } = await env.DB.prepare('SELECT k, name, lg, money FROM top WHERE banned = 1 ORDER BY lg DESC LIMIT 200').all();
        return json({ ok: true, rows: results });
      }
      if (!/^[0-9a-f]{12}$/.test(tk)) return json({ error: 'bad_k' }, 400);
      if (body.action === 'ban') await env.DB.prepare('UPDATE top SET banned = 1 WHERE k = ?').bind(tk).run();
      else if (body.action === 'unban') await env.DB.prepare('UPDATE top SET banned = 0 WHERE k = ?').bind(tk).run();
      else if (body.action === 'delete') await env.DB.prepare('DELETE FROM top WHERE k = ?').bind(tk).run();
      else return json({ error: 'bad_action' }, 400);
      memo = null;
      return json({ ok: true });
    }
    return json({ error: 'not_found' }, 404);
  },
};
