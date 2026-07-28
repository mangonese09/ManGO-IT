import { chromium } from 'file:///C:/Users/micon/OneDrive/Documents/Claude Files/Projects/ManGO/node_modules/playwright/index.mjs';
const T='http://localhost:3098';
const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:390,height:844},hasTouch:true})).newPage();
await p.goto(T,{waitUntil:'networkidle'}); await p.click('#nav-home');
// from: Palermo airport (pick the Aeroporto/Cinisi row, not Notarbartolo)
await p.fill('#from-input','Palermo Aeroporto');
await p.waitForSelector('#from-suggest .suggest-row:not(.suggest-loc)',{timeout:15000}); await p.waitForTimeout(400);
for (const r of await p.$$('#from-suggest .suggest-row')){ const t=(await r.textContent())||''; if(/aeroporto/i.test(t)&&/cinisi/i.test(t)){ await r.click(); break; } }
// to: Raffadali
await p.fill('#to-input','Raffadali');
await p.waitForSelector('#to-suggest .suggest-row:not(.suggest-loc)',{timeout:15000});
await p.click('#to-suggest .suggest-row:not(.suggest-loc)');
await p.click('#search-btn');
await p.waitForFunction(()=>{const r=document.getElementById('results');return r&&(r.querySelector('.stitch-card')||r.querySelector('.empty-state'));},{timeout:50000});
await p.waitForTimeout(800);
const cards=await p.$$eval('.stitch-card',n=>n.length);
const head=await p.$$eval('.stitch-card .iti-time',n=>n.map(x=>x.textContent.trim()));
const lines=await p.$$eval('.stitch-card .stitch-legline',n=>n.map(x=>x.textContent.trim()));
console.log('stitch cards:',cards);console.log('headlines:',JSON.stringify(head));console.log('leg lines:',JSON.stringify(lines));
if(cards){await p.click('.stitch-card');await p.waitForTimeout(600);
  const legs=await p.$$eval('.iti-detail .leg-route, .iti-detail .leg-walk, .iti-detail .stitch-change',n=>n.map(x=>x.textContent.replace(/\s+/g,' ').trim()).slice(0,8));
  console.log('detail order:',JSON.stringify(legs));}
await p.screenshot({path:'qa/shots/reverse-stitch.png',fullPage:true});
await b.close();
process.exit(cards>0?0:1);
