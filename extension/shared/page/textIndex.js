/**
 * 正文的两套坐标：码点（后端 offset_mapping / 站点 TokenPositionCalculator 用）与
 * UTF-16（DOM Range 用）。两插件都必须与后端逐字对齐，漂移是静默错位，故只此一份。
 * 另附 pieces 的二分定位；pieces = collectTextMap / pdf/text-layer 的输出，按 start 有序不重叠。
 */
(() => {
  /** 有序数组中严格小于 x 的个数 */
  function countBefore(sorted, x) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * @param {string} text
   * @returns {{ cpLength: number, cpToUtf16: (cp: number) => number, utf16ToCp: (u16: number) => number }}
   */
  globalThis.IL_createTextIndex = function IL_createTextIndex(text) {
    const s = text || '';
    /** 补充平面字符的码点下标（稀疏表）；每个多占 1 个 UTF-16 单元 */
    const supp = [];
    let cpLength = 0;
    for (let i = 0; i < s.length; ) {
      const w = s.codePointAt(i) > 0xffff ? 2 : 1;
      if (w === 2) supp.push(cpLength);
      i += w;
      cpLength += 1;
    }
    return {
      cpLength,
      cpToUtf16(cp) {
        const c = cp < 0 ? 0 : cp > cpLength ? cpLength : cp;
        return c + countBefore(supp, c);
      },
      /** 越界夹到两端；落在代理对中间时归到后一个码点 */
      utf16ToCp(u16) {
        const u = u16 < 0 ? 0 : u16 > s.length ? s.length : u16;
        let lo = 0;
        let hi = supp.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (supp[mid] + mid + 1 < u) lo = mid + 1;
          else hi = mid;
        }
        return u - lo;
      },
    };
  };

  /**
   * 含 utf16Offset 的 piece 下标；落在 pieces 之间（提取时跳过的空白）返回 -1。
   * @param {{ start: number, end: number }[]} pieces
   * @param {number} utf16Offset
   */
  globalThis.IL_findPieceIndex = function IL_findPieceIndex(pieces, utf16Offset) {
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = pieces[mid];
      if (utf16Offset < p.start) hi = mid - 1;
      else if (utf16Offset >= p.end) lo = mid + 1;
      else return mid;
    }
    return -1;
  };
})();
