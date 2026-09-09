"""探针：托管推理 API 能否对已有文本做 teacher forcing 打分。

Info Highlight 只消费每个 token 的真实概率 p 与字符 offset（analyzeCache 只存 {offset, p}），
不消费 pred_topk。因此候选路径是 /v1/completions 的 echo + logprobs。

已实测可用：HF router → DeepInfra，返回 token_logprobs + text_offset。
用法：python3 scripts/information_density/probe_prompt_logprobs.py [model]
"""
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request

ROUTER = 'https://router.huggingface.co/deepinfra/v1/openai/completions'
SHORT = 'The capital of France is Paris, a city known for its Haussmannian architecture.'
LONG = (
    'Surprisal theory holds that the processing difficulty of a word is proportional to '
    'its negative log probability given the preceding context. Empirical work on eye-tracking '
    'and self-paced reading corpora has repeatedly confirmed a linear relationship between '
    'surprisal and reading time. More recent studies report that language models of moderate '
    'size predict human reading times better than very large ones, an inverse scaling effect '
    'in psychometric predictive power. '
) * 12


def score(text, model, key, timeout=120):
    """返回 (tokens, token_logprobs, text_offset, usage, 耗时秒)。"""
    body = {
        'model': model,
        'prompt': text,
        'max_tokens': 1,
        'echo': True,
        'logprobs': 1,
        'temperature': 0,
    }
    req = urllib.request.Request(
        ROUTER,
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'},
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode())
    elapsed = time.perf_counter() - t0
    lp = data['choices'][0]['logprobs']
    return lp['tokens'], lp['token_logprobs'], lp.get('text_offset'), data.get('usage'), elapsed


def bits(logprob):
    """自然对数 logprob → surprisal bits，与 page-map.js tokenBits 同尺度。"""
    return None if logprob is None else -logprob / math.log(2)


def prompt_rows(tokens, logprobs, offsets, text):
    """echo 响应还带一个生成 token；只保留 prompt 范围内的行。"""
    if offsets is None:
        raise ValueError('response missing text_offset')
    return [(token, logprob, offset) for token, logprob, offset in zip(tokens, logprobs, offsets)
            if offset < len(text)]


def main():
    key = os.environ.get('HF_TOKEN')
    if not key:
        sys.exit('缺少 HF_TOKEN')
    model = sys.argv[1] if len(sys.argv) > 1 else 'ibm-granite/granite-4.2-3b'

    print(f'模型: {model}\n')

    tokens, lps, offsets, usage, elapsed = score(SHORT, model, key)
    print(f'--- 短文本 ({len(SHORT)} 字符) {elapsed:.2f}s ---')
    print(f'{"token":<16}{"offset":>10}{"bits":>9}   原文切片')
    for tok, lp, off in prompt_rows(tokens, lps, offsets, SHORT):
        b = bits(lp)
        slice_ = SHORT[off:off + len(tok)]
        ok = '' if slice_ == tok else f'  ⚠️ 不匹配 {slice_!r}'
        print(f'{tok!r:<16}{off:>10}{"-" if b is None else f"{b:8.2f}"}   {slice_!r}{ok}')

    tokens, lps, offsets, usage, elapsed = score(LONG, model, key)
    rows = prompt_rows(tokens, lps, offsets, LONG)
    scored = [b for b in (bits(lp) for _, lp, _ in rows) if b is not None]
    print(f'\n--- 长文本 ({len(LONG)} 字符 / {len(rows)} token) ---')
    print(f'耗时 {elapsed:.2f}s, usage={usage}')
    print(f'有 logprob 的 token: {len(scored)}/{len(rows)}')
    print(f'bits 均值 {sum(scored) / len(scored):.2f}, 最大 {max(scored):.2f}')
    aligned = sum(1 for token, _, offset in rows if LONG[offset:offset + len(token)] == token)
    print(f'offset 对齐: {aligned}/{len(rows)}')


if __name__ == '__main__':
    main()
