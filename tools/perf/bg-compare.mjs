#!/usr/bin/env node
// 背景光暈新舊版比對（P01）：同時開舊版與新版，定格在同一個動畫時間點截圖，用 pixelmatch 比較；可另錄並排影片。
//
//   node tools/perf/bg-compare.mjs --old <舊版 dist 資料夾>                     預設比 0、10、20、30 秒，淺色＋深色
//   node tools/perf/bg-compare.mjs --old <dir> --new <dir> --times 0,6,18
//   node tools/perf/bg-compare.mjs --old <dir> --video 20                     另錄 20 秒新舊並排影片（左舊右新）
//   node tools/perf/bg-compare.mjs --old <dir> --out <輸出資料夾>              預設 tools/perf/screens/bg-compare/
//
// 每個時間點各截兩張：bg-*（只留背景，其餘元素隱藏，最嚴格）與 page-*（整個畫面）。
// 舊版定格：所有動畫 pause＋currentTime = t；新版另外呼叫 window.__bgDebug.setTime(t) 讓 canvas 一起定格。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { createDevApp } from '../dev-server.mjs';

const PERF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(PERF_DIR, '..', '..');

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
}
if (typeof args.old !== 'string') { console.error('✗ 請用 --old 指定舊版的 dist 資料夾'); process.exit(1); }
const OLD = path.resolve(args.old);
const NEW = path.resolve(typeof args.new === 'string' ? args.new : path.join(ROOT, 'dist'));
const TIMES = String(typeof args.times === 'string' ? args.times : '0,10,20,30').split(',').map(s => Number(s) * 1000);
const OUT = path.resolve(typeof args.out === 'string' ? args.out : path.join(PERF_DIR, 'screens', 'bg-compare'));
const VIDEO_S = args.video ? Number(args.video) || 20 : 0;
const VIEWPORT = { width: 390, height: 844 };
const PREFS = { motion: 'full', autoScroll: true, perf: 'high' };

async function serve(root) {
  const app = createDevApp({ root, fixture: true, quiet: true });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + app.server.address().port + '/', close: () => new Promise(r => app.server.close(r)) };
}

async function openApp(browser, url, theme) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-TW', timezoneId: 'Asia/Taipei', colorScheme: theme });
  await context.addInitScript(p => { try { localStorage.setItem('FAST_BOOKKEEPING_PREFS_V1', JSON.stringify(p)); } catch (e) {} }, PREFS);
  const page = await context.newPage();
  const logs = [];
  page.on('console', m => { if (/背景光暈/.test(m.text())) logs.push(m.text()); });
  page.on('pageerror', e => console.warn('  [頁面錯誤] ' + e.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.classList.contains('boot-ready') && !document.getElementById('bootLoader'), null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  return { context, page, logs };
}

async function freeze(page, t) {
  await page.evaluate(ms => {
    document.getAnimations().forEach(a => { a.pause(); a.currentTime = ms; });
    if (window.__bgDebug) window.__bgDebug.setTime(ms);
  }, t);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))));
}

const BG_ONLY_CSS = 'body > *:not(.uv-glow-bg) { visibility: hidden !important; } body { background: transparent !important; }';

function diff(a, b, file) {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  const out = new PNG({ width: A.width, height: A.height });
  const pixels = pixelmatch(A.data, B.data, out.data, A.width, A.height, { threshold: 0.1 });
  fs.writeFileSync(file, PNG.sync.write(out));
  let max = 0;
  let sum = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    for (let c = 0; c < 3; c++) { const d = Math.abs(A.data[i + c] - B.data[i + c]); sum += d; if (d > max) max = d; }
  }
  return { percent: Math.round(pixels / (A.width * A.height) * 1e5) / 1e3, maxChannel: max, meanChannel: Math.round(sum / (A.width * A.height * 3) * 100) / 100 };
}

