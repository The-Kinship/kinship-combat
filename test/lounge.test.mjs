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
  r=await L(boss,'GET','');assert.deepEqual({items:r.lounge.tonight.items,count:r.lounge.tonight.count,total:r.lounge.tonight.total},{items:[{name:'Hot cocoa',price:150,count:2,total:300,by:[{name:'Kael',count:2}]}],count:2,total:300});
  assert.equal((await L(bar,'GET','')).lounge.tonight,undefined);
  db.sqlite.exec("UPDATE lounge_shifts SET start_at = '"+new Date(Date.now()-105*60000).toISOString()+"'");   // 1h45m ago
  assert.equal((await L(bar,'POST','/pay',{name:'Kael'})).status,403);
  assert.equal((await L(boss,'POST','/pay',{name:'Kael'})).status,409);                       // still clocked in
  assert.equal((await L(boss,'POST','/clockout',{name:'Kael'})).status,200);
  const staff=(await L(boss,'GET','')).lounge.staff.find(s=>s.name==='Kael');assert.equal(staff.minutes,105);assert.equal(staff.gold,10500);
  r=await L(boss,'POST','/pay',{name:'Kael'});assert.equal(r.status,200);
  assert.equal((await call('GET','/bank/me',undefined,bar)).gold,10500);
  assert.equal((await L(boss,'POST','/pay',{name:'Kael'})).status,409);                       // never paid twice
  const closed=await L(boss,'POST','/newnight',{});assert.equal(closed.lounge.tonight.count,0);
  assert.equal(closed.night.count,2);assert.equal(closed.night.total,300);assert.deepEqual(closed.night.items[0].by,[{name:'Kael',count:2}]);assert.equal(closed.night.people[0].minutes,105);
  const past=(await L(boss,'GET','')).lounge.nights;assert.equal(past.length,1);assert.equal(past[0].total,300);
  assert.deepEqual((await L(boss,'POST','/night',{id:past[0].id})).night.items[0].name,'Hot cocoa');
  assert.equal((await L(bar,'POST','/night',{id:past[0].id})).status,403);
  assert.equal((await L(bar,'GET','')).lounge.nights,undefined);
  assert.equal((await L(bar,'POST','/pf/save',{text:'Hi',minutes:55})).status,403);
  assert.equal((await L(boss,'POST','/pf/save',{text:'x'.repeat(193)})).status,400);
  assert.equal((await L(boss,'POST','/pf/save',{text:'Embershade Lounge is open! All welcome.',minutes:50})).status,200);
  let pf=(await L(bar,'POST','/pf/posted',{})).lounge.pf;assert.equal(pf.text,'Embershade Lounge is open! All welcome.');assert.equal(pf.minutes,50);assert.equal(pf.postedBy,'Kael');assert.ok(pf.postedAt);
  // two sellers: everyone who worked shows on every item, with zeros
  await L(bar,'POST','/clock',{in:true});await L(boss,'POST','/clock',{in:true});await L(boss,'POST','/sell',{menuId:menu[0].id,qty:3});await L(boss,'POST','/sell',{menuId:menu[1].id,qty:1});
  const by=(await L(boss,'GET','')).lounge.tonight.items;assert.deepEqual(by.find(i=>i.name==='Hot cocoa').by,[{name:'Kael',count:0},{name:'Mira',count:3}]);assert.deepEqual(by.find(i=>i.name==='Noodle bowl').by,[{name:'Kael',count:0},{name:'Mira',count:1}]);
  await L(boss,'POST','/menu/delete',{id:menu[1].id});assert.equal((await L(bar,'GET','')).lounge.menu.length,1);
});

