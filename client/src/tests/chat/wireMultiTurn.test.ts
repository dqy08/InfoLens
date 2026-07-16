/**
 * Wire multi-turn continuation decisions
 * 运行: cd client/src && npx tsx tests/chat/wireMultiTurn.test.ts
 */
import { TOOL_CATALOG } from '../../features/chat/toolCatalog';
import { entriesToToolConfig } from '../../features/chat/toolConfig';
import { decideToolRoundContinuation } from '../../features/chat/wireMultiTurn';

let passed = 0;
let failed = 0;

function assert(label: string, cond: boolean): void {
    if (cond) {
        passed++;
        console.log(`  ✓ ${label}`);
    } else {
        failed++;
        console.log(`  ✗ ${label}`);
    }
}

const tempEntry = TOOL_CATALOG.find((e) => e.function.name === 'get_current_temperature')!;
const config = entriesToToolConfig([tempEntry]);

console.log('decideToolRoundContinuation');
{
    assert(
        'absent → stop',
        decideToolRoundContinuation('hello, no tools here', config).status === 'stop',
    );

    assert(
        'malformed JSON → malformed',
        decideToolRoundContinuation('<tool_call>{not json}</tool_call>', config).status === 'malformed',
    );

    const injectText =
        'calling\n<tool_call>\n{"name": "get_current_temperature", "arguments": {"location": "Beijing"}}\n</tool_call>';
    const inject = decideToolRoundContinuation(injectText, config);
    assert('parsed + mock → inject', inject.status === 'inject');
    if (inject.status === 'inject') {
        assert('toolName preserved', inject.toolName === 'get_current_temperature');
        assert('mockContent non-empty', inject.mockContent.length > 0);
    }

    const unknown =
        '<tool_call>\n{"name": "no_such_tool", "arguments": {}}\n</tool_call>';
    assert(
        'unknown tool → stop (no mock)',
        decideToolRoundContinuation(unknown, config).status === 'stop',
    );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
