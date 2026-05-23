/**
 * splitTextToChunks 单元测试
 * 运行: cd client/src && npx tsx ts/utils/splitTextToChunks.test.ts
 */
import assert from "assert";
import { splitTextToChunks } from "../../shared/cross/semanticUtils";

const enc = new TextEncoder();
const b = (s: string) => enc.encode(s).byteLength;

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

/** 验证 chunks 文本、startOffset 均正确，且拼接还原原文 */
function expectChunks(text: string, limit: number, expectedTexts: string[]) {
    const chunks = splitTextToChunks(text, limit);
    assert.strictEqual(chunks.length, expectedTexts.length,
        `chunk 数量: expected ${expectedTexts.length}, got ${chunks.length} — ${JSON.stringify(chunks.map(c => c.text))}`);
    for (let i = 0; i < chunks.length; i++) {
        assert.strictEqual(chunks[i].text, expectedTexts[i],
            `chunk[${i}].text: expected ${JSON.stringify(expectedTexts[i])}, got ${JSON.stringify(chunks[i].text)}`);
        // startOffset 必须是正确的字符索引
        assert.strictEqual(
            text.slice(chunks[i].startOffset, chunks[i].startOffset + chunks[i].text.length),
            chunks[i].text,
            `chunk[${i}].startOffset=${chunks[i].startOffset} 指向错误位置`
        );
    }
    assert.strictEqual(chunks.map(c => c.text).join(""), text, "拼接后与原文不一致");
}

// ── 1. Guard 校验 ──────────────────────────────────────────────────────────────
console.log("1. Guard 校验");

test("bytesPerChunk=0 抛错", () => {
    assert.throws(() => splitTextToChunks("hello", 0), /必须大于 0/);
});
test("bytesPerChunk=-1 抛错", () => {
    assert.throws(() => splitTextToChunks("hello", -1), /必须大于 0/);
});
test("文本含 \\r 抛错", () => {
    assert.throws(() => splitTextToChunks("hello\r\nworld", 512), /\\r/);
});

// ── 2. 空文本（outer while 不进入）──────────────────────────────────────────────
console.log("2. 空文本");

test("空字符串返回空数组", () => {
    expectChunks("", 10, []);
});

// ── 3. 正常路径：多行累积不超限（内层 while 自然退出）─────────────────────────
console.log("3. 正常路径（行累积）");

test("单行无换行，整体放入一个 chunk", () => {
    expectChunks("hello world", 100, ["hello world"]);
});
test("多行全部累积入一个 chunk", () => {
    // "a\n"=2B + "b\n"=2B + "c\n"=2B = 6B ≤ 10
    expectChunks("a\nb\nc\n", 10, ["a\nb\nc\n"]);
});
test("末行无换行（nextLineEnd 返回 text.length）", () => {
    // "aaa\n"=4B ≤ 5，"bb"=2B：4+2=6>5 → break，chunk1="aaa\n"；chunk2="bb"
    expectChunks("aaa\nbb", 5, ["aaa\n", "bb"]);
});

// ── 4. chunkBytes > 0 && wouldExceed → break（行级拆分）─────────────────────
console.log("4. 行级拆分（chunkBytes>0 超限）");

test("两行各自放入独立 chunk", () => {
    // "aaa\n"=4B，"bbb\n"=4B，limit=5：先放"aaa\n"(4B)，再加"bbb\n"→ 8>5 → break
    expectChunks("aaa\nbbb\n", 5, ["aaa\n", "bbb\n"]);
});
test("三行（无段落边界）：贪婪行模式填满 chunk", () => {
    // 整段 "aa\nbb\ncc\n"=9B > 6 → 行模式贪婪消费
    // "aa\n"(3B) + "bb\n"(3B) = 6B ≤ 6 → 合并；"cc\n"(3B) → 3+3>6 → break
    // chunk1="aa\nbb\n"；下一轮: "cc\n"=3B ≤ 6 → 整段入 chunk
    expectChunks("aa\nbb\ncc\n", 6, ["aa\nbb\n", "cc\n"]);
});

// ── 5. 连续换行（nextLineEnd 的 while 分支）──────────────────────────────────
console.log("5. 连续换行");

