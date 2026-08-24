import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUERY = 'orangutan habitat';

/** activeTab 要手势；冒烟只给 fixture 源权限，不改仓库里的 manifest。 */
function unpackWithFixtureHost() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'il-ext-unpacked-'));
  fs.cpSync(extDir, dest, {
    recursive: true,
    filter: (src) =>
      !src.includes(`${path.sep}node_modules`) &&
      !src.includes(`${path.sep}e2e`) &&
      !src.includes(`${path.sep}test`),
  });
  const manPath = path.join(dest, 'manifest.json');
  const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
  man.host_permissions = ['http://127.0.0.1/*'];
  fs.writeFileSync(manPath, JSON.stringify(man));
  return dest;
}

function sse(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

function startFixtureServer() {
  const html = fs.readFileSync(path.join(extDir, 'e2e/fixtures/article.html'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function mockFacade(context, hits) {
  await context.route(/\/api\/(?:v2\/analyze-semantic-|extension-)/, async (route) => {
    const url = route.request().url();
    if (url.includes('analyze-semantic-version')) {
      hits.version += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, relevance: 1, keywords: 1 }),
      });
    }
    if (url.includes('analyze-semantic-relevance')) {
      hits.relevance += 1;
      const texts = JSON.parse(route.request().postData() || '{}').texts || [];
      const events = texts.map((_, i) => ({
        type: 'row',
        n: i + 1,
        full_match_degree: 0.9,
      }));
      events.push({ type: 'result' });
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse(events),
      });
    }
    if (url.includes('analyze-semantic-keywords')) {
      hits.keywords += 1;
      const text = JSON.parse(route.request().postData() || '{}').text || '';
      const needle = 'orangutan';
      const i = text.toLowerCase().indexOf(needle);
      const start = i >= 0 ? i : 0;
      const end = i >= 0 ? i + needle.length : Math.min(8, text.length);
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse([
          { type: 'row', offset: [start, end], raw: text.slice(start, end), score: 0.9 },
          { type: 'result' },
        ]),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });
}

test('webpage find: inject, search, highlight', async () => {
  if (!fs.existsSync(path.join(extDir, 'config.js'))) {
    throw new Error('missing extension/config.js — run ./extension/dev-env.sh prod (or dev)');
  }

  const fixture = await startFixtureServer();
  const unpacked = unpackWithFixtureHost();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'il-ext-e2e-'));
  const hits = { version: 0, relevance: 0, keywords: 0 };
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: process.env.IL_E2E_HEADLESS === '1',
      args: [
        `--disable-extensions-except=${unpacked}`,
        `--load-extension=${unpacked}`,
      ],
    });
    await mockFacade(context, hits);

    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');

    const page = context.pages()[0] || (await context.newPage());
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });

    await sw.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === pageUrl);
      if (!tab) throw new Error(`no tab for ${pageUrl}; have ${tabs.map((t) => t.url).join(',')}`);
      await activateTab(tab);
    }, page.url());

    const root = page.locator('#il-find-root');
    await expect(root).toBeAttached({ timeout: 15_000 });
    const input = root.locator('#semantic_find_input');
    await expect(input).toBeVisible();
    await input.fill(QUERY);
    await input.press('Enter');

    await expect
      .poll(
        async () => {
          const err = page.locator('#il-find-root .semantic-find-status-label.is-error');
          if ((await err.count()) > 0) {
            throw new Error(await err.first().innerText());
          }
          return page.evaluate(() => {
            let n = 0;
            for (const name of CSS.highlights.keys()) {
              if (
                name.startsWith('il-token-') ||
                name === 'il-underline' ||
                name === 'il-pending-underline'
              ) {
                n += CSS.highlights.get(name).size;
              }
            }
            return n;
          });
        },
        { timeout: 20_000 }
      )
      .toBeGreaterThan(0);

    expect(hits.relevance, 'relevance SW fetch was not mocked').toBeGreaterThan(0);
    expect(hits.keywords, 'keywords SW fetch was not mocked').toBeGreaterThan(0);
  } finally {
    await context?.close();
    await fixture.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(unpacked, { recursive: true, force: true });
  }
});
