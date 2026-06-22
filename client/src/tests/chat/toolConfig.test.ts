/**
 * Tool config ↔ catalog entry 互转与校验
 * 运行: cd client/src && npx tsx tests/chat/toolConfig.test.ts
 */
import { TOOL_CATALOG } from '../../features/chat/toolCatalog';
import { resolveMockTool } from '../../features/chat/mockExecutor';
import {
    buildToolConfigFromCheckedJson,
    createBlankToolEntry,
    entriesToToolConfig,
    EMPTY_TOOL_CONFIG,
    isToolConfigEmpty,
    nextAvailableNewToolName,
    normalizeToolConfig,
    parseToolCatalogEntryJson,
    toolConfigCacheKeyFields,
    toolConfigFingerprint,
    toolConfigToEntries,
} from '../../features/chat/toolConfig';

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

const sampleEntry = TOOL_CATALOG[0]!;
const sampleJson = JSON.stringify(sampleEntry, null, 2);
const webSearchEntry = TOOL_CATALOG.find((e) => e.function.name === 'web_search')!;

console.log('toolConfig round-trip');
{
    const config = entriesToToolConfig([sampleEntry]);
    const back = toolConfigToEntries(config);
    assert('entriesToToolConfig → toolConfigToEntries', back[0]!.function.name === sampleEntry.function.name);
    assert(
        'mock response preserved',
        back[0]!.mock_results[0]!.response.temperature ===
            sampleEntry.mock_results[0]!.response.temperature,
    );
}

console.log('parseToolCatalogEntryJson');
{
    const ok = parseToolCatalogEntryJson(sampleJson);
    assert('valid entry parses', 'entry' in ok && ok.entry.function.name === sampleEntry.function.name);
    const bad = parseToolCatalogEntryJson('{');
    assert('invalid JSON rejected', 'error' in bad);
    const webJson = JSON.stringify(webSearchEntry, null, 2);
    const webParsed = parseToolCatalogEntryJson(webJson);
    assert(
        'web_search keeps all mock candidates',
        'entry' in webParsed && webParsed.entry.mock_results.length === 2,
    );
}

console.log('legacy tool config migration');
{
    const legacy = {
        tools_schema: [{ function: sampleEntry.function }],
        mock_results: {
            get_current_temperature: JSON.stringify(sampleEntry.mock_results[0]!.response),
        },
    };
    const migrated = normalizeToolConfig(legacy);
    assert('legacy migrates to entries', migrated?.entries.length === 1);
    assert(
        'legacy mock preserved',
        migrated?.entries[0]!.mock_results[0]!.response.temperature ===
            sampleEntry.mock_results[0]!.response.temperature,
    );
}

console.log('resolveMockTool trigger_keyword');
{
    const config = entriesToToolConfig([webSearchEntry]);
    const ipo = resolveMockTool(config, 'web_search', { query: 'SpaceX IPO 最新消息' });
    assert('IPO keyword matches', ipo?.includes('750亿美元') === true);
    const boss = resolveMockTool(config, 'web_search', { query: 'SpaceX 老板是谁' });
    assert('老板 keyword matches', boss?.includes('埃隆·马斯克') === true);
    const miss = resolveMockTool(config, 'web_search', { query: 'SpaceX 火箭发射' });
    assert('no match returns null', miss === null);
    const weatherConfig = entriesToToolConfig([sampleEntry]);
    const weather = resolveMockTool(weatherConfig, 'get_current_temperature', { location: '北京' });
    assert('no-keyword tool uses first candidate', weather?.includes('25') === true);
}

console.log('resolveMockTool keyword fallback');
{
    const entry = {
        function: webSearchEntry.function,
        mock_results: [
            { trigger_keyword: 'IPO', response: { content: 'ipo hit' } },
            { response: { content: 'default hit' } },
        ],
    };
    const config = entriesToToolConfig([entry]);
    const matched = resolveMockTool(config, 'web_search', { query: 'IPO news' });
    assert('keyword branch wins', matched === JSON.stringify({ content: 'ipo hit' }));
    const fallback = resolveMockTool(config, 'web_search', { query: 'other topic' });
    assert('non-keyword fallback', fallback === JSON.stringify({ content: 'default hit' }));
}

console.log('buildToolConfigFromCheckedJson');
{
    const built = buildToolConfigFromCheckedJson([{ label: 't1', text: sampleJson }]);
    assert('single tool builds', 'config' in built && built.config.entries.length === 1);
    const dup = buildToolConfigFromCheckedJson([
        { label: 'a', text: sampleJson },
        { label: 'b', text: sampleJson },
    ]);
    assert('duplicate name rejected', 'error' in dup);
    const empty = buildToolConfigFromCheckedJson([]);
    assert('empty selection → empty config', 'config' in empty && isToolConfigEmpty(empty.config));
}

console.log('EMPTY_TOOL_CONFIG');
assert('empty config has no entries', isToolConfigEmpty(EMPTY_TOOL_CONFIG));

console.log('createBlankToolEntry / nextAvailableNewToolName');
{
    const blank = createBlankToolEntry('new_tool');
    assert('blank entry has name', blank.function.name === 'new_tool');
    assert(
        'next name skips used',
        nextAvailableNewToolName(['new_tool', 'new_tool_2']) === 'new_tool_3',
    );
}

console.log('toolConfigCacheKeyFields');
{
    const config = entriesToToolConfig([sampleEntry]);
    assert('single-turn omits fingerprint', toolConfigCacheKeyFields(false, config).toolConfigFingerprint === undefined);
    const multi = toolConfigCacheKeyFields(true, config);
    assert(
        'multi-turn includes fingerprint',
        multi.toolConfigFingerprint === toolConfigFingerprint(config),
    );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
