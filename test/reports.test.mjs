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

test('reports: members send, only Advocates read, mark done and delete',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Mira');
  assert.equal((await call('POST','/reports',{kind:'bug',text:'x'})).status,401);
  assert.equal((await call('POST','/reports',{kind:'rude',text:'x'},a)).status,400);
  assert.equal((await call('POST','/reports',{kind:'bug',text:''},a)).status,400);
  assert.equal((await call('POST','/reports',{kind:'bug',text:'x'.repeat(501)},a)).status,400);
  assert.equal((await call('POST','/reports',{kind:'bug',text:'The bank button does nothing'},a)).status,201);
  assert.equal((await call('POST','/reports',{kind:'abuse',about:'Tobin',text:'Spamming mail'},a)).status,201);
  assert.equal((await call('POST','/reports/admin/list',{adminPassword:'wrong'})).status,403);
  const list=await call('POST','/reports/admin/list',{adminPassword:'dmpass'});assert.equal(list.status,200);assert.equal(list.reports.length,2);
  const r=list.reports.find(x=>x.kind==='abuse');assert.equal(r.member,'Mira');assert.equal(r.about,'Tobin');
  assert.equal((await call('POST','/reports/admin/done',{adminPassword:'dmpass',id:r.id})).status,200);
  const after=await call('POST','/reports/admin/list',{adminPassword:'dmpass'});assert.equal(after.reports[after.reports.length-1].done,true);
  assert.equal((await call('POST','/reports/admin/delete',{adminPassword:'dmpass',id:r.id})).status,200);
  assert.equal((await call('POST','/reports/admin/delete',{adminPassword:'dmpass',id:r.id})).status,404);
  db.sqlite.exec('DELETE FROM rate_limits');
  for(let i=0;i<9;i++){await call('POST','/reports',{kind:'bug',text:'again '+i},a);}
  db.sqlite.exec('DELETE FROM rate_limits');
  assert.equal((await call('POST','/reports',{kind:'bug',text:'one too many'},a)).status,429);
});

test('exchange tickets: need the gold, one open at a time, Advocates see them',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Mira');
  assert.equal((await call('POST','/reports/exchange',{amount:100})).status,401);
  assert.equal((await call('POST','/reports/exchange',{amount:0},a)).status,400);
  assert.equal((await call('POST','/reports/exchange',{amount:100},a)).status,400);
  assert.equal((await call('POST','/bank/admin/mint',{bankPassword:'bankpass',to:'Mira',amount:24000,note:'pay'})).status,201);
  assert.equal((await call('POST','/reports/exchange',{amount:24000},a)).status,201);
  assert.equal((await call('POST','/reports/exchange',{amount:10},a)).status,409);
  const list=await call('POST','/reports/admin/list',{adminPassword:'dmpass'});
  const r=list.reports.find(x=>x.kind==='exchange');
  assert.ok(r);assert.match(r.text,/Mira requests a 24,000 gold exchange/);
  await call('POST','/reports/admin/done',{adminPassword:'dmpass',id:r.id});
  assert.equal((await call('POST','/reports/exchange',{amount:10},a)).status,201);
});

test('the SM count shows only open reports and needs the password',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Mira');
  assert.equal((await call('POST','/reports/admin/count',{adminPassword:'nope'})).status,403);
  assert.equal((await call('POST','/reports/admin/count',{adminPassword:'dmpass'})).open,0);
  await call('POST','/reports',{kind:'bug',text:'x'},a);await call('POST','/reports',{kind:'abuse',about:'Kael',text:'y'},a);
  assert.equal((await call('POST','/reports/admin/count',{adminPassword:'dmpass'})).open,2);
  const id=(await call('POST','/reports/admin/list',{adminPassword:'dmpass'})).reports[0].id;
  await call('POST','/reports/admin/done',{adminPassword:'dmpass',id});
  assert.equal((await call('POST','/reports/admin/count',{adminPassword:'dmpass'})).open,1);
});
