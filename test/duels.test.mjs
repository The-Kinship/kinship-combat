import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('migrations/'+f,'utf8'));
  const wrap=s=>({bind:(...a)=>({run:async()=>{const r=s.run(...a);return {meta:{changes:Number(r.changes)}}},first:async()=>s.get(...a)??null,all:async()=>({results:s.all(...a)})}),run:async()=>{const r=s.run();return {meta:{changes:Number(r.changes)}}},first:async()=>s.get()??null,all:async()=>({results:s.all()})});
  return {sqlite,prepare:q=>wrap(sqlite.prepare(q))}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpass');return {status:r.status,...await r.json()}};
async function join(call,name){const r=await call('POST','/items/register',{name,memberPassword:'fcpass'});assert.equal(r.status,201);return r.token}
const clear=db=>db.sqlite.exec('DELETE FROM rate_limits');

test('challenge, accept, take turns until someone wins; both get a 10 minute status',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  assert.equal((await call('POST','/duels',{target:'Nobody'},a)).status,404);
  assert.equal((await call('POST','/duels',{target:'Mira'},a)).status,400);
  const made=await call('POST','/duels',{target:'Kael Stormborn'},a);assert.equal(made.status,201);assert.equal(made.duel.status,'pending');assert.equal(made.duel.foe,'Kael');
  const id=made.duel.id;
  assert.equal((await call('POST','/duels',{target:'Kael'},a)).status,409);                           // already has one
  assert.equal((await call('GET','/duels/mine',undefined,b)).duel.id,id);                              // Kael sees the challenge
  assert.equal((await call('POST',`/duels/${id}/accept`,{},a)).status,409);                            // only the target can accept
  const on=await call('POST',`/duels/${id}/accept`,{},b);assert.equal(on.status,200);assert.equal(on.duel.status,'active');
  const first=on.duel.yourTurn?b:a, second=first===a?b:a;
  assert.equal((await call('POST',`/duels/${id}/act`,{kind:'attack'},second)).status,409);             // not your turn
  assert.equal((await call('POST',`/duels/${id}/act`,{kind:'dance'},first)).status,400);
  let who=first,other=second,last;
  for(let i=0;i<200;i++){clear(db);last=await call('POST',`/duels/${id}/act`,{kind:'attack'},who);assert.equal(last.status,200);if(last.duel.status==='done')break;[who,other]=[other,who]}
  assert.equal(last.duel.status,'done');assert.equal(last.duel.youWon,true);
  const loserView=(await call('GET','/duels/mine',undefined,other)).duel;assert.equal(loserView.youWon,false);
  const st=(await call('GET','/statuses',undefined,a)).statuses;
  const names=n=>st.filter(s=>s.memberName===n).map(s=>s.name);
  const winnerName=who===a?'Mira':'Kael',loserName=who===a?'Kael':'Mira';
  assert.deepEqual(names(winnerName),['Won a fight']);assert.deepEqual(names(loserName),['Lost a fight']);
  const lost=st.find(s=>s.name==='Lost a fight');assert.equal(lost.isDebuff,true);assert.ok(lost.secondsLeft>0&&lost.secondsLeft<=600);assert.equal(lost.self,false);
  // free again
  clear(db);assert.equal((await call('POST','/duels',{target:'Mira'},b)).status,201);
});

test('refusing, cancelling, healing limits, forfeit and abandoned fights',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  let d=(await call('POST','/duels',{target:'Kael'},a)).duel;
  assert.equal((await call('POST',`/duels/${d.id}/refuse`,{},b)).duel.status,'refused');
  clear(db);d=(await call('POST','/duels',{target:'Kael'},a)).duel;
  assert.equal((await call('POST',`/duels/${d.id}/cancel`,{},a)).duel.status,'cancelled');
  clear(db);d=(await call('POST','/duels',{target:'Kael'},a)).duel;
  await call('POST',`/duels/${d.id}/accept`,{},b);
  // heals: three per person, only on your turn
  let turn=(await call('GET','/duels/mine',undefined,a)).duel.yourTurn?a:b,other=turn===a?b:a;
  for(let n=0;n<3;n++){clear(db);assert.equal((await call('POST',`/duels/${d.id}/act`,{kind:'heal'},turn)).status,200);[turn,other]=[other,turn];clear(db);await call('POST',`/duels/${d.id}/act`,{kind:'heal'},turn);[turn,other]=[other,turn]}
  clear(db);const none=await call('POST',`/duels/${d.id}/act`,{kind:'heal'},turn);assert.equal(none.status,409);assert.match(none.error,/no heals/);
  const f=await call('POST',`/duels/${d.id}/forfeit`,{},turn);assert.equal(f.duel.status,'done');assert.equal(f.duel.youWon,false);
  // an unanswered challenge expires, and an abandoned fight ends
  clear(db);d=(await call('POST','/duels',{target:'Kael'},a)).duel;
  db.sqlite.exec("UPDATE duels SET created_at = '2000-01-01T00:00:00.000Z' WHERE status = 'pending'");
  assert.equal((await call('GET','/duels/mine',undefined,a)).duel.status,'expired');
  clear(db);d=(await call('POST','/duels',{target:'Kael'},a)).duel;await call('POST',`/duels/${d.id}/accept`,{},b);
  db.sqlite.exec("UPDATE duels SET updated_at = '2020-01-01T00:00:00.000Z' WHERE status = 'active'");
  const gone=(await call('GET','/duels/mine',undefined,a)).duel;
  assert.ok(gone===null||gone.status==='done');
});

test('gear and status bonuses count in a fight',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  await call('POST','/statuses/admin/add',{adminPassword:'dmpass',to:'Mira',name:'Fury',icon:'game:10205',atkBonus:5});
  const d=(await call('POST','/duels',{target:'Kael'},a)).duel;await call('POST',`/duels/${d.id}/accept`,{},b);
  const turn=(await call('GET','/duels/mine',undefined,a)).duel.yourTurn?a:b;
  if(turn===b){await call('POST',`/duels/${d.id}/act`,{kind:'attack'},b)}
  clear(db);const r=await call('POST',`/duels/${d.id}/act`,{kind:'attack'},a);
  assert.match(r.duel.log.at(-1),/\+5 Fury/);
});