test('services: each staff member offers their own, books time, extends, closes with a receipt that lands in the receipt book',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const boss=await join(call,'Mira'),bar=await join(call,'Kael');
  db.sqlite.exec("UPDATE members SET tags = 'Lounge Manager' WHERE name = 'Mira'");
  const L=(token,m,p,d)=>call(m,'/lounge'+p,d,token);
  assert.equal((await L(bar,'POST','/service/save',{name:'Companionship',price:20000})).status,200);
  assert.equal((await L(boss,'POST','/service/save',{name:'Potion making',price:5000})).status,200);
  const svcs=(await L(boss,'GET','')).lounge.services;assert.deepEqual(svcs.map(s=>[s.who,s.name,s.price]),[['Kael','Companionship',20000],['Mira','Potion making',5000]]);
  const mine=svcs.find(s=>s.who==='Kael');
  assert.equal((await L(boss,'POST','/service/delete',{id:mine.id})).lounge.services.length,2);   // cannot remove someone else's
  assert.equal((await L(bar,'POST','/session/start',{serviceId:mine.id,minutes:60})).status,409);  // clock in first
  await L(bar,'POST','/clock',{in:true});
  assert.equal((await L(bar,'POST','/session/start',{serviceId:svcs.find(s=>s.who==='Mira').id,minutes:60})).status,404);
  assert.equal((await L(bar,'POST','/session/start',{serviceId:mine.id,minutes:5})).status,400);
  let r=await L(bar,'POST','/session/start',{serviceId:mine.id,minutes:60,customer:'Rune'});assert.equal(r.status,201);
  assert.equal(r.lounge.session.minutes,60);assert.equal(r.lounge.sessions[0].who,'Kael');
  assert.equal((await L(bar,'POST','/session/start',{serviceId:mine.id,minutes:30})).status,409);
  assert.equal((await L(bar,'POST','/clock',{in:false})).status,409);                              // close the session first
  const ends=Date.parse(r.lounge.session.endsAt);
  r=await L(bar,'POST','/session/extend',{minutes:60});assert.equal(r.lounge.session.minutes,120);assert.equal(Date.parse(r.lounge.session.endsAt)-ends,3600000);
  r=await L(bar,'POST','/session/end',{});assert.equal(r.status,200);
  assert.deepEqual({s:r.receipt.staff,v:r.receipt.service,c:r.receipt.customer,m:r.receipt.minutes,t:r.receipt.total,rate:r.receipt.rate},{s:'Kael',v:'Companionship',c:'Rune',m:120,t:40000,rate:20000});
  assert.equal(r.lounge.session,null);assert.equal((await L(bar,'POST','/session/end',{})).status,404);
  const tn=(await L(boss,'GET','')).lounge.tonight;
  assert.equal(tn.services.length,1);assert.equal(tn.serviceTotal,40000);assert.equal(tn.grand,40000);assert.equal(tn.people.find(p=>p.name==='Kael').serviceTotal,40000);
  // a manager can close a running session for someone who left in a hurry, and clocking them out closes it too
  await L(bar,'POST','/session/start',{serviceId:mine.id,minutes:30});
  assert.equal((await L(bar,'POST','/session/end',{name:'Kael'})).status,403);
  r=await L(boss,'POST','/session/end',{name:'Kael'});assert.equal(r.receipt.total,10000);
  await L(bar,'POST','/session/start',{serviceId:mine.id,minutes:15});
  await L(boss,'POST','/clockout',{name:'Kael'});assert.equal((await L(bar,'GET','')).lounge.session,null);
  const closed=await L(boss,'POST','/newnight',{});assert.equal(closed.night.services.length,3);assert.equal(closed.night.serviceTotal,40000+10000+5000);assert.equal((await L(boss,'GET','')).lounge.nights[0].total,55000);
});

