/**
 * findSplitPoint 单元测试
 * 运行: cd client/src && npx tsx ts/utils/findSplitPoint.test.ts
 *
 * SEPARATOR_GROUPS（内部常量，测试依赖其默认值）:
 *   Group 0（句子级）: 。！？.!?
 *   Group 1（子句级）: ；;，, （空格）
 */
import { findSplitPoint } from "../../shared/cross/semanticUtils";

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

// ── 1. 无任何分隔符 → 回退到 maxEnd ─────────────────────────────────────────
console.log("1. 无分隔符，回退 maxEnd");
assert("纯字母无分隔符",        findSplitPoint("abcdef", 0, 6), 6);
assert("start=2，仍无分隔符",   findSplitPoint("abcdef", 2, 5), 5);
assert("CJK 无分隔符",          findSplitPoint("你好世界", 0, 4), 4);

// ── 2. 优先级：句子级优先于子句级 ────────────────────────────────────────────
console.log("2. 句子级 vs 子句级优先级");
// "你好，世界。再见" → 句号在后，逗号在前；应选句号
assert("句号优先于逗号",
    findSplitPoint("你好，世界。再见", 0, 7), 6); // "世界。" 结束位置 = idx 6
// "Hello, world! foo" → 感叹号优先于逗号
assert("感叹号优先于逗号",
    findSplitPoint("Hello, world! foo", 0, 14), 13); // "world!" 结束 idx=13

// ── 3. 同组内取最靠右的 ─────────────────────────────────────────────────────
console.log("3. 同组内最靠右");
// "A.B?C" → .在idx1，?在idx3，同属句子级，取 ? 结尾(idx=4)
assert("同组取最靠右(. vs ?)",
    findSplitPoint("A.B?C", 0, 5), 4);
// "x，y。z，w"（全 JS 单字符）→ 。在 idx=3，边界=4；后面的 ，在 idx=5（group1）；group0 优先 → 返回 4
assert("句子级 。 优先于后面的 ，",
    findSplitPoint("x，y。z，w", 0, 8), 4);

// ── 4. start 偏移 ────────────────────────────────────────────────────────────
console.log("4. start 偏移");
// "abcde.fg" start=4 → window="e.fg"，. 在 window[1] → 返回 start+2=6
assert("start 偏移后找到句点",
    findSplitPoint("abcde.fg", 4, 8), 6);
// start=0 maxEnd=4 → window="abcd"，无分隔符 → 4
assert("偏移后 window 无分隔符回退",
    findSplitPoint("abcde.fg", 0, 4), 4);

// ── 5. 分隔符恰在 maxEnd 边界 ───────────────────────────────────────────────
console.log("5. 分隔符紧贴 maxEnd");
// "abc." maxEnd=4 → window 包含 . → 返回 4
assert("句点恰在 maxEnd 处",
    findSplitPoint("abc.", 0, 4), 4);
// "abc." maxEnd=3 → window="abc"，无分隔符 → 3
assert("句点刚好在 maxEnd 之外",
    findSplitPoint("abc.", 0, 3), 3);

// ── 6. 空格（子句级最低优先）─────────────────────────────────────────────────
console.log("6. 空格（最低优先级）");
assert("只有空格时选空格",
    findSplitPoint("hello world", 0, 11), 6); // "hello " 结束 idx=6
// 空格 + 逗号 → 逗号优先（同属 group1，取最靠右的）
// "hello, world test" → "，" 不存在，"," 在 idx=5，空格在 idx=12，同组取靠右 → 13（空格后）
assert("空格与逗号同组，取最靠右",
    findSplitPoint("hello, world test", 0, 17), 13);

// ── 7. 连续分隔符 ────────────────────────────────────────────────────────────
console.log("7. 连续分隔符");
// "a..b" → 两个 . 都在 group0，lastIndexOf 找到靠右的那个(idx=2) → 返回 3
assert("连续句点取靠右",
    findSplitPoint("a..b", 0, 4), 3);

// ── 8. 中文标点 ─────────────────────────────────────────────────────────────
console.log("8. 中文标点");
// "这是句子。下一句" → 。在idx4 → 返回 5
assert("中文句号",
    findSplitPoint("这是句子。下一句", 0, 8), 5);
// "这是，子句；另一" → ；在group0?不对，；在group1；，也在group1，；在idx4，，在idx2，取靠右 → idx=5
assert("中文分号优先于逗号（同组靠右）",
    findSplitPoint("这是，子句；另一", 0, 8), 6);

// ── 结果汇总 ─────────────────────────────────────────────────────────────────
console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
