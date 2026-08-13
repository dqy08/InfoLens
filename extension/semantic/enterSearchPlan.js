/**
 * Enter 同 query：已有连续进度如何省请求。
 * skip = 不发请求；resume = 从前沿接着挖；fresh = 整段重开。
 */
globalThis.IL_enterSearchPlan = (function () {
  /**
   * @param {{
   *   sameQuery: boolean,
   *   hasProgress: boolean,
   *   connected?: boolean,
   *   startCp: number,
   *   originCp: number,
   *   analyzedEndCp: number,
   *   paintLength: number,
   *   hasMatchFromStart: boolean,
   *   canResume: boolean,
   * }} p
   * @returns {'skip' | 'resume' | 'fresh'}
   */
  function plan(p) {
    if (!p.sameQuery || !p.hasProgress || p.connected === false) return 'fresh';
    if (p.startCp < p.originCp) return 'fresh';
    if (p.startCp >= p.paintLength) return 'skip';
    if (p.startCp > p.analyzedEndCp) return 'fresh';
    if (p.startCp === p.analyzedEndCp) return p.canResume ? 'resume' : 'fresh';
    if (p.hasMatchFromStart || !p.canResume) return 'skip';
    return 'resume';
  }

  /** resume 且起点严格在已分析开区间内时，丢掉起点前的进度。 */
  function shouldTrim(startCp, originCp, analyzedEndCp) {
    return startCp > originCp && startCp < analyzedEndCp;
  }

  return { plan, shouldTrim };
})();
