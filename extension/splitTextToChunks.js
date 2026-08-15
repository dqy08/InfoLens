/**
 * SYNC 副本（demo 不抽共享包；改站内源请同步本文件）：
 * client/src/shared/cross/semanticUtils.ts → splitTextToChunks 及相关纯函数
 */
globalThis.IL_splitTextToChunks = (function () {
  const encoder = new TextEncoder();
  const YIELD_MS = 8;

  function yieldToMain(work) {
    const fn = globalThis.IL_yieldToMain;
    if (typeof fn !== 'function') {
      throw new Error('IL_yieldToMain missing — inject collectTextMap.js first');
    }
    return fn(work);
  }

  function getUtf8ByteLength(text, buf) {
    const { read, written } = encoder.encodeInto(text, buf);
    return read < text.length ? buf.length : written;
  }

  function nextParagraphEnd(text, start) {
    const nl = text.indexOf('\n\n', start);
    if (nl === -1) return text.length;
    let end = nl + 2;
    while (end < text.length && text[end] === '\n') end++;
    return end;
  }

  function nextLineEnd(text, start) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) return text.length;
    let end = nl + 1;
    while (end < text.length && text[end] === '\n') end++;
    return end;
  }

  function charIndexForByteLimit(text, start, byteLimit) {
    const buf = new Uint8Array(4);
    let bytes = 0;
    let i = start;
    while (i < text.length) {
      const cp = text.codePointAt(i);
      const charLen = cp > 0xffff ? 2 : 1;
      const byteLen = encoder.encodeInto(text.slice(i, i + charLen), buf).written;
      if (bytes + byteLen > byteLimit) break;
      bytes += byteLen;
      i += charLen;
    }
    return i;
  }

  const SEPARATOR_GROUPS = [
    ['。', '！', '？', '…'],
    ['；', '，'],
    ['.', '!', '?'],
    [';', ','],
    [' ', '\t'],
  ];

  function findSplitPoint(text, start, maxEnd) {
    const window = text.slice(start, maxEnd);
    for (const group of SEPARATOR_GROUPS) {
      let bestEnd = -1;
      for (const sep of group) {
        const i = window.lastIndexOf(sep);
        if (i !== -1 && i + sep.length > bestEnd) bestEnd = i + sep.length;
      }
      if (bestEnd !== -1) return start + bestEnd;
    }
    return maxEnd;
  }

  function assertSplitArgs(text, bytesPerChunk) {
    if (bytesPerChunk <= 0) {
      throw new Error('bytesPerChunk must be > 0, got: ' + bytesPerChunk);
    }
    if (text.includes('\r')) {
      throw new Error('Text contains \\r (CR); only \\n (LF) is supported.');
    }
  }

  /** 从 pos 切出下一块的结束下标（不含）。 */
  function takeChunkEnd(text, pos, bytesPerChunk, encodeBuf) {
    let chunkEnd = pos;
    let chunkBytes = 0;
    outer: while (chunkEnd < text.length) {
      const paragEnd = nextParagraphEnd(text, chunkEnd);
      const paragBytes = getUtf8ByteLength(text.slice(chunkEnd, paragEnd), encodeBuf);
      if (chunkBytes > 0 && chunkBytes + paragBytes > bytesPerChunk) break;
      if (chunkBytes === 0 && paragBytes > bytesPerChunk) {
        while (chunkEnd < paragEnd) {
          const lineEnd = nextLineEnd(text, chunkEnd);
          const lineBytes = getUtf8ByteLength(text.slice(chunkEnd, lineEnd), encodeBuf);
          if (lineBytes > bytesPerChunk) {
            // 本 chunk 可能已累计 chunkBytes，超长行只能占剩余额度，否则整块超限
            const maxEnd = charIndexForByteLimit(text, chunkEnd, bytesPerChunk - chunkBytes);
            chunkEnd = findSplitPoint(text, chunkEnd, maxEnd);
            break outer;
          }
          if (chunkBytes > 0 && chunkBytes + lineBytes > bytesPerChunk) break outer;
          chunkBytes += lineBytes;
          chunkEnd = lineEnd;
        }
        continue outer;
      }
      chunkBytes += paragBytes;
      chunkEnd = paragEnd;
    }
    return chunkEnd;
  }

  /** @returns {{ text: string, startOffset: number }[]} */
  function splitTextToChunks(text, bytesPerChunk) {
    assertSplitArgs(text, bytesPerChunk);
    const chunks = [];
    let pos = 0;
    const encodeBuf = new Uint8Array(bytesPerChunk + 1);
    while (pos < text.length) {
      const chunkEnd = takeChunkEnd(text, pos, bytesPerChunk, encodeBuf);
      chunks.push({ text: text.slice(pos, chunkEnd), startOffset: pos });
      pos = chunkEnd;
    }
    return chunks;
  }

  /**
   * 与 splitTextToChunks 同结果；每 YIELD_MS 让出主线程。
   * @param {string} text
   * @param {number} bytesPerChunk
   * @param {() => boolean} [isStale]
   */
  async function splitTextToChunksAsync(text, bytesPerChunk, isStale) {
    assertSplitArgs(text, bytesPerChunk);
    const chunks = [];
    let pos = 0;
    const encodeBuf = new Uint8Array(bytesPerChunk + 1);
    while (pos < text.length) {
      await yieldToMain(() => {
        if (isStale?.()) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        const t0 = performance.now();
        while (pos < text.length && performance.now() - t0 < YIELD_MS) {
          if (isStale?.()) {
            throw new DOMException('The operation was aborted.', 'AbortError');
          }
          const chunkEnd = takeChunkEnd(text, pos, bytesPerChunk, encodeBuf);
          chunks.push({ text: text.slice(pos, chunkEnd), startOffset: pos });
          pos = chunkEnd;
        }
      });
    }
    return chunks;
  }

  globalThis.IL_splitTextToChunksAsync = splitTextToChunksAsync;
  return splitTextToChunks;
})();
