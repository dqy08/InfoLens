/**
 * 选项「新增」提示 catalog（与 options.html 的 data-option-id 对齐）。
 *
 * 以后加选项：
 * 1. 在 options.html 对应行加 data-option-id="your_id"（须默认可见，勿放折叠行）
 * 2. 把 your_id 追加到 IL_OPTIONS_CATALOG
 * 3. 不要改 IL_OPTIONS_SEED_SEEN——它只在用户还没有 il_options_seen_ids 时用一次
 *    （本功能首次落地的升级迁移）。已有 seen 的用户会自动把 catalog 里多出的 id 当新的。
 * 4. build 后重新加载 dist/
 *
 * 本版：升级用户视 intensity / paint style / highlight color / one-tone / merge subwords / auto-sites / cloud model / article only 为新；其余为旧。新安装整份视为已看。
 */
globalThis.IL_OPTIONS_CATALOG = Object.freeze([
  'ih_article_only',
  'show_progress',
  'show_token_tip',
  'ih_paint_style',
  'ih_highlight_color',
  'ih_max_highlight_alpha',
  'ih_two_tier',
  'ih_word_merge',
  'analyze_pref',
  'ih_cloud_model',
  'ih_auto_sites',
]);

/** 升级且尚无 seen 键时写入；勿把本版新项写进来 */
globalThis.IL_OPTIONS_SEED_SEEN = Object.freeze([
  'show_progress',
  'show_token_tip',
  'analyze_pref',
]);
