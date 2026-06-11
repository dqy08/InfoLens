/** Stop 后服务端仍可能省略尾部若干 delta；最终以 result 为准，仅拒绝明显不一致。 */
export function assertStreamMatchesFinal(streamedText: string, finalText: string): void {
    if (finalText !== streamedText && !finalText.startsWith(streamedText)) {
        throw new Error(
            'Streaming deltas do not match final text (retry or report): ' +
                `delta_len=${streamedText.length}, final_len=${finalText.length}`
        );
    }
}
