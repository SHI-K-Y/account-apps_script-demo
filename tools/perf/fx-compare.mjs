#!/usr/bin/env node
// 常駐／一次性特效新舊版比對（P02）：同時開舊版與新版，把每個元件的動畫定格在週期的 0%、25%、50%、75%，
// 只截那個元件（含周圍一點邊界），用 pixelmatch 比較。
//
//   node tools/perf/fx-compare.mjs --old <舊版 dist 資料夾>                  預設新版是 dist/，淺色＋深色、手機
//   node tools/perf/fx-compare.mjs --old <dir> --new <dir> --desktop        另外用桌機（可以 hover）再比一次
//   node tools/perf/fx-compare.mjs --old <dir> --only tabs,submit           只比部分元件
//   node tools/perf/fx-compare.mjs --old <dir> --out <輸出資料夾>            預設 tools/perf/screens/fx-compare/
//
// 定格方式：元件內所有動畫 pause＋currentTime = 週期 × 比例（用同一個絕對時間，所以新版把「4 秒 48px」
// 改成「2 秒 24px」這類等效寫法也能對得上）；背景 canvas 用 window.__bgDebug.setTime(0) 固定。
// 一次性的「閃一下」是由測試直接加上 class 觸發，再定格在動畫長度的各比例。
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
const OUT = path.resolve(typeof args.out === 'string' ? args.out : path.join(PERF_DIR, 'screens', 'fx-compare'));
const ONLY = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const FRACTIONS = [0, 0.25, 0.5, 0.75];
const PREFS = { motion: 'full', autoScroll: false };
const DEVICES = [{ key: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }];
if (args.desktop) DEVICES.push({ key: 'desktop', viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

// 固定的展示用元素：舊版與新版插入完全相同的標記
const INJECT_STYLE = '.bottom-nav, .back-to-top-btn, .toast-container { visibility: hidden !important; } ' +
  '#fxCompareStage { padding: 16px 14px; display: grid; gap: 18px; } #fxCompareStage .sr-group { min-height: 90px; }';
const STAGE_HTML =
  '<div id="fxCompareStage">' +
    '<div class="overview-skeleton" id="fxSkel"><div class="skel-block skel-hero"></div><div class="skel-block skel-row"></div></div>' +
    '<div class="sr-group" id="fxSrGroup"><div class="sr-group-head"><span class="sr-group-title">2026.11</span></div></div>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
      '<button type="button" class="quick-combo-chip" id="fxChip"><span class="quick-combo-chip-title">早餐組合</span><span class="quick-combo-chip-amount">85</span></button>' +
    '</div>' +
  '</div>';

/** 元件清單：prepare 把頁面帶到該元件的狀態，target 是要截圖的元素，period 是比例的基準（毫秒）。 */
const COMPONENTS = [
  { key: 'tabs-expense', page: 'bookkeeping', target: '#pageBookkeeping .head .tabs', period: 4000 },
  { key: 'tabs-income', page: 'bookkeeping', target: '#pageBookkeeping .head .tabs', period: 4000,
    prepare: async p => { await p.locator('#pageBookkeeping .head .tab[data-tab="income"]').click(); await p.waitForTimeout(800); } },
  { key: 'submit', page: 'bookkeeping', target: '#expenseSubmit', period: 5000, pad: 6,
    prepare: async p => {
      await p.locator('#pageBookkeeping .head .tab[data-tab="expense"]').click();
      await p.waitForTimeout(500);
      await p.locator('#expenseKeypad .key:text-is("1")').first().click();
      await p.waitForTimeout(500);
    } },
  { key: 'today-card', page: 'bookkeeping', target: '#todayExpenseCard', period: 6000, pad: 4 },
  { key: 'skeleton', page: 'bookkeeping', target: '#fxSkel', period: 1680, stage: true },
  { key: 'flash-sr-group', page: 'bookkeeping', target: '#fxSrGroup', period: 1260, pad: 6, stage: true, flash: ['#fxSrGroup', 'is-flash'] },
  { key: 'flash-chip', page: 'bookkeeping', target: '#fxChip', period: 600, pad: 4, stage: true, flash: ['#fxChip', 'just-applied'] },
  { key: 'flash-payment', page: 'bookkeeping', target: '#paymentChoices .choice', period: 600, pad: 8, flash: ['#paymentChoices .choice', 'auto-applied'] },
  { key: 'ov-hero', page: 'overview', target: '#pageOverview .ov-hero', period: 6000, pad: 4 },
  { key: 'ov-card-1', page: 'overview', target: '#pageOverview .ov-card:not(.oc-error) >> nth=0', period: 6000, pad: 4 },
  { key: 'ov-card-2', page: 'overview', target: '#pageOverview .ov-card:not(.oc-error) >> nth=1', period: 6000, pad: 4 },
  { key: 'ov-card-last', page: 'overview', target: '#pageOverview .ov-card:not(.oc-error) >> nth=-1', period: 6000, pad: 4 },
  { key: 'fx-stat-card', page: 'foreign', target: '#pageForeign .fx-stat-card >> nth=0', period: 6000, pad: 4,
    prepare: async p => {
      await p.locator('#pageForeign .fx-ledger-card').first().click();
      await p.waitForTimeout(1500);
      await p.locator('#fxTabStats').click();
      await p.waitForTimeout(1500);
    } },
].filter(c => !ONLY || ONLY.has(c.key));

async function serve(root) {
  const app = createDevApp({ root, fixture: true, quiet: true });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + app.server.address().port + '/', close: () => new Promise(r => app.server.close(r)) };
}

async function openApp(browser, url, theme, device) {
  const context = await browser.newContext({
    viewport: device.viewport, deviceScaleFactor: 2, isMobile: device.isMobile, hasTouch: device.hasTouch,
    locale: 'zh-TW', timezoneId: 'Asia/Taipei', colorScheme: theme,
  });
  await context.addInitScript(p => { try { localStorage.setItem('FAST_BOOKKEEPING_PREFS_V1', JSON.stringify(p)); } catch (e) {} }, PREFS);
  // 定格之後，Ambient 的離屏偵測（IntersectionObserver）可能在截圖前又把動畫 play() 回來；定格期間一律擋掉
  await context.addInitScript(() => {
    const play = Animation.prototype.play;
    Animation.prototype.play = function () { if (window.__fxFrozen) return undefined; return play.call(this); };
  });
  const page = await context.newPage();
  page.on('pageerror', e => console.warn('  [頁面錯誤] ' + e.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.classList.contains('boot-ready') && !document.getElementById('bootLoader'), null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.addStyleTag({ content: INJECT_STYLE });
  return { context, page };
}

async function goPage(page, key) {
  await page.evaluate(k => { if (document.body.dataset.page !== k) switchPage(k); }, key);
  await page.waitForTimeout(2500);
}

async function setup(page, comp) {
  await goPage(page, comp.page);
  if (comp.stage) {
    await page.evaluate(html => {
      if (document.getElementById('fxCompareStage')) return;
      const host = document.querySelector('.page-container.active');
      host.insertAdjacentHTML('afterbegin', html);
    }, STAGE_HTML);
  }
  if (comp.prepare) await comp.prepare(page);
  const loc = page.locator(comp.target).first();
  await loc.evaluate(el => el.scrollIntoView({ block: 'center' }));
  // 捲進畫面才觸發的進場動畫（卡片錯開淡入、數字跳動）要先跑完，否則新舊版會停在不同的進度
  await page.waitForTimeout(1800);
  return loc;
}

/** 觸發一次性動畫：拿掉再加上 class，接著立刻全部定格（之後再逐一設定時間）。 */
async function trigger(page, flash) {
  await page.evaluate(([sel, cls]) => {
    const el = document.querySelector(sel);
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    window.__fxFrozen = true;
    document.getAnimations().forEach(a => a.pause());
  }, flash);
}

async function freeze(page, ms) {
  await page.evaluate(t => {
    window.__fxFrozen = true;
    document.getAnimations().forEach(a => {
      a.pause();
      // 一次性的進場／轉場動畫一律停在結尾；常駐與正在比對的閃光停在 t
      const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
      const infinite = timing && timing.iterations === Infinity;
      const name = a.animationName || '';
      const isFlash = /Flash$/.test(name);
      if (infinite || isFlash) a.currentTime = t;
      else if (timing && isFinite(timing.endTime)) a.currentTime = timing.endTime;
    });
    if (window.__bgDebug) window.__bgDebug.setTime(0);
  }, ms);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))));
}

