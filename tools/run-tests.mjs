#!/usr/bin/env node
// 測試啟動腳本：自己列出測試檔，再交給 node --test 執行。
//
//   node tools/run-tests.mjs                          執行 tools/test/*.test.mjs
//   node tools/run-tests.mjs tools/test tools/x       執行多個資料夾的 *.test.mjs
//   npm test -- --test-reporter=tap                   額外參數原樣轉給 node --test
//
// 為什麼不直接寫 node --test tools/test/：Node 21 之後 --test 的參數改成 glob 比對，
// 傳資料夾在 Node 22／24 會被當成要執行的檔案（Cannot find module），一項測試都不跑；
// 而 glob 一個檔案都沒比對到時又會「0 項測試、成功結束」。這裡改成自己列出檔案，
// 任何一個資料夾不存在或裡面沒有測試檔就直接失敗。
//
// 參數規則：開頭的非旗標參數是測試資料夾（相對於專案根目錄）；
// 從第一個以 - 開頭的參數起，其餘全部轉給 node --test（npm test -- … 的參數會接在最後面）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE = /\.test\.mjs$/;

const argv = process.argv.slice(2);
const firstFlag = argv.findIndex(arg => arg.startsWith('-'));
const dirs = firstFlag === -1 ? argv : argv.slice(0, firstFlag);
const forwarded = firstFlag === -1 ? [] : argv.slice(firstFlag);
if (!dirs.length) dirs.push('tools/test');

function fail(message) {
  console.error('✖ ' + message);
  process.exit(1);
}

const files = [];
dirs.forEach(dir => {
  const abs = path.resolve(ROOT, dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) fail('找不到測試資料夾：' + dir);
  const found = fs.readdirSync(abs)
    .filter(name => TEST_FILE.test(name) && fs.statSync(path.join(abs, name)).isFile())
    .sort()
    .map(name => path.relative(ROOT, path.join(abs, name)).split(path.sep).join('/'));
  if (!found.length) fail('測試資料夾裡沒有任何 *.test.mjs：' + dir);
  files.push(...found);
});

const result = spawnSync(process.execPath, ['--test', ...forwarded, ...files], { cwd: ROOT, stdio: 'inherit' });
if (result.error) fail('無法啟動 node --test：' + result.error.message);
process.exit(result.status === null ? 1 : result.status);
