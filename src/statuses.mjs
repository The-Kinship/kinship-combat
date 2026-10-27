'use strict';
// Status tab: see everyone's statuses, add flavor statuses to yourself, remove them. Putting one on someone else only happens through an item
// (or an Advocate with the creation password), so nobody can pester another member.
import { fail } from './engine.mjs';
import { randomInt } from 'node:crypto';
import { who, str } from './items.mjs';
import { applyStatus, bonus, combatTotals, MAX_STATUS } from './status-core.mjs';

const ICON = /^(game:\d{1,7}|site:[A-Za-z0-9._-]{1,60})$/;
function fields(d) {
  const name = str(d.name, 'Status name', 30), description = str(d.description, 'Description', 200, false);
  const icon = str(d.icon, 'Icon', 80);
  if (!ICON.test(icon)) fail('Choose an icon for the status.');
  const minutes = d.minutes === undefined || d.minutes === null ? 0 : d.minutes;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 43200) fail('A status can last from 1 minute to 30 days. Use 0 to last until removed.');
  return { name, description, icon, minutes, isDebuff: d.isDebuff === true };
}
const ICON_COMBAT = 'game:10205';
const SELECT = 'SELECT s.*, m.name AS member_name FROM statuses s JOIN members m ON m.id = s.member_id';
const view = (r, meId, now) => ({
  id: r.id, memberName: r.member_name, name: r.name, icon: r.icon, description: r.description, isDebuff: !!r.is_debuff,
  secondsLeft: r.expires_at ? Math.max(0, Math.floor((Date.parse(r.expires_at) - now) / 1000)) : null,
  mine: r.member_id === meId, canRemove: r.member_id === meId || r.source_id === meId,
  atkBonus: r.atk_bonus || 0, healBonus: r.heal_bonus || 0,
  self: r.member_id === meId && r.source_id === 'self',
});

export async function handleStatuses(request, db, path, { json, input, rate, ip, checkCreate }) {
  const post = request.method === 'POST';

  if (post && path.startsWith('/statuses/admin/')) {
    await rate(db, 'status-admin:' + ip, 30);
    const d = await input(request); checkCreate(d.adminPassword);
    if (path === '/statuses/admin/add') {
      const to = await db.prepare('SELECT id, name FROM members WHERE name_key = ?').bind(str(d.to, 'Member', 40).toLowerCase().replace(/\s+/g, ' ')).first();
      if (!to) fail('No member has that name.', 404);
      const type = d.statusType === undefined || d.statusType === null ? '' : d.statusType;
      if (!['', 'sickness', 'curse'].includes(type)) fail('A status can be a sickness, a curse, or neither.');
      await applyStatus(db, to.id, { ...fields(d), type, cure: str(d.cureInfo, 'Cure information', 200, false), sourceId: 'dm', holderName: to.name, atk: bonus(d.atkBonus, 'Attack bonus'), heal: bonus(d.healBonus, 'Heal bonus') });
      return json({ added: true, to: to.name }, 201);
    }
    if (path === '/statuses/admin/remove') {
      const r = await db.prepare('DELETE FROM statuses WHERE id = ?').bind(str(d.statusId, 'Status', 20)).run();
      if (r.meta.changes !== 1) fail('That status is already gone.', 404);
      return json({ removed: true });
    }
    fail('Endpoint not found.', 404);
  }

  const me = await who(db, request);

  if (!post && path === '/statuses') {
    const now = Date.now();
    const { results } = await db.prepare(SELECT + ' WHERE (s.expires_at IS NULL OR s.expires_at > ?) ORDER BY m.name_key, s.created_at LIMIT 300').bind(new Date(now).toISOString()).all();
    // Roll bonuses from items, gear and statuses are also shown added together as one Combat Buff and one Combat Debuff.
    const combined = (await combatTotals(db)).map(c => ({
      id: `combat-${c.kind}-${c.memberId}`, memberName: c.name, name: c.kind === 'buff' ? 'Combat Buff' : 'Combat Debuff', icon: ICON_COMBAT, isDebuff: c.kind === 'debuff',
      description: 'All bonuses to rolls added together: statuses, items and worn gear.', secondsLeft: null, mine: c.memberId === me.id, canRemove: false, atkBonus: c.atk, healBonus: c.heal, self: false, combined: true,
    }));
    return json({ statuses: results.map(r => view(r, me.id, now)).concat(combined), maxStatuses: MAX_STATUS });
  }
  if (post && path === '/statuses/self') {
    await rate(db, 'status-self:' + me.id, 20);
    await applyStatus(db, me.id, { ...fields(await input(request)), sourceId: 'self' });
    return json({ added: true }, 201);
  }
  if (post && path === '/statuses/diagnose') {
    await rate(db, 'diagnose:' + me.id, 20);
    const d = await input(request);
    const kind = d.kind;
    if (kind !== 'sickness' && kind !== 'curse') fail('Choose what kind of reading to do.');
    const patient = await db.prepare('SELECT id, name FROM members WHERE name_key = ?').bind(str(d.patient, 'Patient', 40).toLowerCase().replace(/\s+/g, ' ')).first();
    if (!patient) fail('No member has that name.', 404);
    const roll = 1 + randomInt(20);
    const found = await db.prepare('SELECT name, st_cure FROM statuses WHERE member_id = ? AND st_type = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at LIMIT 1').bind(patient.id, kind, new Date().toISOString()).first();
    const ok = roll >= 15 && !!found;
    return json({ roll, patient: patient.name, success: ok, condition: ok ? found.name : '', cure: ok ? found.st_cure : '' });
  }
  const m = path.match(/^\/statuses\/([a-f0-9]{12})\/remove$/);
  if (!m || !post) fail('Endpoint not found.', 404);
  const row = await db.prepare('SELECT member_id, source_id FROM statuses WHERE id = ?').bind(m[1]).first();
  if (!row) fail('That status is already gone.', 404);
  if (row.member_id !== me.id && row.source_id !== me.id) fail('Only the person who has a status, or whoever gave it, can remove it.', 403);
  await db.prepare('DELETE FROM statuses WHERE id = ?').bind(m[1]).run();
  return json({ removed: true });
}
