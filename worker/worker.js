// Сервер топа для Telegram-версии игры (Cloudflare Worker + база D1).
// Нужны: привязка D1 с именем DB и секрет BOT_TOKEN (токен бота из @BotFather).
// Необязательно: ADMIN_USERNAME (по умолчанию zenix228) — кто может скрывать игроков из топа и делать возвраты,
//                GAME_URL — адрес игры для кнопки «Играть» в ответ на /start.
// Покупки за звёзды: один раз откройте <адрес воркера>/setup — Telegram начнёт присылать сюда оплаты.
// Личность игрока проверяется по подписи Telegram (initData), подделать чужой аккаунт нельзя.

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
  return u && u.id ? u : null;
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
const GAME_URL_DEFAULT = 'https://parfenovakim1337-ops.github.io/zayac/';
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
    await tg(env, 'sendMessage', { chat_id: m.chat.id, text: '🐰 Крути, собирай зайцев и попади в топ!', reply_markup: { inline_keyboard: [[{ text: 'Играть', web_app: { url: env.GAME_URL || GAME_URL_DEFAULT } }]] } });
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
          EXISTS (SELECT 1 FROM purchases p WHERE p.user_id = top.id AND p.item = 'gold' AND p.refunded = 0) AS gold
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
      return json({ ok: true, saved, k, admin, banned: !!(row && row.banned), items: await owned(env.DB, user.id), crown: c.rank.get(user.id) || 0, crownsLeft: c.left });
    }

    if (url.pathname === '/me') { const c = await crowns(env.DB); return json({ ok: true, k, admin, items: await owned(env.DB, user.id), crown: c.rank.get(user.id) || 0, crownsLeft: c.left }); }

    // Счёт на оплату звёздами: игра открывает его через Telegram.WebApp.openInvoice
    if (url.pathname === '/invoice') {
      const item = String(body.item || ''), it = ITEMS[item];
      if (!it) return json({ error: 'bad_item' }, 400);
      if ((await owned(env.DB, user.id)).includes(item)) return json({ error: 'owned' }, 409);
      const r = await tg(env, 'createInvoiceLink', { title: it.title, description: it.description, payload: item + ':' + user.id, currency: 'XTR', prices: [{ label: it.title, amount: it.price }] });
      if (!r.ok) return json({ error: 'tg', detail: r.description }, 502);
      return json({ ok: true, link: r.result });
    }

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
