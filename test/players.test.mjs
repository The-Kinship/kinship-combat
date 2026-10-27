import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).sort())sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass');return {status:r.status,...await r.json()}};
const reg=(call,name,extra={})=>call('POST','/items/register',{name,memberPassword:'fcpass',...extra});

test('a second character joins the same player with the recovery code, and gets no new code',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await reg(call,'Sesen');assert.equal(a.status,201);assert.match(a.recoveryCode,/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);assert.equal(a.linked,false);
  const b=await reg(call,'Vex',{recoveryCode:a.recoveryCode});assert.equal(b.status,201);assert.equal(b.recoveryCode,null);assert.equal(b.linked,true);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM players').get().n,1);
  assert.equal(db.sqlite.prepare('SELECT count(DISTINCT player_id) AS n FROM members').get().n,1);
  assert.notEqual(a.token,b.token);
  assert.equal((await call('GET','/items/me',undefined,b.token)).name,'Vex');   // separate characters, separate items
});

test('a wrong code cannot join a player, and a new registration without a code starts its own',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  await reg(call,'Sesen');
  assert.equal((await reg(call,'Vex',{recoveryCode:'AAAA-BBBB-CCCC'})).status,403);
  const other=await reg(call,'Kael');assert.equal(other.status,201);assert.ok(other.recoveryCode);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM players').get().n,2);
});

test('one code recovers every character, one at a time',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await reg(call,'Sesen'),b=await reg(call,'Vex',{recoveryCode:a.recoveryCode});await reg(call,'Kael');
  const list=await call('POST','/items/recover',{recoveryCode:a.recoveryCode});assert.equal(list.status,200);assert.deepEqual(list.characters,['Sesen','Vex']);assert.equal(list.token,undefined);
  const back=await call('POST','/items/recover',{recoveryCode:a.recoveryCode.toLowerCase(),name:'vex'});assert.equal(back.status,200);assert.equal(back.name,'Vex');
  assert.equal((await call('GET','/items/me',undefined,b.token)).status,401);   // the old key no longer works
  assert.equal((await call('GET','/items/me',undefined,back.token)).name,'Vex');
  assert.equal((await call('POST','/items/recover',{recoveryCode:a.recoveryCode,name:'Kael'})).status,403);   // not covered by this code
  assert.equal((await call('POST','/items/recover',{recoveryCode:'0000-0000-0000'})).status,403);
  assert.equal((await call('POST','/items/recover',{recoveryCode:a.recoveryCode,name:'Sesen'})).status,200);   // old style (name + code) still works
});

test('removing the last character removes the player, and one code covers at most ten',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await reg(call,'Alt 0');
  for(let i=1;i<10;i++)assert.equal((await reg(call,'Alt '+i,{recoveryCode:a.recoveryCode})).status,201);
  db.sqlite.exec('DELETE FROM rate_limits');
  assert.equal((await reg(call,'Alt 10',{recoveryCode:a.recoveryCode})).status,409);
  db.sqlite.exec('DELETE FROM rate_limits');
  for(let i=0;i<10;i++)assert.equal((await call('POST','/items/admin/remove-member',{adminPassword:'dmpass',name:'Alt '+i})).status,200);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM players').get().n,0);
});

test('members that existed before players become one player each, keeping their code',async t=>{
  const sqlite=new DatabaseSync(':memory:');
  const files=fs.readdirSync(new URL('../migrations/',import.meta.url)).sort();
  for(const f of files.filter(f=>f<'0016'))sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
  const crypto=await import('node:crypto');const hash=crypto.createHash('sha256').update('ABCDEF012345').digest('hex');
  sqlite.prepare("INSERT INTO members (id,name,name_key,token_hash,recovery_hash,created_at) VALUES ('m1','Old One','old one','th1',?,'x')").run(hash);
  sqlite.exec(fs.readFileSync(new URL('../migrations/0016_players.sql',import.meta.url),'utf8'));
  const db={prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}};
  t.after(()=>sqlite.close());const call=mk(db);
  const rec=await call('POST','/items/recover',{recoveryCode:'abcd-ef01-2345',name:'Old One'});assert.equal(rec.status,200);
  assert.deepEqual((await call('POST','/items/recover',{recoveryCode:'ABCD-EF01-2345'})).characters,['Old One']);
});