test('the lounge: patrons, who is helping them, schedule and advert',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const boss=await join(call,'Mira'),a=await join(call,'Kael'),b=await join(call,'Rune');
  db.sqlite.exec("UPDATE members SET tags = 'Lounge Manager' WHERE name = 'Mira'");
  const L=async(token,m,p,d)=>call(m,'/lounge'+p,d,token);
  assert.equal((await L(a,'POST','/patrons/report',{names:['Ada Vale']})).status,409);          // clock in first
  await L(a,'POST','/clock',{in:true});await L(b,'POST','/clock',{in:true});
  let r=await L(a,'POST','/patrons/report',{names:['Ada Vale','Bram Oak','Kael','  ']});assert.equal(r.status,200);
  assert.deepEqual(r.lounge.patrons.map(p=>p.name),['Ada Vale','Bram Oak']);                     // staff are not patrons
  assert.equal((await L(a,'POST','/patrons/help',{name:'Ada Vale'})).lounge.patrons[0].helper,'Kael');
  r=await L(b,'POST','/patrons/help',{name:'Ada Vale'});assert.equal(r.status,409);assert.match(r.error,/Kael is already helping/);
  assert.equal((await L(b,'POST','/patrons/unhelp',{name:'Ada Vale'})).status,403);
  assert.equal((await L(boss,'GET','')).lounge.patrons[0].helper,'Kael');
  r=await L(a,'POST','/patrons/done',{name:'Ada Vale'});assert.equal(r.lounge.patrons[0].helper,'');assert.equal(r.lounge.patrons[0].helpedBy,'Kael');
  r=await L(b,'POST','/patrons/help',{name:'Bram Oak'});assert.equal(r.status,200);
  r=await L(b,'POST','/patrons/unhelp',{name:'Bram Oak'});assert.equal(r.lounge.patrons[1].helper,'');assert.equal(r.lounge.patrons[1].helpedBy,'');
  await L(b,'POST','/patrons/help',{name:'Bram Oak'});await L(boss,'POST','/clockout',{name:'Rune'});   // clocking out releases them
  assert.equal((await L(a,'GET','')).lounge.patrons[1].helper,'');
  assert.equal((await L(a,'POST','/patrons/add',{name:'Walk In'})).lounge.patrons.length,3);
  db.sqlite.exec("UPDATE lounge_patrons SET last_seen = '"+new Date(Date.now()-120000).toISOString()+"' WHERE name = 'Ada Vale'");
  assert.deepEqual((await L(a,'GET','')).lounge.patrons.map(p=>p.name),['Bram Oak','Walk In']);   // not seen for a minute: gone
  await L(a,'POST','/patrons/remove',{name:'Walk In'});assert.equal((await L(a,'GET','')).lounge.patrons.length,1);
  db.sqlite.exec("UPDATE lounge_patrons SET last_seen = '"+new Date(Date.now()-400000).toISOString()+"' WHERE name = 'Bram Oak'");
  r=await L(a,'POST','/patrons/report',{names:['Bram Oak']});assert.equal(r.lounge.patrons[0].helpedBy,'');   // returned later: a fresh visit

  assert.equal((await L(a,'POST','/venue/set',{room:'h1-2-3',x:1,y:2,z:3})).status,403);
  r=await L(boss,'POST','/venue/set',{room:'h33-1-5-12-0',x:10.123,y:0,z:-4,radius:25,label:'Embershade'});assert.equal(r.lounge.venue.radius,25);assert.equal((await L(a,'GET','')).lounge.venue.room,'h33-1-5-12-0');
  assert.equal((await L(boss,'POST','/venue/clear',{})).lounge.venue,null);
  assert.equal((await L(a,'POST','/ad/save',{text:'x'})).status,403);
  assert.equal((await L(boss,'POST','/ad/save',{text:'Come to the Embershade Lounge!'})).lounge.adText,'Come to the Embershade Lounge!');

  const s=Date.now()+2*86400000,e=s+4*3600000;
  assert.equal((await L(a,'POST','/schedule/save',{startsAt:new Date(s).toISOString(),endsAt:new Date(e).toISOString()})).status,403);
  assert.equal((await L(boss,'POST','/schedule/save',{startsAt:new Date(e).toISOString(),endsAt:new Date(s).toISOString()})).status,400);
  r=await L(boss,'POST','/schedule/save',{startsAt:new Date(s).toISOString(),endsAt:new Date(e).toISOString(),note:'Live music'});assert.equal(r.lounge.schedule.length,1);
  const id=r.lounge.schedule[0].id;
  r=await L(a,'POST','/schedule/rsvp',{nightId:id,on:true});assert.equal(r.lounge.schedule[0].mine,'available');
  r=await L(boss,'POST','/roster/set',{nightId:id,name:'Kael',status:'working'});assert.deepEqual(r.lounge.schedule[0].staff,[{name:'Kael',status:'working'}]);
  assert.equal((await L(a,'POST','/schedule/rsvp',{nightId:id,on:false})).lounge.schedule[0].staff.length,0);
  assert.equal((await L(boss,'POST','/schedule/delete',{id})).lounge.schedule.length,0);
});

test('the lounge: close the night and start a new one are separate steps',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const boss=await join(call,'Mira'),bar=await join(call,'Kael');
  db.sqlite.exec("UPDATE members SET tags = 'Lounge Manager' WHERE name = 'Mira'");
  const L=async(token,m,p,d)=>call(m,'/lounge'+p,d,token);
  await L(boss,'POST','/menu/save',{name:'Tea',price:100});const id=(await L(bar,'GET','')).lounge.menu[0].id;
  assert.equal((await L(bar,'GET','')).lounge.nightOpen,true);
  await L(bar,'POST','/clock',{in:true});assert.equal((await L(bar,'POST','/sell',{menuId:id})).status,201);
  assert.equal((await L(bar,'POST','/closenight',{})).status,403);
  let r=await L(boss,'POST','/closenight',{});assert.equal(r.status,200);assert.equal(r.night.count,1);assert.equal(r.lounge.nightOpen,false);assert.equal(r.lounge.nights.length,1);
  assert.equal((await L(boss,'POST','/closenight',{})).status,409);
  r=await L(bar,'POST','/sell',{menuId:id});assert.equal(r.status,409);assert.match(r.error,/closed/);
  assert.equal((await L(boss,'POST','/startnight',{})).lounge.nightOpen,true);
  assert.equal((await L(boss,'POST','/startnight',{})).status,409);
  assert.equal((await L(bar,'POST','/sell',{menuId:id})).lounge.tonight,undefined);
  assert.equal((await L(boss,'GET','')).lounge.tonight.count,1);
});

