/**
 * charIndexForByteLimit 单元测试
 * 运行: cd client/src && npx tsx ts/utils/charIndexForByteLimit.test.ts
 */
import { charIndexForByteLimit } from "../../shared/cross/semanticUtils";

let passed = 0;
let failed = 0;

function assert(desc: string, actual: number, expected: number) {
    if (actual === expected) {
        console.log(`  ✓ ${desc}`);
        passed++;
    } else {
        console.error(`  ✗ ${desc} — expected ${expected}, got ${actual}`);
        failed++;
    }
}

const enc = new TextEncoder();
function bytes(s: string) { return enc.encode(s).byteLength; }

// ── 1. 基本边界 ──────────────────────────────────────────────────────────────
console.log("1. 基本边界");
assert("空字符串，limit=0",        charIndexForByteLimit("", 0, 0), 0);
assert("空字符串，limit=10",       charIndexForByteLimit("", 0, 10), 0);
assert("limit=0 时立刻停止",       charIndexForByteLimit("abc", 0, 0), 0);
assert("limit 恰好等于全文字节数", charIndexForByteLimit("abc", 0, 3), 3);
assert("limit 大于全文字节数",     charIndexForByteLimit("abc", 0, 100), 3);

// ── 2. 纯 ASCII（每字符 1 字节）────────────────────────────────────────────
console.log("2. 纯 ASCII");
assert("limit=1 取 1 字符",  charIndexForByteLimit("hello", 0, 1), 1);
assert("limit=3 取 3 字符",  charIndexForByteLimit("hello", 0, 3), 3);
assert("limit=5 取全部",     charIndexForByteLimit("hello", 0, 5), 5);
assert("start=2，limit=2",   charIndexForByteLimit("hello", 2, 2), 4);

// ── 3. CJK（每字符 3 字节）──────────────────────────────────────────────────
console.log("3. CJK 字符（3 字节/字）");
const cjk = "你好世界"; // 4 字符，12 字节
assert("limit=3  → 1 字符",  charIndexForByteLimit(cjk, 0, 3),  1);
assert("limit=4  → 1 字符（中间切不开）", charIndexForByteLimit(cjk, 0, 4), 1);
assert("limit=6  → 2 字符",  charIndexForByteLimit(cjk, 0, 6),  2);
assert("limit=11 → 3 字符",  charIndexForByteLimit(cjk, 0, 11), 3);
assert("limit=12 → 4 字符",  charIndexForByteLimit(cjk, 0, 12), 4);
assert("start=1，limit=3 → idx=2", charIndexForByteLimit(cjk, 1, 3), 2);

// ── 4. Emoji（4 字节，JS 代理对长度=2）──────────────────────────────────────
console.log("4. Emoji（4 字节/字，JS charLen=2）");
const emoji = "😀🎉🚀"; // 3 emoji，12 字节，JS length=6
assert("emoji limit=4  → idx=2（1 emoji）", charIndexForByteLimit(emoji, 0, 4),  2);
assert("emoji limit=5  → idx=2（切不开）",  charIndexForByteLimit(emoji, 0, 5),  2);
assert("emoji limit=8  → idx=4（2 emoji）", charIndexForByteLimit(emoji, 0, 8),  4);
assert("emoji limit=12 → idx=6（全部）",    charIndexForByteLimit(emoji, 0, 12), 6);
assert("emoji start=2，limit=4 → idx=4",   charIndexForByteLimit(emoji, 2, 4),  4);

// ── 5. 混合 ASCII + CJK + Emoji ─────────────────────────────────────────────
console.log("5. 混合字符");
// "A好😀" = 1+3+4 = 8 字节，JS length=4
const mixed = "A好😀";
assert("混合 limit=1 → 1(A)",       charIndexForByteLimit(mixed, 0, 1), 1);
assert("混合 limit=3 → 1(A不够好)", charIndexForByteLimit(mixed, 0, 3), 1);
assert("混合 limit=4 → 2(A好)",     charIndexForByteLimit(mixed, 0, 4), 2);
assert("混合 limit=7 → 2(不够emoji)",charIndexForByteLimit(mixed, 0, 7), 2);
assert("混合 limit=8 → 4(全部)",    charIndexForByteLimit(mixed, 0, 8), 4);
assert("混合 start=1，limit=3 → 2(好)", charIndexForByteLimit(mixed, 1, 3), 2);

// ── 6. start 超出文本末尾 ────────────────────────────────────────────────────
console.log("6. start >= text.length");
assert("start=5 on 'abc' → 5", charIndexForByteLimit("abc", 5, 10), 5);

// ── 7. 换行符（属于 ASCII，1 字节）─────────────────────────────────────────
console.log("7. 含换行符");
const nl = "a\nb\n";
assert("换行 limit=2 → 2",  charIndexForByteLimit(nl, 0, 2), 2);
assert("换行 limit=3 → 3",  charIndexForByteLimit(nl, 0, 3), 3);

// ── 结果汇总 ─────────────────────────────────────────────────────────────────
console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