async function shoot(page, loc, file, pad) {
  const box = await loc.boundingBox();
  if (!box) throw new Error('找不到元素');
  const p = pad || 0;
  const vp = page.viewportSize();
  const x = Math.max(0, Math.floor(box.x - p));
  const y = Math.max(0, Math.floor(box.y - p));
  const clip = { x, y, width: Math.min(vp.width - x, Math.ceil(box.width + p * 2)), height: Math.min(vp.height - y, Math.ceil(box.height + p * 2)) };
  await page.screenshot({ path: file, clip, animations: 'allow', caret: 'hide' });
  return fs.readFileSync(file);
}

function diff(a, b, file) {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  const w = Math.min(A.width, B.width);
  const h = Math.min(A.height, B.height);
  const crop = (png) => {
    if (png.width === w && png.height === h) return png.data;
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) png.data.copy(out, y * w * 4, y * png.width * 4, y * png.width * 4 + w * 4);
    return out;
  };
  const da = crop(A);
  const db = crop(B);
  const out = new PNG({ width: w, height: h });
  const pixels = pixelmatch(da, db, out.data, w, h, { threshold: 0.1 });
  fs.writeFileSync(file, PNG.sync.write(out));
  let max = 0;
  let sum = 0;
  for (let i = 0; i < da.length; i += 4) {
    for (let c = 0; c < 3; c++) { const d = Math.abs(da[i + c] - db[i + c]); sum += d; if (d > max) max = d; }
  }
  return {
    percent: Math.round(pixels / (w * h) * 1e5) / 1e3, maxChannel: max, meanChannel: Math.round(sum / (w * h * 3) * 100) / 100,
    sizeChanged: A.width !== B.width || A.height !== B.height ? [A.width + '×' + A.height, B.width + '×' + B.height] : null,
  };
}

