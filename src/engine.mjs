'use strict';
import { randomInt, randomUUID, randomBytes, createHash } from 'node:crypto';
const KINDS = ['classic', 'lastStanding', 'spar', 'timed'];
const OOC_NOTE = '((Loot will be distributed by the SM in game after the encounter.))';
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
    location: '', notes: '', phase: 'setup', mode: 'random', kind: 'classic', minutes: 15, endsAt: null, result: null, drops: [], revision: 0,
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
function publicRoom(room, viewer = null, online = new Set()) {
  const dm = viewer?.role === 'dm';
  return { ...room, people: dm ? room.people : room.people.map(({ loot, ...rest }) => rest), members: room.members.map(({ tokenHash, ...m }) => ({ ...m, online: online.has(m.id) })), history: undefined, receipts: undefined, undoAvailable: room.history.length > 0 };
}
function log(room, message) { room.log.unshift({ id: randomUUID(), at: new Date().toISOString(), message }); room.log = room.log.slice(0, 250); }
function actor(room) { return room.people.find(p => p.id === room.order[room.index]); }
function canAct(room, member) {
  const p = actor(room);
  return room.phase === 'combat' && p && p.hp > 0 && (p.type === 'NPC' ? member.role === 'dm' : p.ownerId === member.id);
}
function snapshot(room) {
  room.history.push(structuredClone({ people: room.people, order: room.order, index: room.index, round: room.round, lastRoll: room.lastRoll, phase: room.phase, result: room.result, drops: room.drops }));
  room.history = room.history.slice(-30);
}
function arrange(room, mode) {
  const order = room.people.map(p => p.id);
  room.people.forEach(p => { delete p.initiative; });
  if (mode === 'manual') {
    if (new Set(room.people.map(p => p.number)).size !== room.people.length) fail('Every manual order number must be unique.');
    order.sort((a,b) => room.people.find(p => p.id === a).number - room.people.find(p => p.id === b).number);
  } else {
    for (let i = order.length - 1; i > 0; i--) { const j = randomInt(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  }
  room.order = order; room.index = Math.max(0, order.findIndex(id => room.people.find(p => p.id === id).hp > 0));
}
// Modifiers are set by the SM when a character is added and apply to every roll in the encounter: [{ label, value }].
function modifiers(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 6) fail('A character can have up to 6 modifiers.');
  return list.map(m => {
    if (!m || typeof m !== 'object') fail('Modifier details are missing.');
    return { label: text(m.label, 'Modifier name', 30), value: integer(m.value, 'Modifier', -99, 99) };
  }).filter(m => m.value !== 0);
}
const bonusOf = person => (person.mods || []).reduce((sum, m) => sum + m.value, 0);
const modText = person => (person.mods || []).map(m => `${m.value > 0 ? '+' : ''}${m.value} ${m.label}`).join(', ');
function participant(room, input) {
  if (!input || typeof input !== 'object') fail('Participant details are missing.');
  const max = integer(input.max, 'Maximum HP', 1, 99999), hp = integer(input.hp, 'HP', 0, max);
  if (!['Player','NPC'].includes(input.type)) fail('Choose Player or NPC.');
  const ownerId = input.type === 'NPC' ? null : input.ownerId || null;
  if (ownerId && !room.members.some(m => m.id === ownerId)) fail('Character owner is not in the room.');
  return { id: input.id || randomUUID(), name: text(input.name, 'Character name', 60), type: input.type, max, hp,
    number: integer(input.number, 'Order number', 1, 999), details: text(input.details || '', 'Details', 300, false), loot: text(input.loot || '', 'Loot', 200, false), ownerId, mods: modifiers(input.mods) };
}

const up = list => list.filter(p => p.hp > 0);
const draw = () => ({ reason: 'draw', headline: 'The encounter ends in a draw.', detail: 'Nobody is left standing.', winners: [] });
// Decides whether the encounter is over, and who won. Returns null while it is still going.
function evaluate(room, timeUp = false) {
  const players = room.people.filter(p => p.type === 'Player'), npcs = room.people.filter(p => p.type === 'NPC'), alive = up(room.people);
  if (room.kind === 'spar') {
    if (alive.length >= 2) return null;
    if (alive.length === 0) return draw();
    const loser = room.people.find(p => p.hp <= 0);
    return { reason: 'spar', headline: `${alive[0].name} wins the spar!`, detail: `${loser.name} went down first.`, winners: [alive[0].name] };
  }
  if (room.kind === 'lastStanding') {
    if (alive.length > 1) return null;
    if (alive.length === 0) return draw();
    return { reason: 'lastStanding', headline: `${alive[0].name} is the last one standing!`, detail: 'Every other participant has fallen.', winners: [alive[0].name] };
  }
  if (up(npcs).length === 0 && up(players).length === 0) return draw();
  if (up(npcs).length === 0) return { reason: 'enemiesDefeated', headline: 'Victory for the Players!', detail: 'All enemies have been defeated.', winners: players.map(p => p.name) };
  if (up(players).length === 0) return { reason: 'playersDown', headline: 'The NPCs are victorious!', detail: 'All players are down and cannot continue.', winners: up(npcs).map(p => p.name) };
  if (room.kind === 'timed' && timeUp) {
    const ph = players.reduce((a, p) => a + p.hp, 0), nh = npcs.reduce((a, p) => a + p.hp, 0);
    const detail = `Time ran out. Players had ${ph} HP left, NPCs had ${nh}.`;
    if (ph > nh) return { reason: 'time', headline: 'Time’s up! The Players win.', detail, winners: players.map(p => p.name) };
    if (nh > ph) return { reason: 'time', headline: 'Time’s up! The NPCs win.', detail, winners: npcs.map(p => p.name) };
    return { reason: 'time', headline: 'Time’s up! It is a draw.', detail, winners: [] };
  }
  return null;
}
function conclude(room, outcome) {
  room.phase = 'ended'; room.endsAt = null;
  room.result = { ...outcome, kind: room.kind, rounds: room.round, endedAt: new Date().toISOString(),
    standings: room.order.map(id => room.people.find(p => p.id === id)).filter(Boolean).map(p => ({ id: p.id, name: p.name, type: p.type, hp: p.hp, max: p.max })),
    loot: room.drops.map(d => ({ name: d.name, loot: d.loot })), note: room.drops.length ? OOC_NOTE : '' };
  log(room, `Encounter over · ${outcome.headline}`);
}
// Timed encounters end themselves when the clock runs out (checked whenever anyone looks at the room).
function expireIfDue(room) {
  if (room.phase !== 'combat' || !room.endsAt || Date.now() < Date.parse(room.endsAt)) return false;
  conclude(room, evaluate(room, true) || draw());
  room.revision++; room.updatedAt = new Date().toISOString();
  return true;
}
function advance(room) {
  for (let n = 1; n <= room.order.length; n++) {
    const i = (room.index + n) % room.order.length;
    if (room.people.find(x => x.id === room.order[i]).hp > 0) { const wraps = room.index + n >= room.order.length; room.index = i; if (wraps) room.round++; return true; }
  }
  return false;
}
function apply(room, member, command, boosts = []) {
  if (!command || typeof command !== 'object' || !/^[a-f0-9-]{36}$/i.test(command.actionId || '')) fail('Action identifier is required.');
  const receipt = `${member.id}:${command.actionId}`;
  if (room.receipts.includes(receipt)) return false;
  if (command.revision !== room.revision) fail('The encounter changed. Review the latest state and try again.', 409);
  const dm = () => { if (member.role !== 'dm') fail('Only the encounter creator (SM) may do that.', 403); };
  const combat = () => { if (room.phase === 'ended') fail('The encounter is over.'); if (room.phase !== 'combat') fail('Start the encounter first.'); };
  const setup = () => { dm(); if (room.phase === 'ended') fail('The encounter is over.'); if (room.phase !== 'setup') fail('Return to setup to edit the cast.'); };
  const { type, payload: p = {} } = command;
  switch (type) {
    case 'settings':
      setup(); room.name = text(p.name, 'Encounter name', 90); room.location = text(p.location || '', 'Location', 90, false);
      room.notes = text(p.notes || '', 'Scene notes', 1000, false);
      if (!['random','manual'].includes(p.mode)) fail('Invalid turn order method.');
      { const kind = p.kind ?? room.kind, minutes = p.minutes ?? room.minutes;
        if (!KINDS.includes(kind)) fail('Invalid encounter type.');
        room.kind = kind; room.minutes = integer(minutes, 'Minutes', 1, 180); }
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
      if (room.kind === 'spar' && room.people.length !== 2) fail('A spar needs exactly two participants.');
      if ((room.kind === 'classic' || room.kind === 'timed') && (!room.people.some(x => x.type === 'Player' && x.hp > 0) || !room.people.some(x => x.type === 'NPC' && x.hp > 0))) fail('This encounter type needs at least one player and one NPC with HP.');
      arrange(room, room.mode); room.phase = 'combat'; room.round = 1; room.history = []; room.lastRoll = null; room.drops = []; room.result = null;
      room.endsAt = room.kind === 'timed' ? new Date(Date.now() + room.minutes * 60000).toISOString() : null;
      log(room, `Encounter begins · ${{ classic: 'Classic', lastStanding: 'Last one standing', spar: 'Spar', timed: `Timed (${room.minutes} min)` }[room.kind]}. ${actor(room).name} acts first.`); break;
    case 'roll': {
      combat(); if (!canAct(room, member)) fail('Only this character’s owner may roll. The SM controls NPCs.', 403);
      if (![4,6,8,10,12,20,100].includes(p.sides)) fail('Choose a standard D&D die.');
      if (!['attack','heal'].includes(p.kind)) fail('Choose attack or heal.');
      const target = room.people.find(x => x.id === p.targetId); if (!target) fail('Choose a valid target.');
      const source = actor(room);
      snapshot(room); const raw = randomInt(1, p.sides + 1), before = target.hp;
      // Statuses on the roller's RP account add to their own rolls (the server looked them up; they only count for the character the roller owns).
      const owned = source.type === 'Player' && source.ownerId === member.id;
      const extra = owned ? boosts.map(b => ({ label: b.label, value: p.kind === 'heal' ? b.heal : b.atk })).filter(m => m.value !== 0) : [];
      const rolling = { mods: [...(source.mods || []), ...extra] };
      const bonus = bonusOf(rolling), total = Math.max(1, raw + bonus);   // modifiers add to the roll, which never goes below 1
      target.hp = Math.max(0, Math.min(target.max, target.hp + (p.kind === 'heal' ? total : -total)));
      room.lastRoll = { actorId: source.id, targetId: target.id, kind: p.kind, sides: p.sides, raw, bonus, mods: structuredClone(rolling.mods), total, applied: Math.abs(before - target.hp), before, after: target.hp };
      log(room, `${source.name} → ${target.name}: ${p.kind === 'heal' ? 'heals' : 'attacks'} for ${room.lastRoll.applied} HP (d${p.sides}: ${raw}${bonus || rolling.mods.length ? `, ${modText(rolling)} = ${total}` : ''}). ${before} → ${target.hp} HP.`);
      if (before > 0 && target.hp === 0) {
        log(room, `${target.name} is down.`);
        if (target.loot) { room.drops.push({ personId: target.id, name: target.name, loot: target.loot }); log(room, `${target.name} dropped loot: ${target.loot}`); }
      }
      if (before === 0 && target.hp > 0) room.drops = room.drops.filter(d => d.personId !== target.id);
      const outcome = evaluate(room);
      if (outcome) conclude(room, outcome);
      else if (advance(room)) log(room, `${actor(room).name}’s turn · Round ${room.round}.`);   // one roll per turn
      break;
    }
    case 'next': {
      combat(); if (member.role !== 'dm' && !canAct(room, member)) fail('Only the current player or SM can advance the turn.', 403);
      snapshot(room);
      if (!advance(room)) { room.history.pop(); fail('All characters are downed. The SM can undo or return to setup.'); }
      log(room, `${actor(room).name}’s turn · Round ${room.round}.`); break;
    }
    case 'undo':
      dm(); if (room.phase === 'setup') fail('Start the encounter first.');
      if (room.phase === 'ended' && room.result?.reason === 'time') fail('Time ran out, so this encounter cannot be undone.');
      if (!room.history.length) fail('There is no action to undo.'); Object.assign(room, room.history.pop()); log(room, 'SM restored the previous combat state.'); break;
    case 'setup': dm(); if (room.phase === 'ended') fail('The encounter is over. Close it when you are done.'); room.phase = 'setup'; room.history = []; room.endsAt = null; room.drops = []; room.result = null; log(room, 'SM reopened encounter setup. Current HP is retained.'); break;
    default: fail('Unknown action.');
  }
  room.revision++; room.updatedAt = new Date().toISOString(); room.receipts.push(receipt); room.receipts = room.receipts.slice(-300);
  return true;
}
export { makeRoom, makeMember, authenticate, publicRoom, apply, log, fail, canAct, expireIfDue };
