import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';
import { parseCsv } from '../src/sects.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).sort())sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const CSV='sect,section,title,text,order\nonyx,notice,"Meeting, tonight","Bring ""the book""\nand a candle",2\nonyx,notice,Early,Read me first,1\niron,info,Patrol,Secret iron text,1\ncrypt,info,Welcome,Deep down,1\n';
function server(t,{passwords='{"onyx":"Moon Rise","iron":"steel","crypt":"bleed"}',url='https://sheet.test/'+Math.random()}={}){
  const db=database();t.after(()=>db.sqlite.close());
  let fetched=0;const fetcher=async()=>{fetched++;return {ok:true,text:async()=>CSV}};
  let n=0;
  const call=async(data,ip='1.1.1.'+(++n))=>{const r=await handle(new Request('https://kinship.test/api/sects/open',{method:'POST',headers:{'Content-Type':'application/json','cf-connecting-ip':ip},body:JSON.stringify(data)}),db,'dmpass','fcpass','bankpw',{sectPasswords:passwords,sectContentUrl:url,fetcher});return {status:r.status,...await r.json()}};
  return {db,call,get fetched(){return fetched}};
}

test('the csv reader handles quotes, commas and line breaks inside quotes',()=>{
  const g=parseCsv(CSV);assert.equal(g.length,5);assert.equal(g[1][2],'Meeting, tonight');assert.equal(g[1][3],'Bring "the book"\nand a candle');
});

test('the right password gives that sect\'s pages only, sorted fields, and a token; wrong ones give nothing',async t=>{
  const s=server(t);
  const bad=await s.call({sect:'onyx',password:'nope'});assert.equal(bad.status,401);assert.equal(bad.rows,undefined);
  const ok=await s.call({sect:'ONYX',password:'  moon rise '});     // capitals and spaces don't matter, as before
  assert.equal(ok.status,200);assert.equal(ok.rows.length,2);assert.ok(ok.rows.every(r=>!('sect' in r)));
  assert.match(JSON.stringify(ok.rows),/Meeting, tonight/);assert.doesNotMatch(JSON.stringify(ok),/Secret iron text/);
  assert.equal(s.fetched,1);
  // the saved token opens the sect again without the password, and is only good for that sect
  const again=await s.call({sect:'onyx',token:ok.token});assert.equal(again.status,200);
  assert.equal((await s.call({sect:'iron',token:ok.token})).status,401);
  assert.equal((await s.call({sect:'onyx',token:'0'.repeat(64)})).status,401);
  assert.equal((await s.call({sect:'nobody',password:'x'})).status,404);
  assert.equal((await s.call({sect:'crypt',password:'bleed'})).rows[0].title,'Welcome');
  assert.equal(s.fetched,1);   // the sheet is cached for a minute
});

test('changing a sect password cancels every saved token for it',async t=>{
  const a=server(t),ok=await a.call({sect:'iron',password:'steel'});
  const b=server(t,{passwords:'{"iron":"new steel"}'});
  assert.equal((await b.call({sect:'iron',token:ok.token})).status,401);
  assert.equal((await b.call({sect:'iron',password:'new steel'})).status,200);
});

test('guessing is capped per address and per sect, and a closed setup says so',async t=>{
  const s=server(t);
  for(let i=0;i<10;i++)assert.equal((await s.call({sect:'onyx',password:'g'+i},'9.9.9.9')).status,401);
  assert.equal((await s.call({sect:'onyx',password:'g11'},'9.9.9.9')).status,429);
  assert.equal((await s.call({sect:'onyx',password:'Moon Rise'},'9.9.9.9')).status,429);     // even the right one, from that address
  assert.equal((await s.call({sect:'onyx',password:'Moon Rise'},'8.8.8.8')).status,200);      // other addresses are fine
  const closed=server(t,{passwords:''});assert.equal((await closed.call({sect:'onyx',password:'x'})).status,503);
  const noSheet=server(t,{url:''});assert.equal((await noSheet.call({sect:'onyx',password:'Moon Rise'})).status,503);
  const sectCap=server(t),saved=(await sectCap.call({sect:'iron',password:'steel'})).token;
  for(let i=0;i<100;i++)await sectCap.call({sect:'iron',password:'g'+i},'7.7.'+Math.floor(i/10)+'.'+(i%10));
  assert.equal((await sectCap.call({sect:'iron',password:'steel'},'6.6.6.6')).status,429);   // the sect is locked for new entries for the day
  assert.equal((await sectCap.call({sect:'onyx',password:'Moon Rise'},'6.6.6.6')).status,200);
  assert.equal((await sectCap.call({sect:'iron',token:saved},'5.5.5.5')).status,200);   // a saved token still works while the sect is locked to guessers
  const tok=(await sectCap.call({sect:'iron',token:'x'},'5.5.5.5'));assert.equal(tok.status,401);   // saved tokens are never locked out, only wrong ones fail
});
