import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of ['0001_init.sql','0002_scenes.sql','0003_items.sql','0004_stashes.sql','0005_signs.sql','0006_item_requirements.sql','0007_bank.sql','0008_statuses.sql','0009_recipes.sql','0010_diagnosis.sql','0011_quests.sql','0012_quest_claims.sql','0013_quest_starts.sql','0014_quest_fights.sql','0015_gold_spots.sql','0016_players.sql','0017_status_bonuses.sql','0018_rooms.sql','0019_mail.sql','0020_mail_look.sql','0021_armory.sql','0022_duels.sql','0023_profiles.sql','0024_profile_name.sql','0025_reports.sql','0026_marks.sql', '0027_settings.sql','0028_alpha_gold.sql','0029_quest_notices.sql','0030_finds.sql', '0031_party_quests.sql', '0032_member_tags.sql'])sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=(db,bank='bankpw')=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass',bank);return {status:r.status,...await r.json()}};
async function join(call,name){const r=await call('POST','/items/register',{name,memberPassword:'fcpass'});assert.equal(r.status,201);return r}

test('only the bank password can create or take gold, and it is separate from the creation password',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  assert.equal((await call('POST','/bank/admin/mint',{bankPassword:'dmpass',to:'Mira',amount:5})).status,403);   // the creation password is not enough
  assert.equal((await call('POST','/bank/admin/mint',{bankPassword:'',to:'Mira',amount:5})).status,403);
  assert.equal((await call('POST','/bank/admin/mint',{bankPassword:'bankpw',to:'Nobody',amount:5})).status,404);
  for(const amount of [0,-3,1.5,'9',2000000])assert.equal((await call('POST','/bank/admin/mint',{bankPassword:'bankpw',to:'Mira',amount})).status,400);
  const m=await call('POST','/bank/admin/mint',{bankPassword:'bankpw',to:'mira',amount:20,note:'Boss fight loot'});assert.equal(m.status,201);assert.equal(m.gold,20);
  assert.equal((await call('GET','/items/me',undefined,a.token)).gold,20);
  const me=await call('GET','/bank/me',undefined,a.token);assert.equal(me.gold,20);assert.equal(me.history[0].note,'Boss fight loot');assert.equal(me.history[0].delta,20);
  assert.equal((await call('POST','/bank/admin/take',{bankPassword:'bankpw',to:'Mira',amount:50})).status,409);
  const t2=await call('POST','/bank/admin/take',{bankPassword:'bankpw',to:'Mira',amount:15,note:'Exchanged for gil'});assert.equal(t2.status,200);assert.equal(t2.gold,5);
  const list=await call('POST','/bank/admin/list',{bankPassword:'bankpw'});assert.equal(list.total,5);assert.deepEqual(list.balances,[{name:'Mira',gold:5}]);assert.equal(list.recent[0].note,'Exchanged for gil');
});

test('the bank is closed until its password is set in Cloudflare',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db,null);await join(call,'Mira');
  const r=await call('POST','/bank/admin/mint',{bankPassword:'anything',to:'Mira',amount:5});assert.equal(r.status,503);assert.match(r.error,/bank password/);
});

test('members can pay each other but never spend what they do not have',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  await call('POST','/bank/admin/mint',{bankPassword:'bankpw',to:'Mira',amount:10});
  assert.equal((await call('POST','/bank/pay',{to:'Mira',amount:1},a.token)).status,400);
  assert.equal((await call('POST','/bank/pay',{to:'Kael',amount:11},a.token)).status,409);
  assert.equal((await call('POST','/bank/pay',{to:'Kael',amount:-5},a.token)).status,400);
  assert.equal((await call('POST','/bank/pay',{to:'Mira',amount:4},b.token)).status,409);   // Kael has nothing
  const paid=await call('POST','/bank/pay',{to:'Kael',amount:4},a.token);assert.equal(paid.status,200);assert.equal(paid.gold,6);assert.equal(paid.history[0].note,'Paid Kael');
  const k=await call('GET','/bank/me',undefined,b.token);assert.equal(k.gold,4);assert.equal(k.history[0].note,'From Mira');
  assert.equal((await call('GET','/bank/me')).status,401);
});

test('removing a member clears their purse and history',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);await join(call,'Mira');
  await call('POST','/bank/admin/mint',{bankPassword:'bankpw',to:'Mira',amount:10});
  assert.equal((await call('POST','/items/admin/remove-member',{adminPassword:'dmpass',name:'Mira'})).status,200);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM gold_log').get().n,0);
});
