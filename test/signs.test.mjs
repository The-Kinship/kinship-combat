import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of ['0001_init.sql','0002_scenes.sql','0003_items.sql','0004_stashes.sql','0005_signs.sql','0006_item_requirements.sql','0007_bank.sql','0008_statuses.sql','0009_recipes.sql','0010_diagnosis.sql','0011_quests.sql','0012_quest_claims.sql','0013_quest_starts.sql','0014_quest_fights.sql','0015_gold_spots.sql','0016_players.sql','0017_status_bonuses.sql','0018_rooms.sql','0019_mail.sql','0020_mail_look.sql','0021_armory.sql','0022_duels.sql','0023_profiles.sql','0024_profile_name.sql','0025_reports.sql','0026_marks.sql', '0027_settings.sql','0028_alpha_gold.sql','0029_quest_notices.sql','0030_finds.sql'])sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const HERE={territory:339,x:10.5,y:2,z:-30.25};const stand=p=>{globalThis.__here=p};stand(HERE);
const mk=db=>async(method,path,data,token)=>{const h=globalThis.__here;if(h){if(method==='GET')path+=(path.includes('?')?'&':'?')+`t=${h.territory}&x=${h.x}&y=${h.y}&z=${h.z}${h.room?`&r=${h.room}`:''}`;else if(data&&typeof data==='object'&&!data.at)data={...data,at:{...h}}}const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpass');return {status:r.status,...await r.json()}};
const spot={name:'Tree carving',description:'This tree seems to have marks carved into it. On closer inspection it reads "Help me".\nThe letters are fresh.',zone:'Mist',territory:339,map:72,x:10.5,y:2,z:-30.25,mapX:11.2,mapY:9.8};
async function join(call,name){const r=await call('POST','/items/register',{name,memberPassword:'fcpass'});assert.equal(r.status,201);return r}

test('make a sign, everyone sees it in the list, the text comes with one sign',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  assert.equal((await call('GET','/signs')).status,401);
  const made=await call('POST','/signs',spot,a.token);assert.equal(made.status,201);assert.equal(made.sign.mine,true);assert.match(made.sign.description,/Help me/);
  const list=(await call('GET','/signs',undefined,b.token)).signs;
  assert.equal(list.length,1);assert.equal(list[0].name,'Tree carving');assert.equal(list[0].mine,false);assert.equal(list[0].ownerName,'Mira');assert.equal(list[0].description,undefined);
  const one=await call('GET',`/signs/${made.sign.id}`,undefined,b.token);assert.equal(one.status,200);assert.match(one.sign.description,/letters are fresh/);
  assert.equal((await call('GET','/signs/aaaaaaaaaaaa',undefined,b.token)).status,404);
});

test('bad input is refused and each member gets ten signs',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  assert.equal((await call('POST','/signs',{...spot,name:''},a.token)).status,400);
  assert.equal((await call('POST','/signs',{...spot,description:''},a.token)).status,400);
  assert.equal((await call('POST','/signs',{...spot,description:'x'.repeat(1001)},a.token)).status,400);
  assert.equal((await call('POST','/signs',{...spot,x:'far'},a.token)).status,400);
  for(let i=0;i<10;i++)assert.equal((await call('POST','/signs',{...spot,name:'S'+i},a.token)).status,201);
  assert.equal((await call('POST','/signs',spot,a.token)).status,409);
});

test('only the maker edits or deletes; advocates can delete with the creation password; removing a member clears their signs',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  const s=(await call('POST','/signs',spot,a.token)).sign;
  assert.equal((await call('POST',`/signs/${s.id}/update`,{name:'Hijack'},b.token)).status,403);
  assert.equal((await call('POST',`/signs/${s.id}/delete`,{},b.token)).status,403);
  const up=await call('POST',`/signs/${s.id}/update`,{name:'Carving',description:'New text',territory:340,map:73,x:1,y:1,z:1,mapX:1,mapY:1,zone:'Lavender Beds'},a.token);
  assert.equal(up.status,200);assert.equal(up.sign.name,'Carving');assert.equal(up.sign.zone,'Lavender Beds');assert.equal(up.sign.description,'New text');
  assert.equal((await call('POST','/signs/admin/delete',{adminPassword:'nope',signId:s.id})).status,403);
  assert.equal((await call('POST','/signs/admin/delete',{adminPassword:'dmpass',signId:s.id})).status,200);
  assert.equal((await call('GET','/signs',undefined,a.token)).signs.length,0);
  const s2=(await call('POST','/signs',spot,b.token)).sign;
  assert.equal((await call('POST','/items/admin/remove-member',{adminPassword:'dmpass',name:'Kael'})).status,200);
  assert.equal((await call('GET','/signs',undefined,a.token)).signs.length,0);
  const own=(await call('POST','/signs',spot,a.token)).sign;
  assert.equal((await call('POST',`/signs/${own.id}/delete`,{},a.token)).status,200);
});

