/**
 * IH_paintTokens 计数：skip_level / skip_empty_range / painted。
 * 用假 Range / CSS.highlights，不改画阈值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));

const storageListeners = [];

class FakeRange {
  constructor() {
    this.startContainer = null;
    this.startOffset = 0;
    this.endContainer = null;
    this.endOffset = 0;
    this.collapsed = true;
  }
  setStart(node, offset) {
    this.startContainer = node;
    this.startOffset = offset;
    this.collapsed = this.endContainer === node && this.endOffset <= offset;
  }
  setEnd(node, offset) {
    this.endContainer = node;
    this.endOffset = offset;
    this.collapsed = this.startContainer === node && offset <= this.startOffset;
  }
  toString() {
    const data = this.startContainer?.data || '';
    return data.slice(this.startOffset, this.endOffset);
  }
  getClientRects() {
    return FakeRange.clientRects;
  }
}
FakeRange.clientRects = [{ width: 8, height: 10 }];

class FakeHighlight {
  constructor() {
    this.priority = 0;
    this.ranges = [];
  }
  add(r) {
    this.ranges.push(r);
  }
  delete(r) {
    this.ranges = this.ranges.filter((x) => x !== r);
  }
  clear() {
    this.ranges = [];
  }
  *[Symbol.iterator]() {
    yield* this.ranges;
  }
}

const hlMap = new Map();
globalThis.Highlight = FakeHighlight;
globalThis.CSS = {
  highlights: {
    has: (k) => hlMap.has(k),
    get: (k) => hlMap.get(k),
    set: (k, v) => hlMap.set(k, v),
    values: () => hlMap.values(),
  },
};
globalThis.document = {
  createRange: () => new FakeRange(),
  createElement: () => ({ style: {}, className: '' }),
  createDocumentFragment: () => ({ appendChild() {} }),
  documentElement: { style: { setProperty() {} } },
};
globalThis.IL_progressAxis = {
  measureChunkContentY() {},
  tileProgressRows() {
    return [];
  },
};
globalThis.IL_pdfTextLayer = {
  scaleOf: () => 1,
  underlinePos: () => ({ x: 0, y: 0 }),
};
globalThis.chrome = {
  storage: {
    local: { get(_defaults, cb) { cb?.({ show_progress: false }); } },
    onChanged: { addListener(fn) { storageListeners.push(fn); } },
  },
};

runInThisContext(readFileSync(join(dir, '../../shared/page/textIndex.js'), 'utf8'), {
  filename: 'textIndex.js',
});
runInThisContext(readFileSync(join(dir, '../highlightStyle.js'), 'utf8'), {
  filename: 'highlightStyle.js',
});
runInThisContext(readFileSync(join(dir, '../wordMerge.js'), 'utf8'), {
  filename: 'wordMerge.js',
});
runInThisContext(readFileSync(join(dir, '../page-map.js'), 'utf8'), {
  filename: 'page-map.js',
});

function mappedFor(text, { connected = true } = {}) {
  const node = { data: text, isConnected: connected };
  return {
    text,
    pieces: [{ node, start: 0, end: text.length }],
    root: {
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 100, height: 20 };
      },
      appendChild() {},
    },
  };
}

/** p≈0.01 → bits≈6.6 → level≥1；p≈0.9 → level 被压成 -1 */
const HOT = 0.01;
const COLD = 0.9;

test('skip_level：低 surprisal 或 bits 为空', () => {
  const mapped = mappedFor('Hello');
  const stats = globalThis.IH_paintTokens(
    [
      { offset: [0, 5], p: COLD },
      { offset: [0, 5] },
    ],
    mapped,
    { append: true },
  );
  assert.deepEqual(stats, {
    painted: 0,
    tokens_in: 2,
    tokens_skip_level: 2,
    tokens_skip_empty_range: 0,
  });
});

test('p=0：与站点 calculateSurprisal 同，EPSILON 托底，高 surprisal 要画', () => {
  assert.equal(globalThis.IH_tokenBits({ p: 0 }), -Math.log2(Number.EPSILON));
  const mapped = mappedFor('Hello');
  const stats = globalThis.IH_paintTokens(
    [{ offset: [0, 5], p: 0 }],
    mapped,
    { append: true },
  );
  assert.equal(stats.tokens_skip_level, 0);
  assert.equal(stats.painted, 1);
});

