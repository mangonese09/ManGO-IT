import { chromium } from 'file:///C:/Users/micon/OneDrive/Documents/Claude Files/Projects/ManGO/node_modules/playwright/index.mjs';
const T='http://localhost:3098';
const b=await chromium.launch();
const p=await (await b.newContext({viewport:{width:390,height:844},hasTouch:true})).newPage();
await p.goto(T,{waitUntil:'networkidle'}); await p.click('#nav-home');
async function pickFrom(t){await p.fill('#from-input',t);await p.waitForSelector('#from-suggest .suggest-row:not(.suggest-loc)',{timeout:15000});await p.click('#from-suggest .suggest-row:not(.suggest-loc)');}
await pickFrom('Raffadali');
// destination: type and click the row whose name contains "Aeroporto"
await p.fill('#to-input','Palermo Aeroporto');
await p.waitForSelector('#to-suggest .suggest-row:not(.suggest-loc)',{timeout:15000});
await p.waitForTimeout(400);
const rows = await p.$$('#to-suggest .suggest-row');
let picked='(none)';
for (const r of rows){ const t=(await r.textContent())||''; if(/aeroporto|airport/i.test(t)){ picked=t.replace(/\s+/g,' ').trim(); await r.click(); break; } }
if(picked==='(none)'){ await rows[0].click(); picked='FALLBACK first'; }
console.log('picked destination:', picked);
await p.click('#search-btn');
await p.waitForFunction(()=>{const r=document.getElementById('results');return r && (r.querySelector('.stitch-card')||r.querySelector('.empty-state'));},{timeout:45000});
await p.waitForTimeout(800);
const headlines = await p.$$eval('.stitch-card .iti-time', n=>n.map(x=>x.textContent.trim()));
const legs = await p.$$eval('.stitch-card .stitch-legline', n=>n.map(x=>x.textContent.trim()));
console.log('stitch headlines:', JSON.stringify(headlines));
console.log('leg lines:', JSON.stringify(legs));
if (await p.$('.stitch-card')) { await p.click('.stitch-card'); await p.waitForTimeout(600);
  const detail = await p.$$eval('.iti-detail .leg-route, .iti-detail .leg-walk', n=>n.map(x=>x.textContent.replace(/\s+/g,' ').trim()).slice(0,6));
  console.log('detail legs:', JSON.stringify(detail)); }
await p.screenshot({path:'qa/shots/stitch.png',fullPage:true});
await b.close();