async function shots(browser, oldUrl, newUrl) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const rows = [];
  for (const theme of ['light', 'dark']) {
    const o = await openApp(browser, oldUrl, theme);
    const n = await openApp(browser, newUrl, theme);
    try {
      console.log('  ' + theme + '：新版 ' + (n.logs[0] || '（沒有印出模式）'));
      for (const t of TIMES) {
        for (const kind of ['bg', 'page']) {
          const imgs = [];
          for (const [label, app] of [['old', o], ['new', n]]) {
            const tag = kind === 'bg' ? await app.page.addStyleTag({ content: BG_ONLY_CSS }) : null;
            await freeze(app.page, t);
            const file = path.join(OUT, kind + '-' + theme + '-' + (t / 1000) + 's-' + label + '.png');
            await app.page.screenshot({ path: file, animations: 'allow', caret: 'hide' });
            imgs.push(fs.readFileSync(file));
            if (tag) await tag.evaluate(el => el.remove());
          }
          const r = diff(imgs[0], imgs[1], path.join(OUT, kind + '-' + theme + '-' + (t / 1000) + 's-diff.png'));
          rows.push({ theme, t: t / 1000, kind, ...r });
          console.log('  ' + theme.padEnd(5) + ' ' + String(t / 1000).padStart(3) + ' 秒 ' + (kind === 'bg' ? '只有背景' : '整個畫面') +
            '：差異 ' + r.percent + '%（pixelmatch 0.1）、單通道最大差 ' + r.maxChannel + '、平均差 ' + r.meanChannel);
        }
      }
    } finally {
      await o.context.close();
      await n.context.close();
    }
  }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(rows, null, 2) + '\n');
  return rows;
}

/** 並排影片：一個 780×844 的頁面放兩個 iframe（左舊右新），兩邊動畫時間對齊到 0 之後一起錄。 */
async function video(browser, oldUrl, newUrl) {
  for (const theme of ['light', 'dark']) {
    const dir = path.join(OUT, 'video-' + theme);
    fs.mkdirSync(dir, { recursive: true });
    const size = { width: VIEWPORT.width * 2, height: VIEWPORT.height };
    const context = await browser.newContext({ viewport: size, colorScheme: theme, recordVideo: { dir, size } });
    await context.addInitScript(p => { try { localStorage.setItem('FAST_BOOKKEEPING_PREFS_V1', JSON.stringify(p)); } catch (e) {} }, PREFS);
    const page = await context.newPage();
    await page.setContent('<style>body{margin:0;display:flex}iframe{border:0;width:' + VIEWPORT.width + 'px;height:' + VIEWPORT.height + 'px}</style>' +
      '<iframe src="' + oldUrl + '"></iframe><iframe src="' + newUrl + '"></iframe>');
    const frames = () => page.frames().filter(f => f !== page.mainFrame());
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 2);
    for (const f of frames()) await f.waitForFunction(() => document.documentElement.classList.contains('boot-ready') && !document.getElementById('bootLoader'), null, { timeout: 60000 });
    await page.waitForTimeout(1000);
    // 兩邊同時把動畫時間設回 0（仍在播放），新版再讓 canvas 重新對齊
    await Promise.all(frames().map(f => f.evaluate(() => {
      document.getAnimations().forEach(a => { a.currentTime = 0; });
      if (window.__bgDebug) window.__bgDebug.sync();
    })));
    await page.waitForTimeout(VIDEO_S * 1000);
    const v = page.video();
    await context.close();
    const file = path.join(OUT, 'side-by-side-' + theme + '.webm');
    fs.renameSync(await v.path(), file);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  影片：' + path.relative(ROOT, file) + '（左：舊版、右：新版，' + VIDEO_S + ' 秒）');
  }
}

const browser = await chromium.launch();
const oldApp = await serve(OLD);
const newApp = await serve(NEW);
try {
  console.log('背景光暈比對：舊版 ' + path.relative(ROOT, OLD) + ' ↔ 新版 ' + path.relative(ROOT, NEW));
  await shots(browser, oldApp.url, newApp.url);
  if (VIDEO_S) await video(browser, oldApp.url, newApp.url);
  console.log('輸出：' + path.relative(ROOT, OUT) + '/');
} finally {
  await browser.close();
  await oldApp.close();
  await newApp.close();
}
