'use strict';
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let seenDrops=0,clockTimer=null,credentials=null,room=null,live=false,pending=false,mode='create',step=0,action='attack',streamGeneration=0,dirty=false,localHidden=false,localMini=false,editingId=null,toastTimer;
const me=()=>room?.members.find(m=>m.id===credentials?.memberId),isDM=()=>me()?.role==='dm',actor=()=>room?.people.find(p=>p.id===room.order[room.index]);
const canAct=()=>room?.phase==='combat'&&actor()?.hp>0&&(actor().type==='NPC'?isDM():actor().ownerId===me()?.id);
function toast(t){$('toast').textContent=t;$('toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),4500)}
function banner(t){$('banner').textContent=t;$('banner').classList.toggle('hidden',!t)}
function saved(){try{return JSON.parse(localStorage.getItem('ultrarp-web-session'))}catch{return null}}
function saveCredentials(){try{localStorage.setItem('ultrarp-web-session',JSON.stringify(credentials))}catch{toast('This browser could not save your room identity. Keep this tab open.')}}
async function request(path,{data,auth=true}={}){
 const response=await fetch('/api'+path,{method:data===undefined?'GET':'POST',headers:{...(data!==undefined?{'Content-Type':'application/json'}:{}),...(auth?{Authorization:'Bearer '+credentials.token}:{})},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(15000),cache:'no-store'});
 let result;try{result=await response.json()}catch{throw Error('The website could not load this encounter. Please retry.')}
 if(!response.ok)throw Object.assign(Error(result.error||'Request failed.'),{status:response.status});return result;
}
function setLive(v){const changed=live!==v;live=v;$('liveStatus').innerHTML=`<i class="dot ${v?'live':''}"></i>${v?'Synced':room?'Reconnecting…':'Ready to play'}`;if(room&&changed)render()}
function receive(next){if(!next?.members||!next?.people)throw Error('Invalid encounter response.');if(room&&next.revision<=room.revision)return;const changed=room&&next.revision>room.revision;const first=!room;room=next;if(first)seenDrops=(next.drops||[]).length;render();dropToasts();if(changed){$('panel').classList.remove('flash');void $('panel').offsetWidth;$('panel').classList.add('flash')}}
async function watch(){const generation=++streamGeneration;let retry=2000;while(credentials&&generation===streamGeneration){const session=credentials;try{const result=await request(`/rooms/${session.code}`);if(generation!==streamGeneration||credentials!==session)return;receive(result.room);setLive(true);banner('');retry=2000}catch(error){if(generation!==streamGeneration)return;setLive(false);banner('Connection interrupted. Actions are paused while Kinship Combat reconnects.');if([401,404].includes(error.status)){banner(error.status===404?'This encounter was closed by the DM.':error.message);return}retry=Math.min(15000,retry*2)}await new Promise(r=>setTimeout(r,document.hidden?Math.max(10000,retry):retry))}}
async function command(type,payload={}){if(pending||!live){toast('Wait for the encounter to reconnect.');return false}const session=credentials;pending=true;render();try{const result=await request(`/rooms/${session.code}/actions`,{data:{type,payload,revision:room.revision,actionId:crypto.randomUUID()}});if(credentials!==session)return false;receive(result.room);return true}catch(error){if(credentials!==session)return false;if(error.status===409){try{receive((await request(`/rooms/${session.code}`)).room)}catch{}}toast(error.message);return false}finally{if(credentials===session){pending=false;render()}}}
function enter(result){credentials={token:result.token||credentials.token,memberId:result.memberId,code:result.room.code};saveCredentials();room=null;seenDrops=0;dirty=false;step=0;localHidden=false;localMini=false;$('connectPage').classList.add('hidden');$('sessionPage').classList.remove('hidden');$('disconnect').classList.remove('hidden');receive(result.room);setLive(true);watch()}
function roomCode(value){let code=value.trim();if(/^https?:/i.test(code)){try{code=new URL(code).searchParams.get('room')||''}catch{}}code=code.replace(/[\s-]/g,'').toUpperCase();if(!/^[A-F0-9]{18}$/.test(code))throw Error('Enter your DM’s 18-character room code or invite link.');return code}
function setConnectMode(v){mode=v;$('createTab').classList.toggle('selected',v==='create');$('joinTab').classList.toggle('selected',v==='join');$('encounterField').classList.toggle('hidden',v!=='create');$('codeField').classList.toggle('hidden',v!=='join');$('roomCode').required=v==='join';$('encounterName').required=v==='create';$('connectButton').textContent=v==='create'?'Create encounter →':'Join encounter →'}
$('createTab').onclick=()=>setConnectMode('create');$('joinTab').onclick=()=>setConnectMode('join');
$('connectForm').onsubmit=async e=>{e.preventDefault();$('connectButton').disabled=true;$('connectError').textContent='';try{const code=mode==='join'?roomCode($('roomCode').value):null;const last=saved();if(code&&last?.code===code){credentials=last;enter(await request(`/rooms/${code}`));return}credentials={};const result=await request(mode==='create'?'/rooms':`/rooms/${code}/join`,{auth:false,data:{name:$('displayName').value.trim(),...(mode==='create'?{encounter:$('encounterName').value.trim()}:{})}});enter(result)}catch(error){$('connectError').textContent=error.message}finally{$('connectButton').disabled=false}};
$('resume').onclick=async()=>{$('resume').disabled=true;try{credentials=saved();if(!credentials?.token)throw Error('No saved encounter in this browser.');enter(await request(`/rooms/${credentials.code}`))}catch(error){$('connectError').textContent=error.message}finally{$('resume').disabled=false}};
$('disconnect').onclick=()=>{streamGeneration++;room=null;credentials=null;live=false;pending=false;banner('');setLive(false);for(const id of ['personDialog','confirmDialog','inviteDialog'])$(id).close();$('sessionPage').classList.add('hidden');$('connectPage').classList.remove('hidden');$('disconnect').classList.add('hidden');$('resume').classList.toggle('hidden',!saved()?.token);document.title='Kinship Combat · Shared Encounter Table'};

function render() {
  if (!room) return;
  const dm = isDM(), unlocked = live && !pending, editable = dm && unlocked;
  const dmMember = room.members.find(m => m.role === 'dm');
  $('identity').textContent = `${me()?.name || 'Member'} · ${dm ? 'DM / encounter creator' : 'Player'} · DM: ${dmMember?.name || 'Host'}`;
  $('sessionName').textContent = room.name; $('phase').textContent = room.phase === 'combat' ? 'IN COMBAT' : room.phase === 'ended' ? 'ENCOUNTER OVER' : 'SETTING UP'; $('inviteCode').textContent = room.code;
  $('members').innerHTML = room.members.map(m => `<span class="memberChip">${esc(m.name)}${m.role === 'dm' ? ' · DM' : ''}</span>`).join('');
  $('hostingStatus').textContent = 'Saved online · Changes sync automatically across browsers';
  $('wizard').classList.toggle('hidden', room.phase !== 'setup'); $('play').classList.toggle('hidden', room.phase !== 'combat'); $('ended').classList.toggle('hidden', room.phase !== 'ended');
  $('editEncounter').classList.toggle('hidden', !dm || room.phase !== 'combat'); $('editEncounter').disabled = !editable;
  $('restore').classList.toggle('hidden', room.phase !== 'combat'); tickClock();
  if (room.phase === 'setup') renderSetup(editable); else if (room.phase === 'ended') renderEnded(unlocked, editable); else renderCombat(unlocked, editable);
}
function ownerOptions(selected) {
  return '<option value="">Unassigned · waiting for player</option>'+room.members.map(m => `<option value="${m.id}" ${selected === m.id ? 'selected' : ''}>${esc(m.name)}${m.role === 'dm' ? ' (DM’s own character)' : ''}</option>`).join('');
}
function renderSetup(editable) {
  $('setupRoleHint').textContent = isDM() ? 'You created this room. Build the cast and assign player characters to joined members.' : 'The DM is preparing the encounter. You can review the shared setup while you wait.';
  if (!dirty) { $('encName').value = room.name; $('location').value = room.location; $('notes').value = room.notes; $('orderMode').value = room.mode; $('kind').value = room.kind || 'classic'; $('minutes').value = room.minutes || 15; }
  $('minutesField').classList.toggle('hidden', $('kind').value !== 'timed'); $('kindHint').textContent = KIND_HINTS[$('kind').value];
  ['encName','location','notes','orderMode','kind','minutes','sample','add'].forEach(id => $(id).disabled = !editable);
  $('sample').classList.toggle('hidden', !isDM()); $('add').classList.toggle('hidden', !isDM());
  [0,1,2].forEach(i => { $('step'+i).classList.toggle('hidden', step !== i); $('s'+i).classList.toggle('active', step === i); });
  $('rows').innerHTML = room.people.map(p => `<div class="rosterRow"><div><strong>${esc(p.name)}</strong><div class="sub">${esc(p.details)}</div></div><span class="tag">${p.type}</span><span>${p.hp} / ${p.max} HP<div class="sub">Order ${p.number}${p.loot ? ' · Loot: '+esc(p.loot) : ''}</div></span><div>${p.type === 'NPC' ? '<span class="muted">DM controlled</span>' : `<select aria-label="Owner of ${esc(p.name)}" data-assign="${p.id}" ${!editable ? 'disabled' : ''}>${ownerOptions(p.ownerId)}</select>`}</div><div>${isDM() ? `<button class="small" data-edit="${p.id}" ${!editable ? 'disabled' : ''}>Edit</button> <button class="small quiet" data-remove="${p.id}" ${!editable ? 'disabled' : ''} aria-label="Remove ${esc(p.name)}">×</button>` : ''}</div></div>`).join('') || '<p class="muted" style="padding:22px 0">The cast is waiting to be written. Add your first character.</p>';
  const ordered = [...room.people]; if ($('orderMode').value === 'manual') ordered.sort((a,b) => a.number-b.number);
  $('orderRows').innerHTML = ordered.map(p => `<div class="reviewItem"><strong>${esc(p.name)}</strong><p class="details">${$('orderMode').value === 'manual' ? 'Order '+p.number : 'Assigned at start'} · ${p.type}</p></div>`).join('');
  $('stepLabel').textContent = `Step ${step+1} of 3`; $('back').disabled = step === 0 || pending;
  $('next').textContent = step === 2 ? (isDM() ? 'Begin encounter →' : 'Waiting for DM') : (isDM() ? 'Save & continue →' : 'Review next →');
  $('next').disabled = pending || (isDM() && !live) || (!isDM() && step === 2);
}
function renderCombat(unlocked, editable) {
  const p = actor(); if (!p) return;
  $('playTitle').textContent = room.name; $('playLocation').textContent = room.location; $('sceneNotes').textContent = room.notes;
  $('round').textContent = `ROUND ${room.round} · TURN ${room.index+1} / ${room.order.length}`;
  $('actor').textContent = p.name; $('miniStatus').textContent = `· Round ${room.round} · ${p.name}`;
  for (const [type, id] of [['Player','players'],['NPC','npcs']]) {
    $(id).innerHTML = room.order.map(id => room.people.find(x => x.id === id)).filter(x => x.type === type).map(x => {
      const owner = room.members.find(m => m.id === x.ownerId);
      return `<article class="card ${type === 'NPC' ? 'npc' : ''} ${x.id === p.id ? 'current' : ''}"><div class="cardHead"><strong>${esc(x.name)}</strong><span class="muted">${room.order.indexOf(x.id)+1}</span></div><div class="hp"><i style="width:${x.hp/x.max*100}%"></i></div><div class="cardHead"><span style="color:${type === 'NPC' ? 'var(--red)' : 'var(--green)'}">${x.hp} <span class="muted">/ ${x.max} HP</span></span><span class="details">${x.hp === 0 ? 'Downed' : ''}</span></div><p class="details">${esc(x.details)}</p><p class="details">${type === 'NPC' ? 'DM controlled' : 'Player · '+esc(owner?.name || 'Unassigned')}</p></article>`;
    }).join('') || '<p class="muted">No characters</p>';
  }
  const old = $('target').value;
  $('target').innerHTML = room.people.map(x => `<option value="${x.id}">${esc(x.name)} · ${x.hp}/${x.max}</option>`).join('');
  $('target').value = room.people.some(x => x.id === old) ? old : (room.people.find(x => x.id !== p.id && x.hp > 0 && (room.kind === 'lastStanding' || room.kind === 'spar' || x.type !== p.type)) || room.people.find(x => x.id !== p.id) || room.people[0]).id;
  const allowed = unlocked && canAct();
  ['roll','attack','heal','target','dice'].forEach(id => $(id).disabled = !allowed);
  $('endTurn').disabled = !unlocked || !(isDM() || canAct()); $('undo').disabled = !editable || !room.undoAvailable;
  const owner = room.members.find(m => m.id === p.ownerId);
  $('permission').textContent = !live ? 'Reconnecting · actions paused.' : p.hp === 0 ? 'Current character is downed. Advance to continue.' : canAct() ? (p.type === 'NPC' ? 'DM · You control this NPC.' : 'Your character’s turn. Choose your action.') : p.type === 'NPC' ? 'NPC turn · Waiting for the DM.' : `Waiting for ${owner?.name || 'the assigned player'} to act.`;
  $('dieResult').textContent = room.lastRoll?.raw ?? '—';
  $('result').textContent = room.lastRoll ? (room.log.find(l => l.message.includes('HP (d'))?.message || 'Last roll applied to shared HP.') : 'Rolls are generated by the server and shown to everyone.';
  // A stable roll description also survives log changes and undo.
  if (room.lastRoll) { const r = room.lastRoll, source = room.people.find(x => x.id === r.actorId), target = room.people.find(x => x.id === r.targetId); $('result').textContent = `${source?.name} → ${target?.name}: ${r.kind === 'heal' ? 'heals' : 'attacks'} for ${r.applied} HP. d${r.sides}: ${r.raw}. ${r.before} → ${r.after} HP.`; }
  $('log').innerHTML = room.log.map(l => `<div class="event"><time>${esc(new Date(l.at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }))}</time><span>${esc(l.message)}</span></div>`).join('');
  let next; for (let n = 1; n <= room.order.length; n++) { const x = room.people.find(x => x.id === room.order[(room.index+n)%room.order.length]); if (x.hp > 0) { next = x; break; } }
  $('upNext').textContent = next ? 'Up next · '+next.name : 'All characters are downed. The DM can undo or edit setup.';
  $('panel').classList.toggle('hidden', localHidden); $('panel').classList.toggle('mini', localMini); $('minimize').textContent = localMini ? '□' : '−';
  document.title = `${canAct() ? 'Your turn · ' : ''}Kinship Combat · ${room.name}`;
}
function settings() { return { name: $('encName').value.trim(), location: $('location').value, notes: $('notes').value, mode: $('orderMode').value, kind: $('kind').value, minutes: Number($('minutes').value) || 15 }; }
async function saveSettings() { const ok = await command('settings', settings()); if (ok) dirty = false; return ok; }

['encName','location','notes','orderMode','kind','minutes'].forEach(id => $(id).addEventListener('input', () => { dirty = true; if (room?.phase === 'setup') renderSetup(isDM() && live && !pending); }));
[0,1,2].forEach(i => $('s'+i).onclick = () => { step = i; render(); });
$('back').onclick = () => { step = Math.max(0, step-1); render(); };
$('next').onclick = async () => {
  $('setupError').textContent = '';
  if (!isDM()) { step = Math.min(2, step+1); render(); return; }
  if (!await saveSettings()) return;
  if (step < 2) { step++; render(); } else await command('start');
};
function editPerson(person = null) {
  if (!isDM()) return; editingId = person?.id || null; $('personTitle').textContent = person ? 'Edit participant' : 'Add participant';
  $('personName').value = person?.name || ''; $('personType').value = person?.type || 'Player'; $('personOwner').innerHTML = ownerOptions(person?.ownerId);
  $('personHp').value = person?.hp ?? 40; $('personMax').value = person?.max ?? 40; $('personNumber').value = person?.number ?? room.people.length+1;
  $('personDetails').value = person?.details || ''; $('personLoot').value = person?.loot || ''; $('personError').textContent = ''; $('personOwner').disabled = $('personType').value === 'NPC'; $('personDialog').showModal();
}
$('add').onclick = () => editPerson(); $('closePerson').onclick = () => $('personDialog').close();
$('personType').onchange = () => { $('personOwner').disabled = $('personType').value === 'NPC'; };
$('personForm').onsubmit = async event => {
  event.preventDefault(); $('savePerson').disabled = true;
  const hp = Number($('personHp').value), max = Number($('personMax').value);
  if (hp > max) { $('personError').textContent = 'HP cannot exceed maximum HP.'; $('savePerson').disabled = false; return; }
  const ok = await command('participant', { ...(editingId ? { id: editingId } : {}), name: $('personName').value.trim(), type: $('personType').value,
    ownerId: $('personType').value === 'NPC' ? null : $('personOwner').value || null, hp, max, number: Number($('personNumber').value), details: $('personDetails').value, loot: $('personLoot').value.trim() });
  if (ok) $('personDialog').close(); else $('personError').textContent = 'Participant was not saved. Check the notification and try again.';
  $('savePerson').disabled = false;
};
$('rows').onclick = async event => { const edit = event.target.closest('[data-edit]'), remove = event.target.closest('[data-remove]'); if (edit) editPerson(room.people.find(p => p.id === edit.dataset.edit)); if (remove) await command('remove', { id: remove.dataset.remove }); };
$('rows').onchange = event => { if (event.target.dataset.assign) command('assign', { id: event.target.dataset.assign, ownerId: event.target.value || null }); };
$('sample').onclick = async () => {
  if (room.people.length) { toast('Sample cast can only be added to an empty roster.'); return; }
  const people = [ { name:'Aelira Moonwhisper', type:'Player', hp:45, max:45, details:'White mage · A steady hand', ownerId:me().id }, { name:'Sylph Warden', type:'NPC', hp:38, max:38, details:'Guardian · Bound by an ancient oath' }, { name:'Hollow Treant', type:'NPC', hp:80, max:80, details:'Adversary · Roots stir beneath the earth' } ];
  for (let i = 0; i < people.length; i++) if (!await command('participant', { ...people[i], number:i+1 })) break;
  step = 1; render();
};
function setAction(value) { action = value; $('attack').classList.toggle('selected', value === 'attack'); $('heal').classList.toggle('selected', value === 'heal'); $('roll').textContent = 'Roll & apply '+value; }
$('attack').onclick = () => setAction('attack'); $('heal').onclick = () => setAction('heal');
$('roll').onclick = () => command('roll', { kind: action, targetId: $('target').value, sides:Number($('dice').value.slice(1)) });
$('endTurn').onclick = () => command('next'); $('undo').onclick = () => command('undo');
$('editEncounter').onclick = () => $('confirmDialog').showModal(); $('cancelSetup').onclick = () => $('confirmDialog').close();
$('confirmSetup').onclick = async () => { if (await command('setup')) { dirty = false; step = 0; $('confirmDialog').close(); render(); } };

$('copyCode').onclick=()=>{$('shareInvite').value=location.origin+'/table/index.html?room='+room.code;$('inviteDialog').showModal()};
$('closeInvite').onclick=()=>$('inviteDialog').close();$('copyInvite').onclick=async()=>{try{await navigator.clipboard.writeText($('shareInvite').value);toast('Player invite copied. Send it to your party.')}catch{$('shareInvite').select();toast('Select and copy the invite text.')}};

const KIND_HINTS = {
  classic: 'Players against NPCs. Players win when every NPC is down; NPCs win when every player is down.',
  lastStanding: 'Everyone fights everyone. It ends when only one person is left standing.',
  spar: 'A 1v1 duel. Enter exactly two participants. Whoever goes down first loses.',
  timed: 'Classic rules with a clock. If time runs out, the side with more total HP wins.'
};
const KIND_NAMES = { classic: 'CLASSIC', lastStanding: 'LAST ONE STANDING', spar: 'SPAR', timed: 'TIMED' };
// Pops up each time someone with loot goes down.
function dropToasts() {
  const drops = room?.drops || [];
  if (drops.length > seenDrops) toast(drops.slice(seenDrops).map(d => `${d.name} dropped loot: ${d.loot}`).join(' · '));
  seenDrops = drops.length;
}
// Countdown for timed encounters.
function tickClock() {
  clearInterval(clockTimer); clockTimer = null;
  const el = $('clock'); if (!room?.endsAt || room.phase !== 'combat') { el.textContent = ''; return; }
  const update = () => { const left = Math.max(0, Date.parse(room.endsAt) - Date.now()), m = Math.floor(left / 60000), s = Math.floor(left % 60000 / 1000); el.textContent = `TIME LEFT ${m}:${String(s).padStart(2, '0')}`; };
  update(); clockTimer = setInterval(update, 1000);
}
function renderEnded(unlocked, editable) {
  const r = room.result || {}; document.title = `Encounter over · ${room.name}`;
  $('endKind').textContent = KIND_NAMES[r.kind || room.kind] || '';
  $('endHeadline').textContent = r.headline || 'The encounter is over.'; $('endDetail').textContent = r.detail || '';
  $('endMeta').textContent = `${room.name} · ${r.rounds || room.round} round${(r.rounds || room.round) === 1 ? '' : 's'}`;
  const winners = new Set(r.winners || []);
  $('endStandings').innerHTML = (r.standings || []).map(s => `<div class="standing ${winners.has(s.name) ? 'winner' : ''}"><span><strong>${esc(s.name)}</strong> <span class="tag">${esc(s.type)}</span>${winners.has(s.name) ? ' · Winner' : ''}</span><span>${s.hp === 0 ? 'Downed' : `${s.hp} / ${s.max} HP`}</span></div>`).join('');
  const loot = r.loot || [];
  $('endLootBlock').classList.toggle('hidden', !loot.length);
  $('endLoot').innerHTML = loot.map(l => `<div class="lootRow"><span>${esc(l.name)} dropped loot:</span><strong>${esc(l.loot)}</strong></div>`).join('');
  $('endNote').textContent = r.note || ''; $('endNote').classList.toggle('hidden', !r.note);
  $('endClose').textContent = isDM() ? 'Close encounter' : 'Close';
  $('endUndo').classList.toggle('hidden', !(isDM() && room.undoAvailable && r.reason !== 'time')); $('endUndo').disabled = !editable;
}
$('endUndo').onclick = () => command('undo');
$('endClose').onclick = async () => {
  if (isDM()) {
    try { const session = credentials; await request(`/rooms/${session.code}/close`, { data: {} }); }
    catch (error) { if (error.status !== 404) { toast(error.message); return; } }
  }
  $('disconnect').click();
};
const last=saved();$('resume').classList.toggle('hidden',!last?.token);setConnectMode('create');
const inviteCode=new URL(location.href).searchParams.get('room');if(inviteCode){setConnectMode('join');$('roomCode').value=inviteCode}
setLive(false);