const browser = await chromium.launch();
const oldApp = await serve(OLD);
const newApp = await serve(NEW);
const rows = [];
try {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  console.log('特效比對：舊版 ' + path.relative(ROOT, OLD) + ' ↔ 新版 ' + path.relative(ROOT, NEW));
  for (const device of DEVICES) {
    for (const theme of ['light', 'dark']) {
      for (const comp of COMPONENTS) {
        const o = await openApp(browser, oldApp.url, theme, device);
        const n = await openApp(browser, newApp.url, theme, device);
        try {
          const locs = [];
          for (const app of [o, n]) locs.push(await setup(app.page, comp));
          for (const f of FRACTIONS) {
            const t = Math.round(comp.period * f);
            const imgs = [];
            for (const [i, label] of [[0, 'old'], [1, 'new']]) {
              const app = i ? n : o;
              if (comp.flash) await trigger(app.page, comp.flash);
              await freeze(app.page, t);
              const file = path.join(OUT, [device.key, theme, comp.key, Math.round(f * 100) + 'pct', label].join('-') + '.png');
              imgs.push(await shoot(app.page, locs[i], file, comp.pad));
            }
            const r = diff(imgs[0], imgs[1], path.join(OUT, [device.key, theme, comp.key, Math.round(f * 100) + 'pct', 'diff'].join('-') + '.png'));
            rows.push({ device: device.key, theme, component: comp.key, fraction: f, ...r });
            console.log('  ' + device.key.padEnd(7) + theme.padEnd(6) + comp.key.padEnd(17) + String(Math.round(f * 100)).padStart(3) + '%：差異 ' +
              r.percent + '%、單通道最大差 ' + r.maxChannel + '、平均差 ' + r.meanChannel + (r.sizeChanged ? '、尺寸不同 ' + r.sizeChanged.join(' → ') : '') +
              (r.percent >= 1 ? '  ✗' : ''));
          }
        } catch (e) {
          console.warn('  ' + device.key.padEnd(7) + theme.padEnd(6) + comp.key.padEnd(17) + '略過：' + e.message.split('\n')[0]);
          rows.push({ device: device.key, theme, component: comp.key, skipped: e.message.split('\n')[0] });
        } finally {
          await o.context.close();
          await n.context.close();
        }
      }
    }
  }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(rows, null, 2) + '\n');
  const done = rows.filter(r => !r.skipped);
  const worst = done.reduce((a, r) => (!a || r.percent > a.percent ? r : a), null);
  console.log('共 ' + done.length + ' 張比對' + (rows.length - done.length ? '、略過 ' + (rows.length - done.length) + ' 組' : '') +
    (worst ? '；最大差異 ' + worst.percent + '%（' + [worst.device, worst.theme, worst.component, worst.fraction * 100 + '%'].join(' ') + '）' : ''));
  console.log('輸出：' + path.relative(ROOT, OUT) + '/');
  if (done.some(r => r.percent >= 1)) process.exitCode = 1;
} finally {
  await browser.close();
  await oldApp.close();
  await newApp.close();
}