test("连续换行作为一行整体", () => {
    // "a\n\n\nb" limit=100 → 一个 chunk
    expectChunks("a\n\n\nb", 100, ["a\n\n\nb"]);
});
test("连续换行导致跨 chunk 分割", () => {
    // "ab\n\n"=4B，"cd\n"=3B，limit=6：4+3=7>6 → "ab\n\n" / "cd\n"
    expectChunks("ab\n\ncd\n", 6, ["ab\n\n", "cd\n"]);
});

// ── 6. 单行超长：findSplitPoint 第一优先级命中 ─────────────────────────────
console.log("6. 单行超长：句子级分隔符");

test("句号在 maxEnd 范围内，按句号切分", () => {
    // "A。BB" → b("A。")=1+3=4B，limit=4
    // maxEnd = charIndexForByteLimit("A。BB", 0, 4) = 2（A=1B,。=3B,累计4≤4→i=2; B→5>4→stop）
    // window="A。", 。在 idx=1, bestEnd=2 → chunk="A。"
    expectChunks("A。BB", 4, ["A。", "BB"]);
});
test("感叹号切分", () => {
    // "Hi!World" limit=7：maxEnd=7, window="Hi!Worl", "!"在idx=2,bestEnd=3 → "Hi!"；剩余"World"=5B≤7
    expectChunks("Hi!World", 7, ["Hi!", "World"]);
});
test("同组多个句子符取最靠右", () => {
    // "A.B.CCC" limit=4：maxEnd=4, window="A.B.", "."在1和3，rightmost bestEnd=4 → "A.B."
    expectChunks("A.B.CCC", 4, ["A.B.", "CCC"]);
});

// ── 7. 单行超长：第一优先级无命中，第二优先级命中 ──────────────────────────
console.log("7. 单行超长：子句级分隔符");

test("逗号切分（ASCII）", () => {
    // "AAAA,BBBB" limit=6：maxEnd=6, window="AAAA,B", 无句子符，","在idx=4,bestEnd=5 → "AAAA,"
    expectChunks("AAAA,BBBB", 6, ["AAAA,", "BBBB"]);
});
test("中文逗号切分", () => {
    // "你好，世界啊" → b("你好，")=3+3+3=9B, limit=9
    // maxEnd = charIndexForByteLimit(..., 0, 9) = 3（"你好，"恰好9B）
    // window="你好，"，，在idx=2,bestEnd=3 → chunk="你好，"
    expectChunks("你好，世界啊", 9, ["你好，", "世界啊"]);
});

// ── 8. 单行超长：两级均无命中，回退 maxEnd ───────────────────────────────────
console.log("8. 单行超长：回退 maxEnd");

test("纯字母无分隔符，按字节边界强切", () => {
    // "ABCDEFGH" limit=4，无分隔符 → maxEnd=4 → "ABCD"，再"EFGH"
    expectChunks("ABCDEFGH", 4, ["ABCD", "EFGH"]);
});
test("中文无分隔符，按字节边界强切（每字 3B）", () => {
    // "你好世界" limit=6 → maxEnd=2（"你好"=6B）→ 无分隔符 → chunk="你好"
    expectChunks("你好世界", 6, ["你好", "世界"]);
});

// ── 9. startOffset 在多字节字符下的正确性 ──────────────────────────────────
console.log("9. startOffset 正确性（多字节字符）");

test("中文分行后 startOffset 指向正确字符索引", () => {
    // "你好\n世界\n"：b("你好\n")=7B，limit=7
    // chunk1: "你好\n"（JS idx 0-2，startOffset=0）
    // chunk2: "世界\n"（JS idx 3-5，startOffset=3）
    const text = "你好\n世界\n";
    const chunks = splitTextToChunks(text, 7);
    assert.strictEqual(chunks[0].startOffset, 0);
    assert.strictEqual(chunks[1].startOffset, 3);
    assert.strictEqual(text.slice(3), "世界\n");
});

// ── 10. Emoji 代理对（4B，JS charLen=2）不被切断 ──────────────────────────
console.log("10. Emoji 代理对不被切断");

test("😀 不被切断（charIndexForByteLimit cp>0xFFFF 分支）", () => {
    // "😀AB😀" = 4+1+1+4=10B，limit=5
    // maxEnd: 😀(4B)→i=2；A(1B)→5B≤5→i=3；B(1B)→6>5→stop，maxEnd=3
    // window="😀A"，无分隔符 → chunk="😀A"（JS chars 0-2）
    // 下一轮："B😀"=5B≤5，不超限 → chunk="B😀"
    expectChunks("😀AB😀", 5, ["😀A", "B😀"]);
});
test("纯 emoji 序列按 4B 边界切分", () => {
    // "😀😀😀" = 12B，limit=4 → 每个 emoji 独立 chunk
    expectChunks("😀😀😀", 4, ["😀", "😀", "😀"]);
});

