#!/usr/bin/env node
// 一次性的圖片最佳化（P07）：把 src/client/assets/assets.js 內嵌的預設卡面重新輸出成適合實際顯示大小的 WebP，直接覆寫 assets.js。
//
//   node tools/optimize-assets.mjs            處理並覆寫（已經夠小的圖會跳過，重跑不會越壓越糊）
//   node tools/optimize-assets.mjs --check    只列出每張圖目前的尺寸與大小，不寫入
//   node tools/optimize-assets.mjs --width 480 --quality 78
//
// 卡面（PAYMENT_CARD_IMAGES）：畫面上最大只顯示成約 150px 寬的小卡片（設定頁卡片預覽），以 3 倍像素密度計算取寬 480px。
// 銀行 logo（BANK_LOGOS）：已經是 128px，維持原樣（只列出、不重新編碼，避免二次壓縮失真）。
// 使用者自訂的卡面不經過這裡（core/image-optimizer.js 在上傳時就壓到 160×100）。
// 公開 Demo 的去敏流程（tools/demo-sync）會把卡面換成 SVG 佔位圖，靠的是「鍵名: 'data:image/…'」這個格式，這裡維持不變。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'src', 'client', 'assets', 'assets.js');
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i > -1 ? Number(argv[i + 1]) : def; };
const WIDTH = opt('width', 480);
const QUALITY = opt('quality', 78);
const CHECK = argv.includes('--check');

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch (e) {
  console.error('找不到 sharp，請先在專案根目錄執行 npm install。');
  process.exit(1);
}

/** 找出某個常數物件（例如 const PAYMENT_CARD_IMAGES = { … };）裡的「鍵: 'data:image/…'」。 */
function findImages(source, constName) {
  const start = source.indexOf('const ' + constName + ' = {');
  if (start < 0) throw new Error('assets.js 裡找不到 ' + constName);
  const end = source.indexOf('\n};', start);
  const block = source.slice(start, end);
  const re = /(\n\s*)([A-Za-z_$][\w$]*)(\s*:\s*)'(data:image\/([a-z+]+);base64,([A-Za-z0-9+/=]+))'/g;
  const out = [];
  let m;
  while ((m = re.exec(block))) {
    const valueStart = start + m.index + m[1].length + m[2].length + m[3].length + 1;
    out.push({ key: m[2], uri: m[4], type: m[5], data: Buffer.from(m[6], 'base64'), at: valueStart });
  }
  return out;
}

const kb = n => (n / 1024).toFixed(1) + ' KB';
let source = fs.readFileSync(FILE, 'utf8');
const before = Buffer.byteLength(source);
const replacements = [];

for (const img of findImages(source, 'PAYMENT_CARD_IMAGES')) {
  const meta = await sharp(img.data).metadata();
  if (meta.width <= WIDTH) {
    console.log('  卡面 ' + img.key.padEnd(14) + meta.width + '×' + meta.height + '  ' + kb(img.data.length) + '（已經夠小，跳過）');
    continue;
  }
  const out = await sharp(img.data).resize({ width: WIDTH, withoutEnlargement: true }).webp({ quality: QUALITY, effort: 6, smartSubsample: true }).toBuffer();
  const outMeta = await sharp(out).metadata();
  console.log('  卡面 ' + img.key.padEnd(14) + meta.width + '×' + meta.height + ' ' + kb(img.data.length).padStart(8) + '  →  ' +
    outMeta.width + '×' + outMeta.height + ' ' + kb(out.length).padStart(8));
  replacements.push({ at: img.at, len: img.uri.length, value: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20428%20270%22%20role%3D%22img%22%20aria-label%3D%22value%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22gieyeh6%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23b5532a%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%236e2a12%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22428%22%20height%3D%22270%22%20rx%3D%2222%22%20fill%3D%22url%28%23gieyeh6%29%22%2F%3E%3Ccircle%20cx%3D%22372%22%20cy%3D%2256%22%20r%3D%22120%22%20fill%3D%22%23fff%22%20opacity%3D%22.07%22%2F%3E%3Ccircle%20cx%3D%22300%22%20cy%3D%22290%22%20r%3D%22150%22%20fill%3D%22%23fff%22%20opacity%3D%22.05%22%2F%3E%3Crect%20x%3D%2234%22%20y%3D%2292%22%20width%3D%2252%22%20height%3D%2240%22%20rx%3D%227%22%20fill%3D%22%23f3d58a%22%2F%3E%3Cpath%20d%3D%22M34%20106h52M34%20118h52M54%2092v40M68%2092v40%22%20stroke%3D%22%23b8923a%22%20stroke-width%3D%221.5%22%20fill%3D%22none%22%2F%3E%3Ctext%20x%3D%2234%22%20y%3D%2254%22%20font-family%3D%22system-ui%2C%27PingFang%20TC%27%2C%27Noto%20Sans%20TC%27%2C%27Microsoft%20JhengHei%27%2Csans-serif%22%20font-size%3D%2222%22%20font-weight%3D%22700%22%20fill%3D%22%23fff%22%3EDEMO%20BANK%3C%2Ftext%3E%3Ctext%20x%3D%2234%22%20y%3D%22186%22%20font-family%3D%22system-ui%2C%27PingFang%20TC%27%2C%27Noto%20Sans%20TC%27%2C%27Microsoft%20JhengHei%27%2Csans-serif%22%20font-size%3D%2226%22%20font-weight%3D%22700%22%20fill%3D%22%23fff%22%3Evalue%3C%2Ftext%3E%3Ctext%20x%3D%2234%22%20y%3D%22232%22%20font-family%3D%22system-ui%2C%27PingFang%20TC%27%2C%27Noto%20Sans%20TC%27%2C%27Microsoft%20JhengHei%27%2Csans-serif%22%20font-size%3D%2217%22%20letter-spacing%3D%223%22%20fill%3D%22%23fff%22%20opacity%3D%22.8%22%3E%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%20DEMO%3C%2Ftext%3E%3Ctext%20x%3D%22394%22%20y%3D%22232%22%20font-family%3D%22system-ui%2C%27PingFang%20TC%27%2C%27Noto%20Sans%20TC%27%2C%27Microsoft%20JhengHei%27%2Csans-serif%22%20font-size%3D%2215%22%20font-weight%3D%22700%22%20text-anchor%3D%22end%22%20fill%3D%22%23fff%22%20opacity%3D%22.85%22%3ECREDIT%3C%2Ftext%3E%3C%2Fsvg%3E" + out.toString('base64') });
}
for (const img of findImages(source, 'BANK_LOGOS')) {
  const meta = await sharp(img.data).metadata();
  console.log('  logo ' + img.key.padEnd(14) + meta.width + '×' + meta.height + ' ' + kb(img.data.length).padStart(8) + '（維持）');
}

if (CHECK || !replacements.length) {
  console.log(CHECK ? '（--check：未寫入）' : '沒有需要處理的圖片。');
  process.exit(0);
}
replacements.sort((a, b) => b.at - a.at).forEach(r => { source = source.slice(0, r.at) + r.value + source.slice(r.at + r.len); });
fs.writeFileSync(FILE, source);
console.log('assets.js：' + kb(before) + ' → ' + kb(Buffer.byteLength(source)));
