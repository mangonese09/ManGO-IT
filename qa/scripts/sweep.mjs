// ── QA PHASE 1: AUTOMATED DEFECT SWEEPS ──
// Runs every check against every screen-state × viewport × theme.
// Usage: node qa/scripts/sweep.mjs [targetUrl]
// Output: qa/out/sweep-findings.json, qa/out/tokens.json, qa/shots/<viewport>/<screen>-<theme>.png
import { chromium } from 'file:///C:/Users/micon/OneDrive/Documents/Claude Files/Projects/ManGO/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const TARGET = process.argv[2] || 'https://it.mangonese.dev';
const ROOT = decodeURIComponent(new URL('../..', import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');
const OUT = path.join(ROOT, 'qa', 'out');
const SHOTS = path.join(ROOT, 'qa', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = {
  small: { width: 320, height: 568 },
  base: { width: 390, height: 844 },
  'large-phone': { width: 430, height: 932 },
  landscape: { width: 844, height: 390 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
};
const THEMES = ['dark', 'light'];

const findings = [];
const tokenSamples = [];

function report(f) { findings.push(f); }

// ── in-page audit battery (serialized into the browser) ──
const AUDITS = `(() => {
  const out = { overflow: [], deadSpace: null, alignment: [], touch: [], contrast: [], sticky: [] };
  const de = document.documentElement;
  const vw = de.clientWidth;

  // 1. horizontal overflow with offender walk
  if (de.scrollWidth > vw + 1) {
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > vw + 1 || r.left < -1) && !el.closest('[hidden]')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        out.overflow.push({ sel: el.tagName + '.' + [...el.classList].join('.'), left: Math.round(r.left), right: Math.round(r.right), vw });
        if (out.overflow.length >= 6) break;
      }
    }
    if (!out.overflow.length) out.overflow.push({ sel: '(document-level only)', vw, scrollWidth: de.scrollWidth });
  }

  // 2. dead space below last visible content
  let lastBottom = 0;
  for (const el of document.querySelectorAll('main *')) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || !r.height) continue;
    lastBottom = Math.max(lastBottom, r.bottom + window.scrollY);
  }
  const nav = document.querySelector('.bottom-nav');
  const navH = nav ? nav.getBoundingClientRect().height : 0;
  const dead = de.scrollHeight - navH - lastBottom;
  if (dead > 24) out.deadSpace = { scrollHeight: de.scrollHeight, lastContentBottom: Math.round(lastBottom), deadPx: Math.round(dead) };

  // 4. alignment: left edges of visible content blocks in main
  const lefts = {};
  for (const el of document.querySelectorAll('main > section > *, main > section > div > *')) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || !r.height || r.width < 40) continue;
    const x = Math.round(r.left);
    (lefts[x] = lefts[x] || []).push(el.className || el.tagName);
  }
  const xs = Object.keys(lefts).map(Number).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] - xs[i - 1] > 0 && xs[i] - xs[i - 1] <= 6) {
      out.alignment.push({ a: xs[i - 1], b: xs[i], aEls: lefts[xs[i - 1]].slice(0, 2), bEls: lefts[xs[i]].slice(0, 2) });
    }
  }

  // 5. touch targets
  const inter = [...document.querySelectorAll('button, a, input, select, [role=button], [tabindex="0"]')].filter((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width && r.height && cs.display !== 'none' && cs.visibility !== 'hidden' && !el.closest('[hidden]');
  });
  for (const el of inter) {
    const r = el.getBoundingClientRect();
    if (r.width < 44 || r.height < 44) {
      out.touch.push({ sel: (el.id ? '#' + el.id : el.tagName + '.' + [...el.classList].join('.')), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || '').trim().slice(0, 20) });
    }
  }

  // 6. contrast (WCAG) for visible text nodes
  function lum(c) {
    const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function parse(c) { const m = c.match(/[\\d.]+/g); return m ? m.slice(0, 4).map(Number) : null; }
  function effBg(el) {
    let n = el;
    while (n && n !== document.documentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg && (bg.length < 4 || bg[3] > 0.9)) return bg;
      n = n.parentElement;
    }
    return parse(getComputedStyle(document.body).backgroundColor) || [20, 20, 20];
  }
  const seen = new Set();
  for (const el of document.querySelectorAll('main *, header *, nav *')) {
    if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getBoundingClientRect().height) continue;
    const fg = parse(cs.color); const bg = effBg(el);
    if (!fg) continue;
    const L1 = Math.max(lum(fg), lum(bg)), L2 = Math.min(lum(fg), lum(bg));
    const ratio = (L1 + 0.05) / (L2 + 0.05);
    const size = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 600;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    if (ratio < need) {
      const key = cs.color + '|' + cs.fontSize + '|' + el.className;
      if (!seen.has(key)) {
        seen.add(key);
        out.contrast.push({ sel: el.className || el.tagName, text: (el.textContent || '').trim().slice(0, 24), ratio: Math.round(ratio * 100) / 100, need, color: cs.color, size });
      }
    }
  }

  // 8. fixed-nav collision (content underneath bottom nav at current scroll)
  if (nav) {
    const nr = nav.getBoundingClientRect();
    for (const el of document.querySelectorAll('main *')) {
      const r = el.getBoundingClientRect();
      if (!r.height || r.height > innerHeight) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      if (r.bottom > nr.top + 4 && r.top < nr.top - 4 && el.textContent.trim()) {
        out.sticky.push({ sel: el.className || el.tagName, bottom: Math.round(r.bottom), navTop: Math.round(nr.top) });
        if (out.sticky.length >= 3) break;
      }
    }
  }
  return out;
})()`;

const TOKEN_HARVEST = `(() => {
  const rows = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || !el.getBoundingClientRect().height) continue;
    rows.push({
      cls: el.className && typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName,
      fs: cs.fontSize, fw: cs.fontWeight, col: cs.color, bg: cs.backgroundColor,
      br: cs.borderRadius, pad: cs.padding, gap: cs.gap,
    });
  }
  return rows;
})()`;

async function auditState(page, viewport, theme, screen) {
  const dir = path.join(SHOTS, viewport);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${screen}-${theme}.png`), fullPage: false });
  const res = await page.evaluate(AUDITS);
  const ctx = { viewport, theme, screen };
  if (res.overflow.length) report({ ...ctx, check: 'h-overflow', detail: res.overflow });
  if (res.deadSpace) report({ ...ctx, check: 'dead-space', detail: res.deadSpace });
  for (const a of res.alignment) report({ ...ctx, check: 'alignment', detail: a });
  for (const t of res.touch) report({ ...ctx, check: 'touch-target', detail: t });
  for (const c of res.contrast) report({ ...ctx, check: 'contrast', detail: c });
  for (const s of res.sticky) report({ ...ctx, check: 'nav-collision', detail: s });
  if (viewport === 'base') {
    const toks = await page.evaluate(TOKEN_HARVEST);
    tokenSamples.push({ screen, theme, toks });
  }
}

async function openScreen(page, name) {
  if (name === 'home') return;
  if (name === 'saved') await page.click('#nav-saved');
  if (name === 'map') await page.click('#nav-map');
  if (name === 'settings') await page.click('#nav-settings');
  await page.waitForTimeout(700);
}

const browser = await chromium.launch();
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    await page.addInitScript((t) => {
      localStorage.setItem('mangoit.settings', JSON.stringify({ theme: t }));
      localStorage.setItem('mangoit.view', 'home');
    }, theme);
    await page.goto(TARGET, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    // static screens
    for (const screen of ['home', 'saved', 'map', 'settings']) {
      await openScreen(page, screen);
      await auditState(page, vpName, theme, screen);
    }

    // results flow (heavier — run on phones + landscape only)
    if (['small', 'base', 'landscape'].includes(vpName)) {
      await page.click('#nav-home');
      await page.waitForTimeout(400);
      // CLS observer armed before search
      await page.evaluate(() => {
        window.__cls = 0;
        new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
          .observe({ type: 'layout-shift', buffered: false });
      });
      await page.fill('#from-input', 'Raffadali');
      await page.waitForTimeout(1100);
      const sug = page.locator('#from-suggest .suggest-row');
      if (await sug.count()) {
        await auditState(page, vpName, theme, 'home-suggesting');
        await sug.first().click();
        await page.fill('#to-input', 'Terminal Alibus');
        await page.waitForTimeout(1100);
        const sug2 = page.locator('#to-suggest .suggest-row');
        if (await sug2.count()) {
          await sug2.first().click();
          await page.click('#search-btn');
          await page.waitForTimeout(8000);
          await auditState(page, vpName, theme, 'results');
          const cls = await page.evaluate(() => window.__cls);
          if (cls > 0.1) report({ viewport: vpName, theme, screen: 'results', check: 'cls', detail: { cls: Math.round(cls * 1000) / 1000 } });
          // detail sheet
          const row = page.locator('.dep-row-btn, .iti-card').first();
          if (await row.count()) {
            await row.click();
            await page.waitForTimeout(700);
            await auditState(page, vpName, theme, 'trip-detail');
            await page.locator('.sheet-close').click().catch(() => {});
          }
        }
      }
    }
    await ctx.close();
  }
}

// 130% / 200% text-size passes at base dark (rem-scaling emulation)
for (const scale of ['130%', '200%']) {
  const ctx = await browser.newContext({ viewport: VIEWPORTS.base });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('mangoit.view', 'home'));
  await page.goto(TARGET, { waitUntil: 'networkidle' });
  await page.evaluate((s) => { document.documentElement.style.fontSize = s; }, scale);
  await page.waitForTimeout(500);
  for (const screen of ['home', 'saved', 'settings']) {
    await openScreen(page, screen);
    await auditState(page, 'base', `text${scale.replace('%', '')}`, screen);
  }
  await ctx.close();
}

await browser.close();

fs.writeFileSync(path.join(OUT, 'sweep-findings.json'), JSON.stringify(findings, null, 1));
fs.writeFileSync(path.join(OUT, 'tokens.json'), JSON.stringify(tokenSamples));
const byCheck = {};
for (const f of findings) byCheck[f.check] = (byCheck[f.check] || 0) + 1;
console.log('findings by check:', byCheck);
console.log('total:', findings.length, '-> qa/out/sweep-findings.json');