// ── 11. 综合：超长行与正常行混合 ─────────────────────────────────────────────
console.log("11. 综合场景");

test("超长行被多次切分后，正常行继续正常累积", () => {
    // "ABCDEFGH\n" limit=4：
    //   pos=0: 行="ABCDEFGH\n"(9B)>4，maxEnd=4，无分隔符→"ABCD"，pos=4
    //   pos=4: 行仍是"ABCDEFGH\n"的剩余？不，nextLineEnd(text,4)="EFGH\n"→lineEnd=9
    //   lineText="EFGH\n"(5B)>4，maxEnd=charIndexForByteLimit("ABCDEFGH\n",4,4)=8，window="EFGH"→无→chunk="EFGH"(maxEnd=8)，pos=8
    //   pos=8: lineText="\n"(1B)≤4，chunkBytes=1，chunkEnd=9；退出内层
    //   chunk="\n"
    // "XY\n"(3B)≤4 → 一个 chunk
    const text = "ABCDEFGH\nXY\n";
    const chunks = splitTextToChunks(text, 4);
    assert.strictEqual(chunks.map(c => c.text).join(""), text);
    assert.ok(chunks.length >= 3); // "ABCD" + "EFGH" + "\nXY\n"
    for (const c of chunks) {
        assert.strictEqual(text.slice(c.startOffset, c.startOffset + c.text.length), c.text,
            `startOffset 错误: ${JSON.stringify(c)}`);
    }
});

test("中英混合文本，所有 chunk 字节数不超过 limit（含分隔符回退场景除外）", () => {
    const text = "Hello, world! 你好世界。This is a test. 测试一下，看看效果！\n";
    const limit = 20;
    const chunks = splitTextToChunks(text, limit);
    assert.strictEqual(chunks.map(c => c.text).join(""), text);
    for (const c of chunks) {
        assert.strictEqual(text.slice(c.startOffset, c.startOffset + c.text.length), c.text);
    }
});

// ── 12. 段落级切分（nextParagraphEnd）─────────────────────────────────────────
console.log("12. 段落级切分");

test("两个短段落合并入一个 chunk", () => {
    // "P1\n\n"=4B + "P2\n\n"=4B = 8B ≤ 20 → 合并
    expectChunks("P1\n\nP2\n\n", 20, ["P1\n\nP2\n\n"]);
});
test("两个段落超过 limit，各自独立成 chunk", () => {
    // "AAAA\n\n"=6B ≤ 6；"BBBB\n\n"=6B，6+6>6 → break
    expectChunks("AAAA\n\nBBBB\n\n", 6, ["AAAA\n\n", "BBBB\n\n"]);
});
test("大段落降级到行模式，贪婪填满后行末段落边界合并", () => {
    // paragraph "LINE1\nLINE2\nLINE3\n\n"=20B > 12B → 行模式贪婪消费
    // "LINE1\n"(6B) + "LINE2\n"(6B) = 12B ≤ 12 → 合并；"LINE3\n\n"(8B) → 12+8>12 → break
    // chunk1="LINE1\nLINE2\n"；剩余 "LINE3\n\n"(8B) + "FOO"(3B) = 11B ≤ 12 → 合并
    expectChunks("LINE1\nLINE2\nLINE3\n\nFOO", 12, ["LINE1\nLINE2\n", "LINE3\n\nFOO"]);
});

test("nextLineEnd while 分支：单行段落末尾 \\n\\n 不被切断", () => {
    // "AAAA,BBBB\n\n"=11B > limit=10 → 段落超限，调 nextLineEnd
    // nextLineEnd 的 while 分支消费两个 \n → lineBytes=11 > 10 → findSplitPoint
    // window="AAAA,BBBB\n"，逗号命中 → chunk="AAAA,"，\n\n 留在下一 chunk
    // 若无 while 分支：lineBytes=10 ≤ 10 → 直接加入，\n\n 被切断（"\nCCC" 开头带孤立 \n）
    expectChunks("AAAA,BBBB\n\nCCC", 10, ["AAAA,", "BBBB\n\nCCC"]);
});

// ── 结果汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
