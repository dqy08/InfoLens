/**
 * shared/page/textIndex.js：码点 ↔ UTF-16 必须与后端 offset_mapping 逐字一致，
 * 漂移是静默错位（画到别处），所以这里按 Python 语义逐点对拍。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = readFileSync(
  fileURLToPath(new URL('../shared/page/textIndex.js', import.meta.url)),
  'utf8'
);
const sandbox = { globalThis: null };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { IL_createTextIndex, IL_findPieceIndex } = sandbox;

/** 参照实现：Python str 的码点序列 */
function cpToUtf16Ref(text, cp) {
  return [...text].slice(0, cp).join('').length;
}

test('两向转换在每个码点边界上与逐字符参照一致', () => {
  const text = 'a漢\u{1F600}b\u{1F1E8}\u{1F1F3}c';
  const idx = IL_createTextIndex(text);
  assert.equal(idx.cpLength, [...text].length);
  for (let cp = 0; cp <= idx.cpLength; cp++) {
    const u = cpToUtf16Ref(text, cp);
    assert.equal(idx.cpToUtf16(cp), u, `cpToUtf16(${cp})`);
    assert.equal(idx.utf16ToCp(u), cp, `utf16ToCp(${u})`);
  }
});

test('纯 BMP 文本两个坐标恒等', () => {
  const idx = IL_createTextIndex('hello 世界');
  assert.equal(idx.cpLength, 8);
  assert.equal(idx.cpToUtf16(8), 8);
  assert.equal(idx.utf16ToCp(6), 6);
});

test('越界夹到两端', () => {
  const idx = IL_createTextIndex('a\u{1F600}');
  assert.equal(idx.cpToUtf16(-3), 0);
  assert.equal(idx.cpToUtf16(99), 3);
  assert.equal(idx.utf16ToCp(-3), 0);
  assert.equal(idx.utf16ToCp(99), 2);
});

test('落在代理对中间归到后一个码点', () => {
  const idx = IL_createTextIndex('a\u{1F600}b');
  assert.equal(idx.utf16ToCp(2), 2);
});

test('空文本', () => {
  const idx = IL_createTextIndex('');
  assert.equal(idx.cpLength, 0);
  assert.equal(idx.cpToUtf16(0), 0);
  assert.equal(idx.utf16ToCp(0), 0);
});

test('findPieceIndex：命中、间隙、越界', () => {
  const pieces = [
    { start: 0, end: 3 },
    { start: 5, end: 9 },
    { start: 9, end: 12 },
  ];
  assert.equal(IL_findPieceIndex(pieces, 0), 0);
  assert.equal(IL_findPieceIndex(pieces, 2), 0);
  assert.equal(IL_findPieceIndex(pieces, 3), -1, 'piece 之间的空白');
  assert.equal(IL_findPieceIndex(pieces, 5), 1);
  assert.equal(IL_findPieceIndex(pieces, 9), 2, '相邻 piece 的边界归后一个');
  assert.equal(IL_findPieceIndex(pieces, 12), -1);
  assert.equal(IL_findPieceIndex([], 0), -1);
});
