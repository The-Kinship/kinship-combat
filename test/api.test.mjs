import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');sqlite.exec(fs.readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8'));return {sqlite,prepare(sql){const statement=sqlite.prepare(sql);let args=[];return {bind(...values){args=values;return this},async first(){return statement.get(...args)||null},async run(){return {meta:{changes:Number(statement.run(...args).changes)}}}}}}}
function client(db){return async(path,data,token)=>{const response=await handle(new Request('https://kinship.test/api'+path,{method:data===undefined?'GET':'POST',headers:{...(data===undefined?{}:{'Content-Type':'application/json','Origin':'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(path==='/rooms'&&data.createPassword===undefined?{...data,createPassword:'letmein'}:data)}),db,'letmein');return {status:response.status,...await response.json()}}}

// Builds a room with a DM and one joined player, adds the cast, applies settings, and (optionally) starts.
async function scene(t,{kind='classic',minutes,cast,start=true}={}){
  const db=database();t.after(()=>db.sqlite.close());const call=client(db);
  const dm=await call('/rooms',{name:'Mira',encounter:'Test fight'}),code=dm.room.code;
  const pl=await call(`/rooms/${code}/join`,{name:'Ren'});
  const tok={dm:dm.token,player:pl.token},ids={dm:dm.memberId,player:pl.memberId};
  let room=pl.room;
  const act=async(type,payload={},as='dm',revision=room.revision,actionId=crypto.randomUUID())=>{const r=await call(`/rooms/${code}/actions`,{type,payload,revision,actionId},tok[as]);if(r.room&&as==='dm')room=r.room;else if(r.room)room={...room,revision:r.room.revision};return r};
  const view=async(as='dm')=>(await call(`/rooms/${code}`,undefined,tok[as]));
  const sync=async()=>{room=(await view()).room;return room};
  await sync();
  const members={};
  for(const [i,c] of (cast||[]).entries()){
    const r=await act('participant',{name:c.name,type:c.type,hp:c.hp??1,max:c.max??Math.max(1,c.hp??1),number:c.number??i+1,details:'',loot:c.loot||'',...(c.mods?{mods:c.mods}:{}),ownerId:c.type==='Player'?ids[c.owner||'player']:null});
    assert.equal(r.status,200,JSON.stringify(r));
  }
  await sync();
  const s=await act('settings',{name:'Test fight',mode:'manual',notes:'',location:'',kind,...(minutes?{minutes}:{})});assert.equal(s.status,200,JSON.stringify(s));
  if(start){const r=await act('start');assert.equal(r.status,200,JSON.stringify(r))}
  await sync();
  const person=name=>room.people.find(p=>p.name===name);
  return {db,call,dm,pl,code,tok,ids,act,view,sync,person,get room(){return room}};
}
const hit=(c,target,as='dm')=>c.act('roll',{kind:'attack',targetId:c.person(target).id,sides:20},as);
const HERO_NPC=[{name:'Hero',type:'Player',hp:1},{name:'Treant',type:'NPC',hp:30,loot:'strange crystal'}];

test('rooms never expose tokens, and players cannot see undropped loot',async t=>{
  const c=await scene(t,{cast:HERO_NPC});
  assert.equal(JSON.stringify(c.room).includes('tokenHash'),false);
  assert.equal((await c.call(`/rooms/${c.code}`)).status,401);
  assert.equal((await c.view('dm')).room.people.find(p=>p.name==='Treant').loot,'strange crystal');
  assert.equal('loot' in (await c.view('player')).room.people.find(p=>p.name==='Treant'),false);
});

test('rolling uses your turn: the next character is up and you cannot roll twice',async t=>{
  const c=await scene(t,{cast:[{name:'Hero',type:'Player',hp:50},{name:'Treant',type:'NPC',hp:50},{name:'Fern',type:'NPC',hp:50}]});
  assert.equal(c.room.people[c.room.order.indexOf(c.room.order[c.room.index])].name,'Hero');
  assert.equal((await c.act('roll',{kind:'attack',targetId:c.person('Treant').id,sides:20},'dm')).status,403);   // DM cannot roll for the player
  const first=await c.act('roll',{kind:'attack',targetId:c.person('Treant').id,sides:20},'player');
  assert.equal(first.status,200);
  const state=(await c.view()).room;
  assert.equal(state.people.find(p=>p.id===state.order[state.index]).name,'Treant');       // turn passed on its own
  assert.equal(state.lastRoll.total,state.lastRoll.raw);                                     // no modifiers
  assert.equal((await c.act('roll',{kind:'attack',targetId:c.person('Treant').id,sides:20},'player')).status,403);
  assert.equal('modifier' in state.lastRoll,false);
});

test('initiative is gone: only random and manual order are accepted',async t=>{
  const c=await scene(t,{cast:HERO_NPC,start:false});
  assert.equal((await c.act('settings',{name:'x',mode:'initiative',notes:'',location:''})).status,400);
  assert.equal((await c.act('settings',{name:'x',mode:'random',notes:'',location:''})).status,200);
});

test('classic: defeating every NPC ends the fight with a summary, loot and the OOC note',async t=>{
  const c=await scene(t,{cast:[{name:'Hero',type:'Player',hp:5},{name:'Boss',type:'NPC',hp:1,loot:'large sword'},{name:'Goblin',type:'NPC',hp:1,loot:'12 gold'}]});
  assert.equal((await hit(c,'Boss','player')).status,200);
  assert.equal((await c.view()).room.phase,'combat');                    // one NPC is still up
  assert.ok((await c.view()).room.drops.some(d=>d.loot==='large sword'));
  await c.act('next','dm'==='dm'?{}:{});                                 // DM moves past Goblin's turn order slot if needed
  let room=(await c.view()).room;
  // keep passing until it is the Hero's turn again, then finish the Goblin
  for(let i=0;i<6&&room.people.find(p=>p.id===room.order[room.index]).name!=='Hero';i++){await c.act('next',{});room=(await c.view()).room}
  assert.equal((await hit(c,'Goblin','player')).status,200);
  room=(await c.view()).room;
  assert.equal(room.phase,'ended');
  assert.equal(room.result.reason,'enemiesDefeated');
  assert.equal(room.result.headline,'Victory for the Players!');
  assert.deepEqual(room.result.winners,['Hero']);
  assert.deepEqual(room.result.loot.map(l=>l.loot).sort(),['12 gold','large sword']);
  assert.equal(room.result.note,'((Loot will be distributed by the DM in game after the encounter.))');
  // nothing more can happen, nobody new can join, only the DM can close
  assert.equal((await c.act('next',{})).status,400);
  assert.equal((await c.call(`/rooms/${c.code}/join`,{name:'Late'})).status,400);
  assert.equal((await c.call(`/rooms/${c.code}/close`,{},c.tok.player)).status,403);
  assert.equal((await c.call(`/rooms/${c.code}/close`,{},c.tok.dm)).closed,true);
  assert.equal((await c.view()).status,404);
});

test('classic: all players down means the NPCs win, with no OOC note when nothing dropped',async t=>{
  const c=await scene(t,{cast:[{name:'Hero',type:'Player',hp:1},{name:'Treant',type:'NPC',hp:30}]});
  assert.equal((await hit(c,'Hero','player')).status,200);          // the hero hits themselves
  const room=(await c.view()).room;
  assert.equal(room.phase,'ended');assert.equal(room.result.reason,'playersDown');
  assert.deepEqual(room.result.winners,['Treant']);assert.equal(room.result.note,'');
});

test('last one standing ends when one participant is left',async t=>{
  const c=await scene(t,{kind:'lastStanding',cast:[{name:'Hero',type:'Player',hp:1,number:1},{name:'Ash',type:'Player',hp:1,number:2,owner:'dm'},{name:'Treant',type:'NPC',hp:30,number:3}]});
  assert.equal((await hit(c,'Ash','player')).status,200);
  assert.equal((await c.view()).room.phase,'combat');
  const room1=(await c.view()).room;
  assert.equal(room1.people.find(p=>p.id===room1.order[room1.index]).name,'Treant');   // Ash is down, skipped
  assert.equal((await c.act('roll',{kind:'attack',targetId:c.person('Hero').id,sides:20},'dm')).status,200);
  const room=(await c.view()).room;
  assert.equal(room.phase,'ended');assert.equal(room.result.reason,'lastStanding');
  assert.equal(room.result.headline,'Treant is the last one standing!');
});

test('spar needs exactly two and the first to fall loses',async t=>{
  const bad=await scene(t,{kind:'spar',cast:[...HERO_NPC,{name:'Extra',type:'NPC',hp:5}],start:false});
  assert.equal((await bad.act('start')).status,400);
  const c=await scene(t,{kind:'spar',cast:[{name:'Hero',type:'Player',hp:1},{name:'Rival',type:'Player',hp:1,owner:'dm'}]});
  assert.equal((await hit(c,'Rival','player')).status,200);
  const room=(await c.view()).room;
  assert.equal(room.phase,'ended');assert.equal(room.result.headline,'Hero wins the spar!');
  assert.equal(room.result.detail,'Rival went down first.');
});

test('classic needs at least one player and one NPC',async t=>{
  const c=await scene(t,{cast:[{name:'Hero',type:'Player',hp:5},{name:'Ash',type:'Player',hp:5,owner:'dm'}],start:false});
  assert.equal((await c.act('start')).status,400);
});

test('timed encounters end on the clock and the side with more HP wins',async t=>{
  const c=await scene(t,{kind:'timed',minutes:10,cast:[{name:'Hero',type:'Player',hp:40,max:40},{name:'Treant',type:'NPC',hp:25,max:25}]});
  assert.ok(c.room.endsAt);assert.equal((await c.view()).room.phase,'combat');
  const row=c.db.sqlite.prepare('SELECT state FROM rooms WHERE code = ?').get(c.code),state=JSON.parse(row.state);
  state.endsAt=new Date(Date.now()-1000).toISOString();
  c.db.sqlite.prepare('UPDATE rooms SET state = ? WHERE code = ?').run(JSON.stringify(state),c.code);
  const room=(await c.view()).room;
  assert.equal(room.phase,'ended');assert.equal(room.result.reason,'time');
  assert.equal(room.result.headline,'Time’s up! The Players win.');
  await c.sync();
  assert.equal((await c.act('undo',{})).status,400);
});

test('healing a downed character takes back their loot drop, and the DM can undo an ending',async t=>{
  const c=await scene(t,{cast:[{name:'Hero',type:'Player',hp:5,max:20},{name:'Boss',type:'NPC',hp:1,loot:'large sword'},{name:'Guard',type:'NPC',hp:1,loot:'12 gold'}]});
  await hit(c,'Boss','player');
  assert.equal((await c.view()).room.drops.length,1);
  let room=(await c.view()).room;
  while(room.people.find(p=>p.id===room.order[room.index]).name!=='Hero'){await c.act('next',{});room=(await c.view()).room}
  assert.equal((await c.act('roll',{kind:'heal',targetId:c.person('Boss').id,sides:4},'player')).status,200);
  room=(await c.view()).room;
  assert.equal(room.drops.length,0);                                   // Boss is back up, nothing dropped
  while(room.people.find(p=>p.id===room.order[room.index]).name!=='Hero'){await c.act('next',{});room=(await c.view()).room}
  await hit(c,'Boss','player');room=(await c.view()).room;
  while(room.people.find(p=>p.id===room.order[room.index]).name!=='Hero'){await c.act('next',{});room=(await c.view()).room}
  await hit(c,'Guard','player');
  room=(await c.view()).room;assert.equal(room.phase,'ended');
  assert.equal((await c.act('undo',{})).status,200);
  room=(await c.view()).room;assert.equal(room.phase,'combat');assert.equal(room.result,null);
});

test('database compare-and-swap prevents lost updates and duplicate rolls',async t=>{
  const c=await scene(t,{cast:[{name:'Hero',type:'Player',hp:50},{name:'Treant',type:'NPC',hp:50}]});
  const revision=c.room.revision,payload={kind:'attack',targetId:c.person('Treant').id,sides:4},id=crypto.randomUUID();
  const first=await c.act('roll',payload,'player',revision,id);
  const duplicate=await c.act('roll',payload,'player',revision,id);
  assert.equal(first.status,200);assert.equal(duplicate.status,200);assert.equal(duplicate.room.revision,first.room.revision);
  assert.equal((await c.act('roll',payload,'player',revision)).status,409);
});

test('invalid writes and cross-origin requests leave the room unchanged',async t=>{
  const c=await scene(t,{cast:HERO_NPC,start:false});
  const request=new Request('https://kinship.test/api/rooms',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://other.test'},body:JSON.stringify({name:'Bad',encounter:'Bad'})});
  assert.equal((await handle(request,c.db,'letmein')).status,403);
  assert.equal((await c.act('settings',{name:'Nope',mode:'manual',notes:'',location:'',kind:'bogus'})).status,400);
  assert.equal((await c.act('settings',{name:'Nope',mode:'manual',notes:'',location:'',kind:'timed',minutes:0})).status,400);
  assert.equal((await c.view()).room.name,'Test fight');
});

test('rooms untouched for a week are cleared when a new room is made',async t=>{
  const c=await scene(t,{cast:HERO_NPC,start:false});
  c.db.sqlite.prepare('UPDATE rooms SET updated_at = ? WHERE code = ?').run(new Date(Date.now()-8*86400000).toISOString(),c.code);
  await c.call('/rooms',{name:'New',encounter:'Fresh'});
  assert.equal((await c.view()).status,404);
});

test('DM modifiers add to every roll, stack, and never push a roll below 1',async t=>{
  const c=await scene(t,{start:false,cast:[{name:'Hero',type:'Player',hp:50,mods:[{label:'Sword',value:5},{label:'Sick',value:-2}]},{name:'Treant',type:'NPC',hp:500}]});
  assert.deepEqual(c.person('Hero').mods,[{label:'Sword',value:5},{label:'Sick',value:-2}]);
  assert.equal((await c.view('player')).room.people.find(p=>p.name==='Hero').mods.length,2);   // everyone can see them
  assert.equal((await c.act('start')).status,200);await c.sync();
  const target=c.person('Treant').id;
  const r=await c.act('roll',{kind:'attack',targetId:target,sides:4},'player');assert.equal(r.status,200);
  const lr=r.room.lastRoll;assert.equal(lr.bonus,3);assert.equal(lr.total,lr.raw+3);assert.equal(lr.applied,lr.total);assert.equal(lr.after,500-lr.total);
  assert.match(r.room.log.find(l=>l.message.includes("HP (d")).message,new RegExp(`d4: ${lr.raw}, \\+5 Sword, -2 Sick = ${lr.total}\\)`));
});

test('a big penalty is floored at 1, only the DM can set modifiers, and only before the fight',async t=>{
  const c=await scene(t,{start:false,cast:[{name:'Hero',type:'Player',hp:50,mods:[{label:'Cursed',value:-50}]},{name:'Treant',type:'NPC',hp:500}]});
  const hero=c.person('Hero');
  assert.equal((await c.act('participant',{...hero,mods:[{label:'Cheat',value:9}]},'player')).status,403);
  for(const mods of [[{label:'',value:1}],[{label:'x',value:1.5}],[{label:'x',value:100}],'nope',Array.from({length:7},(_, i)=>({label:'m'+i,value:1}))])
    assert.equal((await c.act('participant',{...hero,mods})).status,400);
  assert.equal((await c.act('participant',{...hero,mods:[{label:'Zero',value:0},{label:'Cursed',value:-50}]})).status,200);
  await c.sync();assert.deepEqual(c.person('Hero').mods,[{label:'Cursed',value:-50}]);   // a zero modifier is dropped
  await c.act('start');await c.sync();
  assert.equal((await c.act('participant',{...c.person('Hero'),mods:[]})).status,400);   // locked once the fight starts
  const r=await c.act('roll',{kind:'attack',targetId:c.person('Treant').id,sides:4},'player');assert.equal(r.room.lastRoll.total,1);assert.equal(r.room.lastRoll.applied,1);
});
