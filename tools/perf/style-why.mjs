#!/usr/bin/env node
// 查某個元素的某個屬性由哪些規則提供（P07 除錯用）：列出命中的規則、所在的層與 !important，新舊樣式各一次。
//   node tools/perf/style-why.mjs --base <舊 dist> --state page-bookkeeping --sel '#themeToggleBtn' --prop transform [--force active,hover] [--desktop]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { STATES, startFixtureApp, openBootedPage, prepare } from './ui-states.mjs';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
const readMain = dir => fs.readFileSync(path.join(dir, 'style.html'), 'utf8').replace(/^<style>\n/, '').replace(/<\/style>\n?$/, '');
const app = await startFixtureApp(path.resolve(args.dist || 'dist'));
const browser = await chromium.launch();
const desktop = Boolean(args.desktop);
const { context, page } = await openBootedPage(browser, app.url, desktop ? { viewport: { width: 1280, height: 900 }, isMobile: false } : {});
const cdp = await context.newCDPSession(page);
await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
await prepare(page, STATES.find(s => s.key === (args.state || 'page-bookkeeping')));
if (args.motion) await page.evaluate(m => document.documentElement.setAttribute('data-motion', m), args.motion);
for (const [label, css] of [['舊', readMain(path.resolve(args.base))], ['新', null]]) {
  if (css != null) await page.evaluate(t => { const el = Array.from(document.querySelectorAll('style')).find(s => !s.id && !s.closest('svg')); window.__keep = el.textContent; el.textContent = t; }, css);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: args.sel });
  if (args.force) await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: String(args.force).split(',') });
  const m = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
  const value = await page.evaluate(([s, p, ps]) => getComputedStyle(document.querySelector(s), ps || null).getPropertyValue(p), [args.sel, args.prop, args.pseudo]);
  console.log('\n== ' + label + '：' + args.prop + ' = ' + value);
  const list = args.pseudo ? ((m.pseudoElements || []).find(p => '::' + p.pseudoType === args.pseudo) || { matches: [] }).matches : m.matchedCSSRules;
  list.forEach(r => {
    const props = r.rule.style.cssProperties.filter(p => p.name === args.prop && p.text);
    if (!props.length) return;
    const layer = (r.rule.layers || []).map(l => l.text).join('.');
    props.forEach(p => console.log('  ' + (layer ? '[' + layer + '] ' : '') + r.rule.selectorList.text.replace(/\s+/g, ' ').slice(0, 140) + '  { ' + p.text + ' }'));
  });
  if (css != null) await page.evaluate(() => { const el = Array.from(document.querySelectorAll('style')).find(s => !s.id && !s.closest('svg')); el.textContent = window.__keep; });
}
await browser.close(); await app.close();
