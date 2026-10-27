'use strict';
// Who may see or use a stash or sign: only people standing close to it (or the owner). The plugin reports where you stand.
// That is an honor system like the rest, but it stops anyone browsing for things to take.
import { fail } from './engine.mjs';

export const REACH = 15;     // how close you must be to open a stash or read a sign (the plugin asks for 10; this leaves room for lag)
export const NEARBY = 60;    // how far around you the list shows other people's stashes and signs

// Which house you are in: world, ward, plot and room joined into a short code, or '' when you are not in one.
export const roomOf = v => { if (v === undefined || v === null || v === '') return ''; if (typeof v !== 'string' || !/^[A-Za-z0-9:_-]{1,40}$/.test(v)) fail('That location is not valid.'); return v; };
const ok = n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100000;
// Where the caller says they are: ?t=territory&x=&y=&z= on a GET, or { at: { territory, x, y, z } } in a POST body. Null if missing or odd.
export function positionOf(url, body) {
  let raw = body && typeof body === 'object' ? body.at : null;
  if (!raw && url.searchParams.has('t')) raw = { territory: Number(url.searchParams.get('t')), room: url.searchParams.get('r') || '', x: Number(url.searchParams.get('x')), y: Number(url.searchParams.get('y')), z: Number(url.searchParams.get('z')) };
  if (!raw || !Number.isInteger(raw.territory) || !ok(raw.x) || !ok(raw.y) || !ok(raw.z)) return null;
  return { territory: raw.territory, room: typeof raw.room === 'string' ? raw.room : '', x: raw.x, y: raw.y, z: raw.z };
}
export const distance = (row, pos) => !pos || pos.territory !== row.territory || (pos.room || '') !== (row.room || '') ? Infinity : Math.hypot(row.x - pos.x, row.y - pos.y, row.z - pos.z);
export const isNear = (row, pos, range) => distance(row, pos) <= range;
export const mustBeNear = (row, pos, what) => { if (!isNear(row, pos, REACH)) fail(`Stand next to the ${what} to use it.`, 403); };
// How many stashes or signs are out there by zone, without saying where in the zone: [{ zone, count }].
export function zoneCounts(rows) {
  const by = new Map();
  for (const r of rows) { const z = r.zone || 'Somewhere'; by.set(z, (by.get(z) || 0) + 1); }
  return [...by].map(([zone, count]) => ({ zone, count })).sort((a, b) => a.zone.localeCompare(b.zone));
}
