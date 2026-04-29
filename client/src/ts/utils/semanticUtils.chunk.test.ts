/**
 * 本地测试 splitTextToChunks
 * 运行: cd client/src && npx tsx ts/utils/semanticUtils.chunk.test.ts [文件路径] [bytesPerChunk]
 * 示例: npx tsx ts/utils/semanticUtils.chunk.test.ts chunk_test1.txt 512
 */
import * as fs from "fs";
import * as path from "path";
import { splitTextToChunks } from "./semanticUtils";

const defaultFile = path.resolve(__dirname, "./chunk_test1.txt");
const testFile = path.resolve(process.argv[2] || defaultFile);
const BYTES_PER_CHUNK = parseInt(process.argv[3] || "800", 10);

const text = fs.readFileSync(testFile, "utf-8");

const chunks = splitTextToChunks(text, BYTES_PER_CHUNK);
const merged = chunks.map((c) => c.text).join("");

console.log(`文件: ${testFile}`);
console.log(`bytesPerChunk: ${BYTES_PER_CHUNK}`);
console.log(`chunk 数量: ${chunks.length}`);
console.log(`合并与原文一致: ${merged === text}`);
chunks.forEach((c, i) => {
  const bytes = Buffer.byteLength(c.text, "utf8");
  console.log(`---[${i}] ${bytes} bytes----------------------------------------------`);
  console.log(c.text);
});
