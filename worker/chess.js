// Шахматные правила для игры «Зайцы»: один и тот же код проверяет ходы на сервере и подсвечивает их в игре.
// Доска — массив из 64 клеток: индекс = ряд*8 + вертикаль, ряд 0 — первая горизонталь (белые внизу).
// Фигуры: P N B R Q K — белые, p n b r q k — чёрные, '' — пусто.
const CH_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const chFile = s => s & 7, chRank = s => s >> 3;
const chSq = n => (n.charCodeAt(0) - 97) + (n.charCodeAt(1) - 49) * 8;
const chName = s => String.fromCharCode(97 + chFile(s)) + (chRank(s) + 1);
const chWhite = p => p !== '' && p === p.toUpperCase();
const chSide = p => p === '' ? '' : chWhite(p) ? 'w' : 'b';

function chParse(fen) {
  const [pos, turn, castle, ep, half, full] = String(fen || CH_START).split(' ');
  const b = new Array(64).fill('');
  pos.split('/').forEach((row, i) => { let f = 0; for (const c of row) { if (/\d/.test(c)) f += +c; else { b[(7 - i) * 8 + f] = c; f++; } } });
  return { b, turn: turn === 'b' ? 'b' : 'w', castle: castle && castle !== '-' ? castle : '', ep: ep && ep !== '-' ? chSq(ep) : -1, half: +half || 0, full: +full || 1 };
}
function chFen(s) {
  const rows = [];
  for (let r = 7; r >= 0; r--) { let row = '', e = 0; for (let f = 0; f < 8; f++) { const p = s.b[r * 8 + f]; if (!p) e++; else { if (e) { row += e; e = 0; } row += p; } } if (e) row += e; rows.push(row); }
  return `${rows.join('/')} ${s.turn} ${s.castle || '-'} ${s.ep >= 0 ? chName(s.ep) : '-'} ${s.half} ${s.full}`;
}
const CH_N = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const CH_K = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const CH_D = [[1, 1], [1, -1], [-1, 1], [-1, -1]], CH_O = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const chAt = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8 ? r * 8 + f : -1;

// бьёт ли сторона by клетку sq
function chAttacked(s, sq, by) {
  const f = chFile(sq), r = chRank(sq), up = by === 'w' ? -1 : 1, P = by === 'w' ? 'P' : 'p';
  for (const df of [-1, 1]) { const t = chAt(f + df, r + up); if (t >= 0 && s.b[t] === P) return true; }
  const own = p => p !== '' && chSide(p) === by;
  for (const [df, dr] of CH_N) { const t = chAt(f + df, r + dr); if (t >= 0 && own(s.b[t]) && s.b[t].toUpperCase() === 'N') return true; }
  for (const [df, dr] of CH_K) { const t = chAt(f + df, r + dr); if (t >= 0 && own(s.b[t]) && s.b[t].toUpperCase() === 'K') return true; }
  for (const [dirs, kinds] of [[CH_D, 'BQ'], [CH_O, 'RQ']]) for (const [df, dr] of dirs) {
    let ff = f + df, rr = r + dr;
    while (ff >= 0 && ff < 8 && rr >= 0 && rr < 8) { const p = s.b[rr * 8 + ff]; if (p) { if (own(p) && kinds.includes(p.toUpperCase())) return true; break; } ff += df; rr += dr; }
  }
  return false;
}
const chKing = (s, side) => s.b.indexOf(side === 'w' ? 'K' : 'k');
const chInCheck = (s, side) => { const k = chKing(s, side); return k >= 0 && chAttacked(s, k, side === 'w' ? 'b' : 'w'); };

