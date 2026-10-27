'use strict';
// Sect pages: the passwords and the page content never leave the server until the right password is given.
// SECT_PASSWORDS is a Cloudflare secret holding JSON like {"onyx":"...","iron":"...","life":"...","ember":"...","crypt":"..."}.
// SECT_CONTENT_URL is a Cloudflare secret holding the secret "publish to web" CSV link of the private sect content sheet.
import { fail } from './engine.mjs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const norm = s => String(s ?? '').trim().toLowerCase();
const sha = s => createHash('sha256').update(s).digest();
const same = (a, b) => timingSafeEqual(sha(String(a)), sha(String(b)));
const tokenFor = (sect, password) => createHmac('sha256', norm(password)).update('kinship-sect:' + sect).digest('hex');

function passwords(raw) {
  try { const p = JSON.parse(raw || ''); return p && typeof p === 'object' && !Array.isArray(p) ? p : null; } catch { return null; }
}

// A small CSV reader (quotes, commas and line breaks inside quotes).
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; rows.push(row); row = []; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const cache = { at: 0, url: '', rows: null };
async function content(url, fetcher) {
  if (!url) fail('The sect pages are not set up yet. Ask an Advocate.', 503);
  if (cache.rows && cache.url === url && Date.now() - cache.at < 60000) return cache.rows;
  let text;
  try { const r = await fetcher(url); if (!r.ok) throw new Error('bad'); text = await r.text(); } catch { fail('The sect pages could not be loaded right now. Try again in a minute.', 502); }
  const grid = parseCsv(text);
  const head = (grid[0] || []).map(h => h.trim().toLowerCase()), ix = n => head.indexOf(n);
  const cell = (r, n) => { const i = ix(n); return i >= 0 && i < r.length ? r[i].trim() : ''; };
  const rows = [];
  for (const r of grid.slice(1)) {
    const sect = norm(cell(r, 'sect')), section = norm(cell(r, 'section'));
    if (!sect || !section) continue;
    const order = Number.parseFloat(cell(r, 'order'));
    rows.push({ sect, section, title: cell(r, 'title'), text: cell(r, 'text'), order: Number.isFinite(order) ? order : 999 });
  }
  cache.at = Date.now(); cache.url = url; cache.rows = rows;
  return rows;
}

// Counts wrong guesses. A key stays blocked until its window runs out.
async function blocked(db, key, max) {
  const row = await db.prepare('SELECT hits FROM rate_limits WHERE key = ? AND expires > ?').bind(key, Date.now()).first();
  return !!row && row.hits >= max;
}
async function strike(db, key, windowMs) {
  const now = Date.now();
  await db.prepare('INSERT INTO rate_limits (key, hits, expires) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET hits = CASE WHEN expires < ? THEN 1 ELSE hits + 1 END, expires = CASE WHEN expires < ? THEN ? ELSE expires END')
    .bind(key, now + windowMs, now, now, now + windowMs).run();
}
const IP_FAILS = 10, SECT_FAILS = 100;   // wrong guesses allowed per hour from one address, and per day for one sect

export async function handleSects(request, db, path, { json, input, rate, ip, hashKey, extras }) {
  if (request.method !== 'POST' || path !== '/sects/open') fail('Endpoint not found.', 404);
  await rate(db, 'sect-open:' + ip, 30);
  const d = await input(request);
  const sect = norm(d.sect);
  const all = passwords(extras.sectPasswords);
  if (!all) fail('The sect pages are closed until the sect passwords are set in Cloudflare.', 503);
  const password = typeof all[sect] === 'string' ? all[sect] : '';
  if (!password) fail('That sect is not open.', 404);
  const ipKey = hashKey('sect-ip:' + ip), sectKey = hashKey('sect-day:' + sect);
  const usingToken = typeof d.token === 'string' && d.token.length > 0;   // a saved token can't be guessed, so it is never counted or locked out
  if (!usingToken && (await blocked(db, ipKey, IP_FAILS) || await blocked(db, sectKey, SECT_FAILS))) fail('Too many wrong passwords. Please wait a while and try again.', 429);
  const good = usingToken
    ? same(d.token, tokenFor(sect, password))
    : typeof d.password === 'string' && d.password.length > 0 && same(norm(d.password), norm(password));
  if (!good) {
    if (!usingToken) { await strike(db, ipKey, 3600000); await strike(db, sectKey, 86400000); }
    fail(usingToken ? 'Your saved entry no longer works. Enter the password again.' : 'That isn\'t right. Try again.', 401);
  }
  const rows = (await content(extras.sectContentUrl, extras.fetcher || fetch)).filter(r => r.sect === sect).map(({ section, title, text, order }) => ({ section, title, text, order }));
  return json({ sect, token: tokenFor(sect, password), rows });
}
