#!/usr/bin/env node
/**
 * 按插件分块规则切 txt（SYNC: extension/splitTextToChunks.js ← semanticUtils.splitTextToChunks）。
 *
 * 用法（项目根目录）:
 *   node scripts/semantic_chunk_txt.mjs scripts/cases/林黛玉哭.txt
 *   node scripts/semantic_chunk_txt.mjs scripts/cases/林黛玉哭.txt -o scripts/cases/林黛玉哭.chunks.json
 *   node scripts/semantic_chunk_txt.mjs scripts/cases/林黛玉哭.txt --skeleton -o scripts/cases/林黛玉哭_plugin.json
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHUNK_BYTES = 800; // SYNC: SEMANTIC_CHUNK_BYTES / extension chunkBytes

function loadSplitTextToChunks() {
  const srcPath = path.join(ROOT, 'extension', 'splitTextToChunks.js');
  const code = fs.readFileSync(srcPath, 'utf8');
  const sandbox = { TextEncoder, globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: srcPath });
  const fn = sandbox.IL_splitTextToChunks;
  if (typeof fn !== 'function') {
    throw new Error('IL_splitTextToChunks missing after loading extension/splitTextToChunks.js');
  }
  return fn;
}

function parseArgs(argv) {
  const args = { input: null, out: null, skeleton: false, query: null, bytes: CHUNK_BYTES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--output') args.out = argv[++i];
    else if (a === '--skeleton') args.skeleton = true;
    else if (a === '--query') args.query = argv[++i];
    else if (a === '--bytes') args.bytes = Number(argv[++i]);
    else if (a.startsWith('-')) {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    } else if (!args.input) args.input = a;
    else {
      console.error(`Unexpected arg: ${a}`);
      process.exit(2);
    }
  }
  if (!args.input) {
    console.error('Usage: node scripts/semantic_chunk_txt.mjs <txt> [-o out.json] [--skeleton] [--query Q] [--bytes N]');
    process.exit(2);
  }
  if (!(args.bytes > 0)) {
    console.error(`--bytes must be > 0, got ${args.bytes}`);
    process.exit(2);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const abs = path.resolve(args.input);
  const text = fs.readFileSync(abs, 'utf8');
  if (text.includes('\r')) {
    throw new Error('Text contains \\r (CR); only \\n (LF) is supported.');
  }

  const split = loadSplitTextToChunks();
  const raw = split(text, args.bytes);
  const chunks = raw
    .map((c, i) => ({ chunk_index: i, text: c.text, startOffset: c.startOffset }))
    .filter((c) => /\S/.test(c.text));

  // 过滤空白后重编号，与插件 filter(chunkHasContent) 后按序分析一致
  const contentChunks = chunks.map((c, i) => ({ ...c, chunk_index: i }));

  const relSource = path.relative(ROOT, abs) || abs;
  const stem = path.basename(abs, path.extname(abs));
  const query = args.query != null ? args.query : stem;

  let payload;
  if (args.skeleton) {
    // expect_keywords 仅在 expect_relevant=true 时有意义；无关例可留 []，关键词脚本会跳过
    payload = contentChunks.map((c) => ({
      name: `${stem}_c${c.chunk_index}`,
      source: relSource.split(path.sep).join('/'),
      chunk_index: c.chunk_index,
      query,
      text: c.text,
      expect_relevant: null,
      expect_keywords: [],
    }));
  } else {
    payload = contentChunks;
  }

  const json = JSON.stringify(payload, null, 2) + '\n';
  if (args.out) {
    const outAbs = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, json, 'utf8');
    console.error(`Wrote ${contentChunks.length} chunks → ${path.relative(ROOT, outAbs) || outAbs}`);
  } else {
    process.stdout.write(json);
  }
}

main();
