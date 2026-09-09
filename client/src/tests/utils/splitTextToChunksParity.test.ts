/**
 * splitTextToChunks 双实现一致性：本仓权威 TS 实现 vs 扩展共享层的 JS 副本
 * （SYNC: extension/shared/page/splitTextToChunks.js ← semanticUtils.splitTextToChunks）。
 * 这个契约原先只靠注释维持，两份漂移不会有任何报错；这里同一组输入喂两边，断言逐字段一致。
 * 运行: cd client/src && npm run test:splitChunksParity
 */
import assert from "assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { splitTextToChunks } from "../../shared/cross/semanticUtils";

const COPY = path.resolve(__dirname, "../../../../extension/shared/page/splitTextToChunks.js");

/** 扩展那份是把函数挂到 globalThis 的 IIFE，用 vm 装出来直接调 */
function loadExtensionCopy(): typeof splitTextToChunks {
    const sandbox: Record<string, unknown> = { TextEncoder };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(fs.readFileSync(COPY, "utf8"), sandbox, { filename: COPY });
    const fn = sandbox.IL_splitTextToChunks;
    if (typeof fn !== "function") throw new Error(`IL_splitTextToChunks missing after loading ${COPY}`);
    return fn as typeof splitTextToChunks;
}

const extensionCopy = loadExtensionCopy();

let passed = 0;
let failed = 0;

function test(desc: string, fn: () => void) {
    try {
        fn();
        console.log(`  ✓ ${desc}`);
        passed++;
    } catch (e: any) {
        console.error(`  ✗ ${desc}`);
        console.error(`    ${e.message}`);
        failed++;
    }
}

/** vm 沙箱是独立 realm，返回值带的是沙箱自己的原型；重建到当前 realm 才能用 deepStrictEqual 比 */
const plain = (chunks: ReturnType<typeof splitTextToChunks>) =>
    Array.from(chunks, (c) => ({ text: c.text, startOffset: c.startOffset }));

function expectSame(text: string, limit: number) {
    assert.deepStrictEqual(
        plain(extensionCopy(text, limit)),
        plain(splitTextToChunks(text, limit)),
        `不一致 limit=${limit} text=${JSON.stringify(text)}`
    );
}

// ── 1. Guard：两边必须同样拒绝 ────────────────────────────────────────────────
console.log("1. Guard 一致");

test("bytesPerChunk ≤ 0 两边都抛", () => {
    for (const limit of [0, -1]) {
        assert.throws(() => splitTextToChunks("hello", limit), /bytesPerChunk must be > 0/);
        assert.throws(() => extensionCopy("hello", limit), /bytesPerChunk must be > 0/);
    }
});
test("文本含 \\r 两边都抛", () => {
    assert.throws(() => splitTextToChunks("a\r\nb", 512), /\\r/);
    assert.throws(() => extensionCopy("a\r\nb", 512), /\\r/);
});
test("limit 装不下单个字符时两边都抛（而非空 chunk 死循环）", () => {
    for (const [text, limit] of [["你", 2], ["😀", 3]] as Array<[string, number]>) {
        assert.throws(() => splitTextToChunks(text, limit), /cannot hold the character at 0/);
        assert.throws(() => extensionCopy(text, limit), /cannot hold the character at 0/);
    }
});

// ── 2. 枚举用例：覆盖算法各分支 ────────────────────────────────────────────────
console.log("2. 枚举用例（分支覆盖）");

const CASES: Array<[string, number[]]> = [
    ["", [10]],
    ["hello world", [4, 7, 100]],
    ["a\nb\nc\n", [3, 6, 10]],                      // 行累积
    ["aaa\nbb", [5]],                                // 末行无换行
    ["aaa\nbbb\n", [5, 8]],                          // 行级拆分
    ["a\n\n\nb", [4, 100]],                          // 连续换行
    ["P1\n\nP2\n\n", [6, 20]],                       // 段落级
    ["LINE1\nLINE2\nLINE3\n\nFOO", [12, 20]],        // 大段落降级到行模式
    ["A。BB", [4, 8]],                                // 句子级分隔符
    ["Hi!World", [7]],
    ["A.B.CCC", [4]],                                // 同组多个取最靠右
    ["AAAA,BBBB", [6, 10]],                          // 子句级分隔符
    ["你好，世界啊", [9, 12]],
    ["ABCDEFGH", [4]],                               // 无分隔符回退字节边界
    ["你好世界", [6, 7, 8]],
    ["😀AB😀", [4, 5, 6]],                            // 代理对不被切断
    ["😀😀😀", [4, 5]],
    ["AAAA,BBBB\n\nCCC", [10]],
    ["你好\n世界\n", [7]],
    ["Hello, world! 你好世界。This is a test. 测试一下，看看效果！\n", [8, 20, 64]],
    ["a".repeat(600) + "\n" + "z".repeat(900), [800]],   // 累计后遇超长行
    ["a".repeat(400) + "\n" + "b".repeat(400) + "\n" + "z".repeat(900), [800]],
    ["ABCDEFGH\nXY\n", [4]],                         // 超长行多次切分后继续累积
];

for (const [text, limits] of CASES) {
    for (const limit of limits) {
        test(`limit=${limit} ${JSON.stringify(text.length > 24 ? `${text.slice(0, 24)}…` : text)}`, () =>
            expectSame(text, limit)
        );
    }
}

// ── 3. 定种子随机语料：枚举用例覆盖不到的组合 ─────────────────────────────────
console.log("3. 定种子随机语料");

test("300 组随机文本 × 随机 limit 输出一致", () => {
    const alphabet = ["a", "b", "你", "好", "。", "！", "，", ";", ".", " ", "\n", "\n\n", "😀"];
    // limit 下限须容得下最宽的单字符（😀 4 字节）：更小的 limit 会让两份实现都不收敛，与一致性无关
    const MIN_LIMIT = 8;
    let seed = 20260909; // 固定种子：失败可复现
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 300; i++) {
        let text = "";
        const len = 1 + Math.floor(next() * 40);
        for (let j = 0; j < len; j++) text += alphabet[Math.floor(next() * alphabet.length)];
        expectSame(text, MIN_LIMIT + Math.floor(next() * 56));
    }
});

// ── 结果汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
