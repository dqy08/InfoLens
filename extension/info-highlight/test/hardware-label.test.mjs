import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));

globalThis.chrome = {
  storage: {
    local: { get(_keys, cb) { cb?.({}); } },
    onChanged: { addListener() {} },
  },
};

runInThisContext(readFileSync(join(dir, '../tokenTip.js'), 'utf8'), { filename: 'tokenTip.js' });

const label = globalThis.IH_tokenTip.deviceLabel;

test('硬件名去掉商标和主频，型号留着', () => {
  assert.equal(label('Tesla T4'), 'Tesla T4');
  assert.equal(label('NVIDIA GeForce RTX 4090'), 'NVIDIA GeForce RTX 4090');
  assert.equal(label('Apple M2 Pro'), 'Apple M2 Pro');
  assert.equal(label('local WebGPU'), 'local WebGPU');
  assert.equal(
    label('Intel(R) Xeon(R) Platinum 8375C CPU @ 2.90GHz'),
    'Intel Xeon Platinum 8375C',
  );
  assert.equal(label('AMD EPYC 7R13 Processor'), 'AMD EPYC 7R13');
  assert.equal(label(''), '');
  assert.equal(label(undefined), '');
});
