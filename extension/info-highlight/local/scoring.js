/**
 * 本机 Analyze 打分：把 logits 收成与云端 Analyze 相同的 bpe_strings。
 * 不依赖 WebGPU / transformers；对齐 backend/core/language_checker.py 的 payload 规则。
 */
globalThis.IH_localScoring ||= (function () {
  const TOPK = 10;
  const SIG_FIGS = 7;
  const META = '\u2581';
  const BYTE_PIECE = /^<0x([0-9A-Fa-f]{2})>$/;
  const utf8dec = new TextDecoder('utf-8', { fatal: true });

  function utf8SeqLen(b) {
    if (b < 0x80) return 1;
    if (b < 0xc0) throw new Error(`utf-8 continuation ${b}`);
    if (b < 0xe0) return 2;
    if (b < 0xf0) return 3;
    if (b < 0xf8) return 4;
    throw new Error(`utf-8 start ${b}`);
  }

  function roundSigFigs(x, n = SIG_FIGS) {
    if (x === 0 || !Number.isFinite(x)) return x;
    return Number(Number(x).toPrecision(n));
  }

  /** SYNC: backend/core/language_checker.py → scoring_payload_offsets */
  function scoringPayloadOffsets(tokenOffsets) {
    let start = 0;
    while (start < tokenOffsets.length && tokenOffsets[start][0] >= tokenOffsets[start][1]) {
      start += 1;
    }
    let end = tokenOffsets.length;
    while (end > start && tokenOffsets[end - 1][0] >= tokenOffsets[end - 1][1]) {
      end -= 1;
    }
    return { offsets: tokenOffsets.slice(start, end), insertFirst: start === 0 };
  }

  /** SYNC: backend/core/language_checker.py → ensure_bos_prefix（仅 Gemma） */
  function ensureGemmaBos(ids, offsets, bosId) {
    if (bosId == null) return { ids, offsets };
    if (offsets.length && offsets[0][0] >= offsets[0][1]) return { ids, offsets };
    if (ids.length && ids[0] === bosId) return { ids, offsets };
    return { ids: [bosId, ...ids], offsets: [[0, 0], ...offsets] };
  }

  function utf16ToCpIndex(text) {
    const s = text || '';
    const supp = [];
    let cpLength = 0;
    for (let i = 0; i < s.length; ) {
      const w = s.codePointAt(i) > 0xffff ? 2 : 1;
      if (w === 2) supp.push(cpLength);
      i += w;
      cpLength += 1;
    }
    return {
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
  }

  function utf16ToCpOffsets(text, offsets) {
    const idx = utf16ToCpIndex(text);
    return offsets.map(([s, e]) => [idx.utf16ToCp(s), idx.utf16ToCp(e)]);
  }

  /**
   * 按 token 在原文里顺序对齐 UTF-16 偏移。特殊 token 记为空 span。
   * 词表片：▁→空格；<0xXX> 拼 UTF-8。必须贴着 cursor，对不上就抛。
   * @param {string} text
   * @param {number[]} ids
   * @param {(id: number) => string} tokenStr convert_ids_to_tokens
   * @param {Set<number>} specialIds
   */
  function alignUtf16Offsets(text, ids, tokenStr, specialIds) {
    const offsets = [];
    let cursor = 0;
    const bytes = [];
    const byteIds = [];

    function fail(id) {
      throw new Error(`token offset align failed at ${cursor} for id=${id}`);
    }

    function spanFor(piece, id) {
      if (piece == null) fail(id);
      if (piece === '') return [cursor, cursor];
      if (text.startsWith(piece, cursor)) return [cursor, cursor + piece.length];
      if (piece.startsWith(' ') && text.startsWith(piece.slice(1), cursor)) {
        return [cursor, cursor + piece.length - 1];
      }
      fail(id);
    }

    function emitUtf8() {
      if (!bytes.length) return;
      const need = utf8SeqLen(bytes[0]);
      if (bytes.length !== need) fail(byteIds[0]);
      let piece;
      try {
        piece = utf8dec.decode(new Uint8Array(bytes));
      } catch {
        fail(byteIds[0]);
      }
      const span = spanFor(piece, byteIds[0]);
      for (let i = 0; i < byteIds.length; i++) offsets.push(span);
      cursor = span[1];
      bytes.length = 0;
      byteIds.length = 0;
    }

    for (const rawId of ids) {
      const id = Number(rawId);
      if (specialIds.has(id)) {
        emitUtf8();
        offsets.push([cursor, cursor]);
        continue;
      }
      const raw = tokenStr(id);
      if (raw == null) fail(id);
      const byte = BYTE_PIECE.exec(raw);
      if (byte) {
        const b = Number.parseInt(byte[1], 16);
        if (!bytes.length) {
          try {
            utf8SeqLen(b);
          } catch {
            fail(id);
          }
        }
        bytes.push(b);
        byteIds.push(id);
        if (bytes.length === utf8SeqLen(bytes[0])) emitUtf8();
        continue;
      }
      emitUtf8();
      const span = spanFor(raw.replaceAll(META, ' '), id);
      offsets.push(span);
      cursor = span[1];
    }
    emitUtf8();
    return offsets;
  }

  function insertTop(topVals, topIds, p, v) {
    const last = topVals.length - 1;
    if (p <= topVals[last]) return;
    let k = last;
    while (k > 0 && p > topVals[k - 1]) {
      topVals[k] = topVals[k - 1];
      topIds[k] = topIds[k - 1];
      k -= 1;
    }
    topVals[k] = p;
    topIds[k] = v;
  }

  /**
   * 一行 logits → gold 概率 + topk（未归一化 exp 的序与 softmax 相同）。
   * @param {ArrayLike<number>} logits
   * @param {number} base
   * @param {number} vocab
   * @param {number} target
   * @param {number} topk
   */
  function scoreRow(logits, base, vocab, target, topk) {
    if (target < 0 || target >= vocab) {
      throw new Error(`target id ${target} out of vocab ${vocab}`);
    }
    let maxv = -Infinity;
    for (let v = 0; v < vocab; v++) {
      const x = Number(logits[base + v]);
      if (!Number.isFinite(x)) throw new Error('non-finite logit');
      if (x > maxv) maxv = x;
    }
    const topVals = new Float64Array(topk);
    const topIds = new Int32Array(topk);
    topVals.fill(-Infinity);
    let sum = 0;
    let goldUnnorm = 0;
    for (let v = 0; v < vocab; v++) {
      const e = Math.exp(Number(logits[base + v]) - maxv);
      sum += e;
      if (v === target) goldUnnorm = e;
      insertTop(topVals, topIds, e, v);
    }
    if (!(sum > 0) || !Number.isFinite(sum)) throw new Error('softmax sum not finite');
    const p = goldUnnorm / sum;
    if (!Number.isFinite(p) || p < 0) throw new Error('token probability not finite');
    const pred = [];
    for (let k = 0; k < topk; k++) {
      if (!Number.isFinite(topVals[k])) break;
      pred.push([topIds[k], roundSigFigs(topVals[k] / sum)]);
    }
    return { p: roundSigFigs(p), pred };
  }

  function sliceByCp(text, cp0, cp1) {
    if (cp1 <= cp0) return '';
    return Array.from(text).slice(cp0, cp1).join('');
  }

  /**
   * 一块前向的 logits（位置 start..end-1）→ 对 ids[start+1 .. min(end, seq-1)] 打分。
   * SYNC: language_checker._run_inference_and_process_chunked
   */
  function scoreChunk(logits, vocab, ids, start, end, topk = TOPK) {
    const targetEnd = Math.min(end + 1, ids.length);
    const validLen = targetEnd - (start + 1);
    if (validLen <= 0) return [];
    const rows = [];
    for (let j = 0; j < validLen; j++) {
      rows.push(scoreRow(logits, j * vocab, vocab, ids[start + 1 + j], topk));
    }
    return rows;
  }

  /**
   * @param {object} args
   * @param {{ p: number, pred: [number, number][] }[]} args.rows
   * @param {number[]} args.ids
   * @param {Array<[number, number]>} args.offsets code-point offsets，与 ids 等长
   * @param {string} args.text
   * @param {(id: number) => string} args.decodeId
   */
  function bpeFromRows({ rows, ids, offsets, text, decodeId }) {
    const { offsets: payload, insertFirst } = scoringPayloadOffsets(offsets);
    if (insertFirst) {
      throw new Error('Gemma scoring requires a leading empty BOS span');
    }
    const scored = Math.max(0, ids.length - 1);
    if (payload.length > scored) {
      throw new Error(`payload ${payload.length} longer than scored positions ${scored}`);
    }
    if (payload.length > rows.length) {
      throw new Error(`payload ${payload.length} longer than rows ${rows.length}`);
    }
    const bpe = [];
    for (let i = 0; i < payload.length; i++) {
      const row = rows[i];
      const [start, end] = payload[i];
      bpe.push({
        offset: [start, end],
        raw: sliceByCp(text, start, end),
        real_topk: [0, row.p],
        pred_topk: row.pred.map(([id, p]) => [decodeId(id), p]),
      });
    }
    return { bpe_strings: bpe };
  }

  /**
   * @param {object} args
   * @param {ArrayLike<number>} args.logits
   * @param {number[]} args.dims [batch, seq, vocab]
   * @param {number[]} args.ids
   * @param {Array<[number, number]>} args.offsets code-point offsets，与 ids 等长
   * @param {string} args.text
   * @param {(id: number) => string} args.decodeId
   * @param {number} [args.topk]
   */
  function bpeFromLogits({ logits, dims, ids, offsets, text, decodeId, topk = TOPK }) {
    if (!dims || dims.length < 3) throw new Error(`bad logits dims: ${JSON.stringify(dims)}`);
    const seq = dims[1];
    const vocab = dims[2];
    if (ids.length !== seq) throw new Error(`ids length ${ids.length} != logits seq ${seq}`);
    if (offsets.length !== seq) throw new Error(`offsets length ${offsets.length} != seq ${seq}`);
    const { insertFirst } = scoringPayloadOffsets(offsets);
    if (insertFirst) {
      throw new Error('Gemma scoring requires a leading empty BOS span');
    }
    const rows = scoreChunk(logits, vocab, ids, 0, seq, topk);
    return bpeFromRows({ rows, ids, offsets, text, decodeId });
  }

  return {
    TOPK,
    roundSigFigs,
    scoringPayloadOffsets,
    ensureGemmaBos,
    utf16ToCpOffsets,
    alignUtf16Offsets,
    scoreRow,
    scoreChunk,
    bpeFromRows,
    bpeFromLogits,
    sliceByCp,
  };
})();
