'use strict';
import { randomInt, randomUUID, randomBytes, createHash } from 'node:crypto';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const hash = token => createHash('sha256').update(token).digest('hex');
function text(value, name, max, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${name} is required and must be at most ${max} characters.`);
  return value.trim();
}
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${name} must be a whole number from ${min} to ${max}.`);
  return value;
}
function makeMember(name, role) {
  const token = randomBytes(32).toString('hex');
  return { member: { id: randomUUID(), name: text(name, 'Name', 60), role, tokenHash: hash(token) }, token };
}
function makeRoom(name, encounter) {
  const { member, token } = makeMember(name, 'dm');
  return { token, memberId: member.id, room: {
    code: randomBytes(9).toString('hex').toUpperCase(), name: text(encounter, 'Encounter name', 90),
    location: '', notes: '', phase: 'setup', mode: 'random', revision: 0,
    members: [member], people: [], order: [], index: 0, round: 1, log: [], history: [], receipts: [], lastRoll: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  } };
}
function authenticate(room, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail('Sign in to this room again.', 401);
  const member = room.members.find(m => m.tokenHash === hash(token));
  if (!member) fail('Room credentials are invalid.', 401);
  return member;
}
function publicRoom(room, online = new Set()) {
  return { ...room, members: room.members.map(({ tokenHash, ...m }) => ({ ...m, online: online.has(m.id) })), history: undefined, receipts: undefined, undoAvailable: room.history.length > 0 };
}
function log(room, message) { room.log.unshift({ id: randomUUID(), at: new Date().toISOString(), message }); room.log = room.log.slice(0, 250); }
function actor(room) { return room.people.find(p => p.id === room.order[room.index]); }
function canAct(room, member) {
  const p = actor(room);
  return room.phase === 'combat' && p && p.hp > 0 && (p.type === 'NPC' ? member.role === 'dm' : p.ownerId === member.id);
}
function snapshot(room) {
  room.history.push(structuredClone({ people: room.people, order: room.order, index: room.index, round: room.round, lastRoll: room.lastRoll }));
  room.history = room.history.slice(-30);
}
function arrange(room, mode) {
  const order = room.people.map(p => p.id);
  room.people.forEach(p => { delete p.initiative; });
  if (mode === 'manual') {
    if (new Set(room.people.map(p => p.number)).size !== room.people.length) fail('Every manual order number must be unique.');
    order.sort((a,b) => room.people.find(p => p.id === a).number - room.people.find(p => p.id === b).number);
  } else if (mode === 'initiative') {
    room.people.forEach(p => { p.initiative = randomInt(1, 21); });
    order.sort((a,b) => room.people.find(p => p.id === b).initiative - room.people.find(p => p.id === a).initiative);
  } else {
    for (let i = order.length - 1; i > 0; i--) { const j = randomInt(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  }
  room.order = order; room.index = Math.max(0, order.findIndex(id => room.people.find(p => p.id === id).hp > 0));
}
function participant(room, input) {
  if (!input || typeof input !== 'object') fail('Participant details are missing.');
  const max = integer(input.max, 'Maximum HP', 1, 99999), hp = integer(input.hp, 'HP', 0, max);
  if (!['Player','NPC'].includes(input.type)) fail('Choose Player or NPC.');
  const ownerId = input.type === 'NPC' ? null : input.ownerId || null;
  if (ownerId && !room.members.some(m => m.id === ownerId)) fail('Character owner is not in the room.');
  return { id: input.id || randomUUID(), name: text(input.name, 'Character name', 60), type: input.type, max, hp,
    number: integer(input.number, 'Order number', 1, 999), details: text(input.details || '', 'Details', 300, false), ownerId };
}
function apply(room, member, command) {
  if (!command || typeof command !== 'object' || !/^[a-f0-9-]{36}$/i.test(command.actionId || '')) fail('Action identifier is required.');
  const receipt = `${member.id}:${command.actionId}`;
  if (room.receipts.includes(receipt)) return false;
  if (command.revision !== room.revision) fail('The encounter changed. Review the latest state and try again.', 409);
  const dm = () => { if (member.role !== 'dm') fail('Only the encounter creator (DM) may do that.', 403); };
  const combat = () => { if (room.phase !== 'combat') fail('Start the encounter first.'); };
  const setup = () => { dm(); if (room.phase !== 'setup') fail('Return to setup to edit the cast.'); };
  const { type, payload: p = {} } = command;
  switch (type) {
    case 'settings':
      setup(); room.name = text(p.name, 'Encounter name', 90); room.location = text(p.location || '', 'Location', 90, false);
      room.notes = text(p.notes || '', 'Scene notes', 1000, false);
      if (!['random','manual','initiative'].includes(p.mode)) fail('Invalid turn order method.');
      room.mode = p.mode; break;
    case 'participant': {
      setup(); if (!p.id && room.people.length >= 40) fail('An encounter supports up to 40 participants.');
      if (p.id && !room.people.some(x => x.id === p.id)) fail('Participant not found.', 404);
      const person = participant(room, p), index = room.people.findIndex(x => x.id === person.id);
      if (index >= 0) room.people[index] = person; else room.people.push(person);
      break;
    }
    case 'remove': setup(); room.people = room.people.filter(x => x.id !== p.id); break;
    case 'assign': {
      dm(); const person = room.people.find(x => x.id === p.id);
      if (!person || person.type !== 'Player') fail('Choose a player character.');
      if (p.ownerId && !room.members.some(x => x.id === p.ownerId)) fail('Player has not joined.');
      person.ownerId = p.ownerId || null; log(room, `${person.name} is ${person.ownerId ? 'assigned to '+room.members.find(x => x.id === person.ownerId).name : 'unassigned'}.`); break;
    }
    case 'start':
      setup(); if (room.people.length < 2 || !room.people.some(x => x.hp > 0)) fail('Add at least two characters, including one with HP.');
      if (room.people.some(x => x.type === 'Player' && !x.ownerId)) fail('Assign each player character to a room member before starting.');
      arrange(room, room.mode); room.phase = 'combat'; room.round = 1; room.history = []; room.lastRoll = null;
      log(room, `Encounter begins · ${room.mode} order. ${actor(room).name} acts first.`); break;
    case 'roll': {
      combat(); if (!canAct(room, member)) fail('Only this character’s owner may roll. The DM controls NPCs.', 403);
      if (![4,6,8,10,12,20,100].includes(p.sides)) fail('Choose a standard D&D die.');
      integer(p.modifier, 'Modifier', -100, 100);
      if (!['attack','heal'].includes(p.kind)) fail('Choose attack or heal.');
      const target = room.people.find(x => x.id === p.targetId); if (!target) fail('Choose a valid target.');
      snapshot(room); const raw = randomInt(1, p.sides + 1), total = Math.max(0, raw + p.modifier), before = target.hp;
      target.hp = Math.max(0, Math.min(target.max, target.hp + (p.kind === 'heal' ? total : -total)));
      room.lastRoll = { actorId: actor(room).id, targetId: target.id, kind: p.kind, sides: p.sides, modifier: p.modifier, raw, total, applied: Math.abs(before - target.hp), before, after: target.hp };
      log(room, `${actor(room).name} → ${target.name}: ${p.kind === 'heal' ? 'heals' : 'attacks'} for ${room.lastRoll.applied} HP (d${p.sides}: ${raw}${p.modifier >= 0 ? '+' : ''}${p.modifier}). ${before} → ${target.hp} HP.`); break;
    }
    case 'next': {
      combat(); if (member.role !== 'dm' && !canAct(room, member)) fail('Only the current player or DM can advance the turn.', 403);
      let next = null;
      for (let n = 1; n <= room.order.length; n++) { const i = (room.index + n) % room.order.length; if (room.people.find(x => x.id === room.order[i]).hp > 0) { next = { i, wraps: room.index + n >= room.order.length }; break; } }
      if (!next) fail('All characters are downed. The DM can undo or return to setup.');
      snapshot(room); room.index = next.i; if (next.wraps) room.round++;
      log(room, `${actor(room).name}’s turn · Round ${room.round}.`); break;
    }
    case 'initiative':
      dm(); combat(); snapshot(room); arrange(room, 'initiative');
      log(room, 'Initiative rerolled · '+room.order.map(id => { const x = room.people.find(p => p.id === id); return `${x.name}: ${x.initiative}`; }).join(' · ')); break;
    case 'undo':
      dm(); combat(); if (!room.history.length) fail('There is no action to undo.'); Object.assign(room, room.history.pop()); log(room, 'DM restored the previous combat state.'); break;
    case 'setup': dm(); room.phase = 'setup'; room.history = []; log(room, 'DM reopened encounter setup. Current HP is retained.'); break;
    default: fail('Unknown action.');
  }
  room.revision++; room.updatedAt = new Date().toISOString(); room.receipts.push(receipt); room.receipts = room.receipts.slice(-300);
  return true;
}
export { makeRoom, makeMember, authenticate, publicRoom, apply, log, fail, canAct };
