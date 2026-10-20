// Сервер топа для Telegram-версии игры (Cloudflare Worker + база D1).
// Нужны: привязка D1 с именем DB и секрет BOT_TOKEN (токен бота из @BotFather).
// Необязательно: ADMIN_USERNAME (по умолчанию zenix228) — кто может скрывать игроков из топа.
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
async function ensure(db) {
  if (ready) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS top (id INTEGER PRIMARY KEY, k TEXT, name TEXT, lg REAL, money TEXT, best TEXT, rare INTEGER, ts INTEGER, banned INTEGER DEFAULT 0)'),
    db.prepare('CREATE INDEX IF NOT EXISTS top_lg ON top (banned, lg DESC)'),
    db.prepare('CREATE INDEX IF NOT EXISTS top_k ON top (k)'),
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
        const { results } = await env.DB.prepare('SELECT k, name, lg, money, best, rare, ts FROM top WHERE banned = 0 ORDER BY lg DESC LIMIT ?').bind(LIMIT).all();
        memo = { rows: results, at: Date.now() };
      }
      return json(memo);
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
      return json({ ok: true, saved, k, admin, banned: !!(row && row.banned) });
    }

    if (url.pathname === '/me') return json({ ok: true, k, admin });

    if (url.pathname === '/admin') {
      if (!admin) return json({ error: 'forbidden' }, 403);
      const tk = String(body.k || '');
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