test('the lounge: staff positions and call buttons',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const boss=await join(call,'Mira'),a=await join(call,'Kael'),sec=await join(call,'Rune'),sec2=await join(call,'Tess');
  db.sqlite.exec("UPDATE members SET tags = 'Lounge Manager' WHERE name = 'Mira'");
  const L=async(token,m,p,d)=>call(m,'/lounge'+p,d,token);
  assert.equal((await L(a,'POST','/roles/set',{name:'Rune',roles:['Security']})).status,403);
  assert.equal((await L(boss,'POST','/roles/set',{name:'Rune',roles:['Wizard']})).status,400);
  await L(boss,'POST','/roles/set',{name:'Rune',roles:['Security','Bartender']});await L(boss,'POST','/roles/set',{name:'Tess',roles:['Security']});await L(boss,'POST','/roles/set',{name:'Mira',roles:['Manager']});
  assert.deepEqual((await L(a,'GET','')).lounge.roles.find(r=>r.name==='Rune').roles,['Security','Bartender']);
  assert.equal((await L(a,'POST','/call/security',{})).status,409);                         // not clocked in
  await L(a,'POST','/clock',{in:true});
  let r=await L(a,'POST','/call/security',{});assert.equal(r.status,409);assert.match(r.error,/Security/);   // nobody on shift
  await L(sec,'POST','/clock',{in:true});await L(sec2,'POST','/clock',{in:true});
  assert.equal((await L(a,'POST','/call/manager',{ic:'IC'})).status,409);                   // no manager on shift
  await L(boss,'POST','/clock',{in:true});
  assert.equal((await L(a,'POST','/call/manager',{})).status,400);
  r=await L(a,'POST','/call/manager',{ic:'OOC'});assert.equal(r.status,200);
  assert.equal((await L(a,'POST','/call/manager',{ic:'OOC'})).status,429);                  // no spamming
  assert.deepEqual((await L(boss,'GET','')).lounge.pings.map(p=>p.text),['Kael requests a manager (OOC)']);
  assert.equal((await L(sec,'GET','')).lounge.pings.length,0);
  assert.equal((await L(a,'POST','/call/security',{})).status,200);
  for(const tk of [sec,sec2])assert.deepEqual((await L(tk,'GET','')).lounge.pings.map(p=>p.text),['Kael requests security']);
  r=await L(a,'POST','/call/ban',{patron:'Ada Vale',reason:'Griefing'});assert.equal(r.status,200);
  const pings=(await L(boss,'GET','')).lounge.pings;assert.equal(pings[1].text,'Kael has requested Ada Vale be banned. Reason: Griefing');
  r=await L(sec,'POST','/call/respond',{id:(await L(sec,'GET','')).lounge.pings[0].id});assert.equal(r.lounge.pings.length,0);
  assert.equal((await L(sec2,'GET','')).lounge.pings[0].responder,'Rune');                  // others see who is going
  await L(sec2,'POST','/call/dismiss',{id:(await L(sec2,'GET','')).lounge.pings[0].id});assert.equal((await L(sec2,'GET','')).lounge.pings.length,0);
  assert.equal((await L(a,'GET','')).lounge.working.find(w=>w.name==='Rune').roles[0],'Security');
});

test('the lounge: the only person with a position gets their own call',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const boss=await join(call,'Mira');db.sqlite.exec("UPDATE members SET tags = 'Lounge Manager' WHERE name = 'Mira'");
  const L=async(token,m,p,d)=>call(m,'/lounge'+p,d,token);
  await L(boss,'POST','/roles/set',{name:'Mira',roles:['Security']});await L(boss,'POST','/clock',{in:true});
  let r=await L(boss,'POST','/call/security',{});assert.equal(r.status,200);assert.match(r.lounge.msg,/test/);
  assert.equal(r.lounge.pings[0].text,'Mira requests security');
  r=await L(boss,'POST','/call/manager',{ic:'IC'});assert.equal(r.status,200);                // falls back to the Lounge Manager tag
});
