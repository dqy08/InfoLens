/**
 * 商店名/短描述。运行：node --test extension/info-highlight/test/locales.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const en = JSON.parse(readFileSync(join(dir, '../_locales/en/messages.json'), 'utf8'));
const zh = JSON.parse(readFileSync(join(dir, '../_locales/zh_CN/messages.json'), 'utf8'));

test('store name and description are present', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  assert.equal(en.extName.message, 'Info Highlight');
  assert.ok(en.extDescription.message.trim());
  assert.ok(zh.extName.message.trim());
  assert.ok(zh.extDescription.message.trim());
});