function chPseudo(s) {
  const out = [], me = s.turn, them = me === 'w' ? 'b' : 'w';
  const add = (from, to, promo) => out.push({ from, to, promo: promo || '' });
  for (let sq = 0; sq < 64; sq++) {
    const p = s.b[sq]; if (!p || chSide(p) !== me) continue;
    const f = chFile(sq), r = chRank(sq), k = p.toUpperCase();
    if (k === 'P') {
      const dir = me === 'w' ? 1 : -1, last = me === 'w' ? 7 : 0, start = me === 'w' ? 1 : 6;
      const push = (to) => { if (chRank(to) === last) 'QRBN'.split('').forEach(q => add(sq, to, q)); else add(sq, to); };
      const one = chAt(f, r + dir);
      if (one >= 0 && !s.b[one]) { push(one); const two = chAt(f, r + 2 * dir); if (r === start && !s.b[two]) add(sq, two); }
      for (const df of [-1, 1]) { const t = chAt(f + df, r + dir); if (t < 0) continue; if ((s.b[t] && chSide(s.b[t]) === them) || t === s.ep) push(t); }
    } else if (k === 'N' || k === 'K') {
      for (const [df, dr] of (k === 'N' ? CH_N : CH_K)) { const t = chAt(f + df, r + dr); if (t >= 0 && chSide(s.b[t]) !== me) add(sq, t); }
      if (k === 'K') {
        const rank = me === 'w' ? 0 : 7, base = rank * 8;
        if (sq === base + 4 && !chAttacked(s, sq, them)) {
          const K = me === 'w' ? 'K' : 'k', Q = me === 'w' ? 'Q' : 'q', R = me === 'w' ? 'R' : 'r';
          if (s.castle.includes(K) && s.b[base + 7] === R && !s.b[base + 5] && !s.b[base + 6] && !chAttacked(s, base + 5, them) && !chAttacked(s, base + 6, them)) add(sq, base + 6);
          if (s.castle.includes(Q) && s.b[base] === R && !s.b[base + 1] && !s.b[base + 2] && !s.b[base + 3] && !chAttacked(s, base + 3, them) && !chAttacked(s, base + 2, them)) add(sq, base + 2);
        }
      }
    } else {
      const dirs = k === 'B' ? CH_D : k === 'R' ? CH_O : CH_D.concat(CH_O);
      for (const [df, dr] of dirs) { let ff = f + df, rr = r + dr; while (ff >= 0 && ff < 8 && rr >= 0 && rr < 8) { const t = rr * 8 + ff; if (s.b[t]) { if (chSide(s.b[t]) === them) add(sq, t); break; } add(sq, t); ff += df; rr += dr; } }
    }
  }
  return out;
}
function chApply(s, m) {
  const b = s.b.slice(), p = b[m.from], me = s.turn, k = p.toUpperCase();
  let castle = s.castle, ep = -1, half = s.half + 1;
  const cap = b[m.to] || (k === 'P' && m.to === s.ep ? (me === 'w' ? 'p' : 'P') : '');
  if (k === 'P' || cap) half = 0;
  b[m.to] = m.promo ? (me === 'w' ? m.promo.toUpperCase() : m.promo.toLowerCase()) : p; b[m.from] = '';
  if (k === 'P' && m.to === s.ep) b[m.to + (me === 'w' ? -8 : 8)] = '';
  if (k === 'P' && Math.abs(m.to - m.from) === 16) ep = (m.to + m.from) / 2;
  if (k === 'K' && Math.abs(m.to - m.from) === 2) { // рокировка: ладья перепрыгивает
    if (m.to > m.from) { b[m.from + 1] = b[m.from + 3]; b[m.from + 3] = ''; } else { b[m.from - 1] = b[m.from - 4]; b[m.from - 4] = ''; }
  }
  const strip = (cs) => { for (const c of cs) castle = castle.replace(c, ''); };
  if (k === 'K') strip(me === 'w' ? 'KQ' : 'kq');
  [[0, 'Q'], [7, 'K'], [56, 'q'], [63, 'k']].forEach(([sq, c]) => { if (m.from === sq || m.to === sq) strip(c); });
  return { b, turn: me === 'w' ? 'b' : 'w', castle, ep, half, full: s.full + (me === 'b' ? 1 : 0), cap };
}
function chMoves(s) { return chPseudo(s).filter(m => !chInCheck(chApply(s, m), s.turn)); }
function chInsufficient(s) {
  const left = s.b.filter(p => p && p.toUpperCase() !== 'K').map(p => p.toUpperCase());
  return left.length === 0 || (left.length === 1 && 'BN'.includes(left[0]));
}
// итог позиции: '' — игра идёт; иначе причина конца
function chStatus(s) {
  const moves = chMoves(s), check = chInCheck(s, s.turn);
  if (!moves.length) return { over: true, check, result: check ? (s.turn === 'w' ? '0-1' : '1-0') : '1/2', reason: check ? 'mate' : 'stalemate' };
  if (s.half >= 100) return { over: true, check, result: '1/2', reason: 'fifty' };
  if (chInsufficient(s)) return { over: true, check, result: '1/2', reason: 'material' };
  return { over: false, check, result: '', reason: '' };
}
// ход в виде 'e2e4' или 'e7e8q' → новая позиция или null, если ход невозможен
function chPlay(fen, uci) {
  const s = chParse(fen), u = String(uci || '');
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(u)) return null;
  const from = chSq(u.slice(0, 2)), to = chSq(u.slice(2, 4)), promo = (u[4] || '').toUpperCase();
  const m = chMoves(s).find(x => x.from === from && x.to === to && (x.promo || '') === promo);
  if (!m) return null;
  const n = chApply(s, m);
  return { fen: chFen(n), cap: n.cap, status: chStatus(n) };
}
export { CH_START, chParse, chFen, chMoves, chApply, chStatus, chPlay, chInCheck, chSq, chName, chSide };
