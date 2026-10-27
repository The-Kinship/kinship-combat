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
const cookie={name:'Cookie',icon:'game:20001',description:'x',useLabel:'Eat',useText:'Yum.',consumable:true};
const gold=(call,to,amount)=>call('POST','/bank/admin/mint',{bankPassword:'bankpass',to,amount});

test('send mail with gold and items, read it, collect it, delete it',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  await gold(call,'Mira',100);
  for(let i=0;i<3;i++)await call('POST','/items',cookie,a);
  const it=(await call('GET','/items/me',undefined,a)).items[0];assert.equal(it.qty,3);
  assert.equal((await call('POST','/mail',{to:'Nobody',subject:'Hi'},a)).status,404);
  assert.equal((await call('POST','/mail',{to:'Mira',subject:'Hi'},a)).status,400);                 // not to yourself
  assert.equal((await call('POST','/mail',{to:'Kael',subject:'Hi',gold:500},a)).status,409);        // not enough gold
  assert.equal((await call('POST','/mail',{to:'Kael',subject:'Hi',items:[{itemId:it.id,count:5}]},a)).status,409);
  const sent=await call('POST','/mail',{to:'Kael',subject:'A gift',body:'For you.',gold:40,items:[{itemId:it.id,count:2}],anonymous:true},a);assert.equal(sent.status,201);
  assert.equal((await call('GET','/bank/me',undefined,a)).gold,60);
  assert.equal((await call('GET','/items/me',undefined,a)).items[0].qty,1);
  assert.deepEqual(await call('GET','/mail/count',undefined,b).then(r=>[r.total,r.unread]),[1,1]);
  const list=await call('GET','/mail',undefined,b);assert.equal(list.inbox.length,1);assert.equal(list.inbox[0].from,'Anonymous');assert.equal(list.inbox[0].gold,40);assert.equal(list.inbox[0].slots,1);assert.equal(list.inbox[0].unread,true);
  const sentList=await call('GET','/mail',undefined,a);assert.equal(sentList.outbox.length,1);
  const one=await call('GET','/mail/'+sent.id,undefined,b);assert.equal(one.mail.body,'For you.');assert.equal(one.mail.items[0].qty,2);
  assert.equal((await call('GET','/mail/'+sent.id,undefined,a)).status,403);                         // the sender cannot read it as the recipient
  assert.equal((await call('POST','/mail/'+sent.id+'/recall',{},a)).status,409);                      // already opened
  assert.equal((await call('POST','/mail/'+sent.id+'/delete',{},b)).status,409);                      // collect first
  const got=await call('POST','/mail/'+sent.id+'/collect',{},b);assert.equal(got.status,200);assert.equal(got.got,40);
  assert.equal((await call('GET','/bank/me',undefined,b)).gold,40);assert.equal((await call('GET','/items/me',undefined,b)).items[0].qty,2);
  assert.equal((await call('POST','/mail/'+sent.id+'/collect',{},b)).status,409);
  assert.equal((await call('POST','/mail/'+sent.id+'/delete',{},b)).status,200);
  assert.equal((await call('GET','/mail',undefined,b)).inbox.length,0);
  const adminless=await call('POST','/mail/admin/list',{adminPassword:'nope'});assert.equal(adminless.status,403);
});

test('an unopened mail can be recalled, and the inbox holds 30',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  await gold(call,'Mira',100);await call('POST','/items',cookie,a);const it=(await call('GET','/items/me',undefined,a)).items[0];
  const s=await call('POST','/mail',{to:'Kael',subject:'Oops',gold:30,items:[{itemId:it.id,count:1}]},a);
  assert.equal((await call('POST','/mail/'+s.id+'/recall',{},(await join(call,'Rune'))) ).status,404);
  assert.equal((await call('POST','/mail/'+s.id+'/recall',{},b)).status,403);
  assert.equal((await call('POST','/mail/'+s.id+'/recall',{},a)).status,200);
  assert.equal((await call('GET','/bank/me',undefined,a)).gold,100);assert.equal((await call('GET','/items/me',undefined,a)).items.length,1);
  assert.equal((await call('GET','/mail',undefined,b)).inbox.length,0);
  db.sqlite.exec("DELETE FROM rate_limits");
  for(let i=0;i<30;i++){if(i%15===0)db.sqlite.exec("DELETE FROM rate_limits");assert.equal((await call('POST','/mail',{to:'Kael',subject:'m'+i},a)).status,201)}
  db.sqlite.exec("DELETE FROM rate_limits");
  const full=await call('POST','/mail',{to:'Kael',subject:'one more'},a);assert.equal(full.status,409);assert.match(full.error,/full/);
});

test('expired mail returns to the sender once, then is gone; gold goes back to the purse',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  await gold(call,'Mira',100);await call('POST','/items',cookie,a);const it=(await call('GET','/items/me',undefined,a)).items[0];
  const s=await call('POST','/mail',{to:'Kael',subject:'Late',gold:30,items:[{itemId:it.id,count:1}],anonymous:true},a);
  db.sqlite.exec("UPDATE mails SET expires_at = '2000-01-01T00:00:00.000Z'");
  const mine=await call('GET','/mail',undefined,a);
  assert.equal(mine.inbox.length,1);assert.equal(mine.inbox[0].returned,true);assert.equal(mine.inbox[0].from,'Returned mail');assert.equal(mine.inbox[0].gold,30);
  assert.equal((await call('GET','/mail',undefined,b)).inbox.length,0);
  db.sqlite.exec("UPDATE mails SET expires_at = '2000-01-01T00:00:00.000Z'");
  assert.equal((await call('GET','/mail',undefined,a)).inbox.length,0);                               // second expiry deletes it
  assert.equal((await call('GET','/bank/me',undefined,a)).gold,100);                                  // gold refunded
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM items WHERE owner_id LIKE 'm%'").get().n,0);
  // returned mail can be collected before then
  await call('POST','/items',cookie,a);const it2=(await call('GET','/items/me',undefined,a)).items[0];
  await call('POST','/mail',{to:'Kael',subject:'Again',gold:10,items:[{itemId:it2.id,count:1}]},a);
  db.sqlite.exec("UPDATE mails SET expires_at = '2000-01-01T00:00:00.000Z'");
  const back=(await call('GET','/mail',undefined,a)).inbox[0];
  assert.equal((await call('POST','/mail/'+back.id+'/collect',{},a)).status,200);assert.equal((await call('GET','/bank/me',undefined,a)).gold,100);
});

test('Advocates see who sent anonymous mail, and removing a member clears their waiting mail',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  await call('POST','/mail',{to:'Kael',subject:'Secret',anonymous:true},a);
  const list=await call('POST','/mail/admin/list',{adminPassword:'dmpass'});assert.equal(list.mails[0].from,'Mira');assert.equal(list.mails[0].anonymous,true);assert.equal(list.mails[0].to,'Kael');
  await gold(call,'Mira',50);await call('POST','/mail',{to:'Kael',subject:'Gold',gold:20},a);
  const all=(await call('POST','/mail/admin/list',{adminPassword:'dmpass'})).mails;
  assert.equal((await call('POST','/mail/admin/delete',{adminPassword:'dmpass',mailId:all.find(m=>m.subject==='Gold').id})).status,200);
  assert.equal((await call('GET','/bank/me',undefined,a)).gold,50);
  assert.equal((await call('POST','/items/admin/remove-member',{adminPassword:'dmpass',name:'Kael'})).status,200);
  assert.equal((await call('POST','/mail/admin/list',{adminPassword:'dmpass'})).mails.length,0);
});