test('gold left at a sign is paid by the maker, taken once by the first finder, and returned if the sign is deleted',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const reg=async n=>{const r=await call('POST','/items/register',{name:n,memberPassword:'fcpass'});return r.token};
  const a=await reg('Mira'),b=await reg('Kael'),c=await reg('Rune');
  const mint=(to,amount)=>call('POST','/bank/admin/mint',{bankPassword:'bankpass',to,amount});
  const spot={territory:339,map:72,x:10.5,y:2,z:-30.25,mapX:5,mapY:6,zone:'Mist'};
  assert.equal((await call('POST','/signs',{...spot,name:'Treasure',description:'Dig here',gold:50},a)).status,409);   // not enough gold
  await mint('Mira',100);
  assert.equal((await call('POST','/signs',{...spot,name:'Treasure',description:'Dig here',gold:-5},a)).status,400);
  const made=await call('POST','/signs',{...spot,name:'Treasure',description:'Dig here',gold:60},a);assert.equal(made.status,201);const id=made.sign.id;
  assert.equal((await call('GET','/bank/me',undefined,a)).gold,40);
  assert.equal((await call('GET','/signs',undefined,b)).signs[0].gold,undefined);                  // the list does not give it away
  assert.equal((await call('GET','/signs/'+id,undefined,b)).sign.gold,60);                          // reading shows it
  const mineSign=await call('POST','/signs',{...spot,name:'Mine',description:'x',gold:5},a);
  assert.equal((await call('POST',`/signs/${mineSign.sign.id}/claim`,{},a)).claimed,5);              // the maker can take it back
  assert.equal((await call('GET','/bank/me',undefined,a)).gold,40);
  const got=await call('POST',`/signs/${id}/claim`,{},b);assert.equal(got.claimed,60);assert.equal((await call('GET','/bank/me',undefined,b)).gold,60);
  const late=await call('POST',`/signs/${id}/claim`,{},c);assert.equal(late.status,409);assert.equal((await call('GET','/bank/me',undefined,c)).gold,0);
  const second=await call('POST','/signs',{...spot,name:'Second',description:'x',gold:30},a);
  await call('POST',`/signs/${second.sign.id}/delete`,{},a);assert.equal((await call('GET','/bank/me',undefined,a)).gold,40);   // refunded
  const third=await call('POST','/signs',{...spot,name:'Third',description:'x',gold:10},a);
  assert.equal((await call('POST','/signs/admin/delete',{adminPassword:'dmpass',signId:third.sign.id})).status,200);
  assert.equal((await call('GET','/bank/me',undefined,a)).gold,40);
});

test('signs far away are only counted by zone and cannot be read or emptied from a distance',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  stand(HERE);
  await call('POST','/bank/admin/mint',{bankPassword:'bankpass',to:'Mira',amount:50});
  const s=(await call('POST','/signs',{...spot,gold:20},a.token)).sign;
  stand({territory:339,x:40,y:2,z:-30.25});
  let list=await call('GET','/signs',undefined,b.token);assert.equal(list.signs.length,1);assert.equal(list.elsewhere,0);
  assert.equal((await call('GET','/signs/'+s.id,undefined,b.token)).status,403);
  stand({territory:12,x:0,y:0,z:0});
  list=await call('GET','/signs',undefined,b.token);assert.equal(list.signs.length,0);assert.deepEqual(list.zones,[{zone:'Mist',count:1}]);
  assert.equal((await call('POST','/signs/'+s.id+'/claim',{},b.token)).status,403);
  assert.equal((await call('GET','/signs',undefined,a.token)).signs.length,1);        // the maker sees their own from anywhere
  assert.equal((await call('GET','/signs/'+s.id,undefined,a.token)).status,200);
  stand(HERE);
  assert.equal((await call('POST','/signs/'+s.id+'/claim',{},b.token)).claimed,20);
});

test('a sign in a house is only readable inside that same house',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  stand({...HERE,territory:282,room:'h40-1-3-12-0'});
  const s=(await call('POST','/signs',{...spot,territory:282,room:'h40-1-3-12-0'},a.token)).sign;
  assert.equal((await call('GET','/signs/'+s.id,undefined,b.token)).status,200);
  stand({...HERE,territory:282,room:'h40-1-3-99-0'});assert.equal((await call('GET','/signs/'+s.id,undefined,b.token)).status,403);
});
