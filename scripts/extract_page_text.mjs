#!/usr/bin/env node
/**
 * 无头 Chromium 提取正文：复用扩展 Readability → articleRoot → collectTextMap。
 *
 * 用法（项目根目录）:
 *   node scripts/extract_page_text.mjs <url> -o scripts/cases/论文.txt
 *
 * 依赖：playwright（用本机 Chrome，channel=chrome）
 *   npm i --prefix scripts playwright
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

function loadPlaywright() {
  const candidates = [
    path.join(__dirname, 'node_modules', 'playwright'),
    path.join(ROOT, 'node_modules', 'playwright'),
  ];
  for (const p of candidates) {
    try {
      return require(p);
    } catch {
      /* try next */
    }
  }
  console.error(
    'playwright not found. Install with:\n  npm i --prefix scripts playwright',
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = { url: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--output') args.out = argv[++i];
    else if (a.startsWith('-')) {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    } else if (!args.url) args.url = a;
    else {
      console.error(`Unexpected arg: ${a}`);
      process.exit(2);
    }
  }
  if (!args.url || !args.out) {
    console.error('Usage: node scripts/extract_page_text.mjs <url> -o <out.txt>');
    process.exit(2);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { chromium } = loadPlaywright();

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(args.url, { waitUntil: 'networkidle', timeout: 90_000 });

    for (const rel of [
      'extension/vendor/Readability.js',
      'extension/articleRoot.js',
      'extension/collectTextMap.js',
    ]) {
      await page.addScriptTag({ path: path.join(ROOT, rel) });
    }

    const result = await page.evaluate(() => {
      const find = globalThis.IL_findArticleRoot;
      const collect = globalThis.IL_collectTextMap;
      if (typeof find !== 'function') throw new Error('IL_findArticleRoot missing');
      if (typeof collect !== 'function') throw new Error('IL_collectTextMap missing');
      const root = find(document);
      const mapped = collect(root);
      return {
        text: mapped.text,
        length: mapped.text.length,
        pieces: mapped.pieces.length,
        rootTag: root.tagName,
        rootClass: root.className,
        sample: mapped.text.slice(0, 120),
      };
    });

    if (result.text.includes('\r')) {
      throw new Error('Extracted text contains \\r (CR); refuse to write');
    }

    const outAbs = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, result.text, 'utf8');

    console.error(
      `Wrote ${result.length} chars, ${result.pieces} pieces → ${path.relative(ROOT, outAbs) || outAbs}`,
    );
    console.error(`root=<${result.rootTag} class="${result.rootClass}">`);
    console.error(`sample: ${JSON.stringify(result.sample)}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
