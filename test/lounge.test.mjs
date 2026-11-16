import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).sort())sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpass');return {status:r.status,...await r.json()}};
async function join(call,name){const r=await call('POST','/items/register',{name,memberPassword:'fcpass'});assert.equal(r.status,201);return r.token}

test('the lounge: menu, clock in and out, sales with a handed-over item, receipts, pay',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const boss=await join(call,'Mira'),bar=await join(call,'Kael'),guest=await join(call,'Rune');
  db.sqlite.exec("UPDATE members SET tags = 'Lounge Manager' WHERE name = 'Mira'");
  const L=async(token,m,p,d)=>call(m,'/lounge'+p,d,token);
  assert.equal((await L(bar,'GET','')).lounge.canManage,false);
  assert.equal((await L(bar,'POST','/menu/save',{name:'Cocoa',price:150})).status,403);
  assert.equal((await L(boss,'POST','/menu/save',{name:'Hot cocoa',price:150,description:'Sweet and warm.',gift:{name:'Cup of cocoa',icon:'game:20001',description:'Warm.',useLabel:'Drink',useText:'Cosy.'}})).status,200);
  await L(boss,'POST','/menu/save',{name:'Noodle bowl',price:400,description:'Spicy.'});
  assert.equal((await L(boss,'POST','/info',{hours:'Fri and Sat, 6pm to midnight',rate:6000})).status,200);
  const menu=(await L(bar,'GET','')).lounge.menu;assert.equal(menu.length,2);assert.equal(menu[0].gift.name,'Cup of cocoa');
  assert.equal((await L(bar,'POST','/sell',{menuId:menu[0].id})).status,409);              // clock in first
  assert.equal((await L(bar,'POST','/clock',{in:true})).status,201);
  assert.equal((await L(bar,'POST','/clock',{in:true})).status,409);
  assert.equal((await L(bar,'GET','')).lounge.working[0].name,'Kael');
  let r=await L(bar,'POST','/sell',{menuId:menu[0].id,qty:2,to:'Rune'});assert.equal(r.status,201);assert.equal(r.lounge.me.soldTotal,300);
  assert.equal((await call('GET','/items/me',undefined,guest)).items.filter(i=>i.name==='Cup of cocoa').reduce((n,i)=>n+(i.qty||1),0),2);
  assert.equal((await L(bar,'POST','/sell',{menuId:menu[1].id,to:'Rune'})).status,400);   // no item to hand over
  r=await L(bar,'POST','/sell',{menuId:menu[1].id});assert.equal(r.lounge.me.soldCount,3);
  r=await L(bar,'POST','/undo',{});assert.equal(r.lounge.me.soldCount,2);
  r=await L(boss,'GET','');assert.deepEqual(r.lounge.tonight,{items:[{name:'Hot cocoa',price:150,count:2,total:300}],count:2,total:300});
  assert.equal((await L(bar,'GET','')).lounge.tonight,undefined);
  db.sqlite.exec("UPDATE lounge_shifts SET start_at = '"+new Date(Date.now()-105*60000).toISOString()+"'");   // 1h45m ago
  assert.equal((await L(bar,'POST','/pay',{name:'Kael'})).status,403);
  assert.equal((await L(boss,'POST','/pay',{name:'Kael'})).status,409);                       // still clocked in
  assert.equal((await L(boss,'POST','/clockout',{name:'Kael'})).status,200);
  const staff=(await L(boss,'GET','')).lounge.staff.find(s=>s.name==='Kael');assert.equal(staff.minutes,105);assert.equal(staff.gold,10500);
  r=await L(boss,'POST','/pay',{name:'Kael'});assert.equal(r.status,200);
  assert.equal((await call('GET','/bank/me',undefined,bar)).gold,10500);
  assert.equal((await L(boss,'POST','/pay',{name:'Kael'})).status,409);                       // never paid twice
  assert.equal((await L(boss,'POST','/newnight',{})).lounge.tonight.count,0);
  await L(boss,'POST','/menu/delete',{id:menu[1].id});assert.equal((await L(bar,'GET','')).lounge.menu.length,1);
});
