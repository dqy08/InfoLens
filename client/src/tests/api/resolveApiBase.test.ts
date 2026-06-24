/**
 * 运行: cd client/src && npx tsx tests/api/resolveApiBase.test.ts
 */
import {
    normalizeApiBase,
    resolveApiBaseFromSources,
    apiUrl,
    PORTAL_API_BASE,
} from '../../shared/api/resolveApiBase';
import { resolveDemoFileUrlFromBase } from '../../shared/api/apiConfig';

let passed = 0;
let failed = 0;

function assert(desc: string, actual: string, expected: string) {
    if (actual === expected) {
        console.log(`  ✓ ${desc}`);
        passed++;
    } else {
        console.error(`  ✗ ${desc} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        failed++;
    }
}

console.log('normalizeApiBase');
assert('strip trailing slash', normalizeApiBase('https://example.com/'), 'https://example.com');
assert('empty', normalizeApiBase('  '), '');

console.log('resolveApiBaseFromSources');
assert('meta wins', resolveApiBaseFromSources('http://other', 'https://portal.hf.space'), 'https://portal.hf.space');
assert('meta wins over empty param', resolveApiBaseFromSources('', PORTAL_API_BASE), PORTAL_API_BASE);
assert('?api= when no meta', resolveApiBaseFromSources('http://localhost:5001', null), 'http://localhost:5001');
assert('same-origin default', resolveApiBaseFromSources(undefined, null), '');
assert('same-origin when meta empty', resolveApiBaseFromSources(undefined, '  '), '');

console.log('resolveDemoFileUrlFromBase');
assert(
    'portal + demo path',
    resolveDemoFileUrlFromBase(PORTAL_API_BASE, '/quick-start-1.json'),
    'https://dqy08-infolens.hf.space/demo/quick-start-1.json',
);
assert(
    'same-origin demo',
    resolveDemoFileUrlFromBase('', '/InfoHighlight-intro.json'),
    '/demo/InfoHighlight-intro.json',
);

console.log('apiUrl');
assert('portal api path', apiUrl('/api/analyze', PORTAL_API_BASE), `${PORTAL_API_BASE}/api/analyze`);
assert('same-origin api', apiUrl('/api/tokenize', ''), '/api/tokenize');
assert('empty base explicit', apiUrl('/api/check_admin', ''), '/api/check_admin');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