test('词切分合并：默认关；打开后一词一块且 bit 相加', () => {
  const text = ' unbelievable';
  const mapped = mappedFor(text);
  const hot = [
    { offset: [0, 3], p: HOT },
    { offset: [3, 9], p: HOT },
    { offset: [9, 13], p: HOT },
  ];
  const summed = [
    { offset: [0, 3], p: 0.5 },
    { offset: [3, 9], p: 0.5 },
    { offset: [9, 13], p: 0.25 },
  ];
  assert.ok(storageListeners.length, 'page-map storage listener');
  const setMerge = (on) => {
    for (const fn of storageListeners) {
      fn({ ih_word_merge: { newValue: on } }, 'local');
    }
  };

  setMerge(false);
  hlMap.clear();
  const off = globalThis.IH_paintTokens(hot, mapped, { append: false });
  assert.equal(off.tokens_in, 3);
  assert.equal(off.painted, 3);

  setMerge(true);
  hlMap.clear();
  const on = globalThis.IH_paintTokens(summed, mapped, { append: false });
  assert.equal(on.tokens_in, 1);
  assert.equal(on.tokens_skip_level, 0);
  assert.equal(on.painted, 1);
  const ranges = [...hlMap.values()].flatMap((h) => [...h]);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].toString(), text);

  setMerge(false);
});

test('painted：高 surprisal 且 range 非空白', () => {
  const mapped = mappedFor('Hello');
  const stats = globalThis.IH_paintTokens(
    [{ offset: [0, 5], p: HOT }],
    mapped,
    { append: true },
  );
  assert.equal(stats.tokens_in, 1);
  assert.equal(stats.tokens_skip_level, 0);
  assert.equal(stats.tokens_skip_empty_range, 0);
  assert.equal(stats.painted, 1);
});

test('skip_empty_range：有 level 但 range 全空白 / 节点断开', () => {
  const ws = mappedFor('Hi   there');
  const spaceOnly = globalThis.IH_paintTokens(
    [{ offset: [2, 5], p: HOT }],
    ws,
    { append: true },
  );
  assert.deepEqual(spaceOnly, {
    painted: 0,
    tokens_in: 1,
    tokens_skip_level: 0,
    tokens_skip_empty_range: 1,
  });

  const dead = mappedFor('Hello', { connected: false });
  const disconnected = globalThis.IH_paintTokens(
    [{ offset: [0, 5], p: HOT }],
    dead,
    { append: true },
  );
  assert.equal(disconnected.tokens_skip_empty_range, 1);
  assert.equal(disconnected.painted, 0);
});

test('混合：skip_level + empty + painted 分开累加', () => {
  const mapped = mappedFor('Hi   there');
  const stats = globalThis.IH_paintTokens(
    [
      { offset: [0, 2], p: COLD },
      { offset: [2, 5], p: HOT },
      { offset: [5, 10], p: HOT },
    ],
    mapped,
    { append: true },
  );
  assert.equal(stats.tokens_in, 3);
  assert.equal(stats.tokens_skip_level, 1);
  assert.equal(stats.tokens_skip_empty_range, 1);
  assert.equal(stats.painted, 1);
});

test('overlay：无 client rects 记 skip_empty_range', () => {
  const mapped = mappedFor('Hello');
  FakeRange.clientRects = [];
  try {
    const stats = globalThis.IH_paintTokens(
      [{ offset: [0, 5], p: HOT }],
      mapped,
      { append: true, overlay: true },
    );
    assert.equal(stats.tokens_skip_empty_range, 1);
    assert.equal(stats.painted, 0);
  } finally {
    FakeRange.clientRects = [{ width: 8, height: 10 }];
  }
});

test('pruneDetachedHighlights：断开的 range 丢掉，还在的留下；不碰别人的登记', () => {
  hlMap.clear();
  const live = mappedFor('Hello');
  globalThis.IH_paintTokens([{ offset: [0, 5], p: HOT }], live, { append: false });
  const painted = [...hlMap.values()].flatMap((h) => [...h]);
  assert.equal(painted.length, 1);
  painted[0].startContainer.isConnected = false;
  painted[0].endContainer.isConnected = false;
  const foreign = new FakeHighlight();
  const other = new FakeRange();
  other.startContainer = { isConnected: false, data: 'x' };
  other.endContainer = other.startContainer;
  other.collapsed = false;
  foreign.add(other);
  hlMap.set('other-hl', foreign);
  globalThis.IH_pruneDetachedHighlights();
  assert.equal([...hlMap.values()].flatMap((h) => [...h]).length, 1);
  assert.equal(foreign.ranges.length, 1);
});
