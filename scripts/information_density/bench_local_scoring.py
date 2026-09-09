"""基准：本地 base 模型对整段文本做一次前向打分的耗时。

对照同目录 probe_prompt_logprobs.py 的托管 API 结果，用于本地 vs 商业 API 的对等评估。
只做 teacher forcing 打分（单次 forward），不做自回归生成。
"""
import sys
import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

ZH = '语言模型对下一个词的预测概率，可以用来衡量这个词携带的信息量。'
EN = 'Surprisal theory holds that the processing difficulty of a word is proportional to its negative log probability. '


def build_text(target_tokens, tokenizer):
    """拼到大约 target_tokens 个 token。"""
    unit = ZH + EN
    text = unit
    while len(tokenizer(text)['input_ids']) < target_tokens:
        text += unit
    return text


@torch.inference_mode()
def score(model, ids):
    """返回每个位置真实 token 的 surprisal bits（首 token 无前文）。"""
    logits = model(ids, use_cache=False).logits[0].float()
    logprobs = torch.log_softmax(logits[:-1], dim=-1)
    return -logprobs.gather(1, ids[0, 1:, None]).squeeze(1) / torch.log(torch.tensor(2.0))


def main():
    model_id = sys.argv[1] if len(sys.argv) > 1 else 'Qwen/Qwen3-0.6B-Base'
    devices = sys.argv[2].split(',') if len(sys.argv) > 2 else ['cpu', 'mps']

    tokenizer = AutoTokenizer.from_pretrained(model_id)
    for device in devices:
        if device == 'mps' and not torch.backends.mps.is_available():
            print(f'[{device}] 不可用，跳过')
            continue
        dtype = torch.float32 if device == 'cpu' else torch.float16
        t0 = time.perf_counter()
        model = AutoModelForCausalLM.from_pretrained(model_id, dtype=dtype).to(device).eval()
        load = time.perf_counter() - t0
        params = sum(p.numel() for p in model.parameters()) / 1e9
        mem = sum(p.numel() * p.element_size() for p in model.parameters()) / 2**30
        print(f'\n=== {model_id} @ {device} / {dtype} ===')
        print(f'加载 {load:.1f}s, {params:.2f}B 参数, 权重 {mem:.2f} GiB')

        for n in (500, 1000, 3000, 8000):
            text = build_text(n, tokenizer)
            ids = tokenizer(text, return_tensors='pt')['input_ids'].to(device)
            try:
                t0 = time.perf_counter()
                bits = score(model, ids)
                if device == 'mps':
                    torch.mps.synchronize()
                elif device.startswith('cuda'):
                    torch.cuda.synchronize()
                el = time.perf_counter() - t0
                print(f'  {ids.shape[1]:>5} token → {el:6.2f}s  均值 {bits.mean():.2f} bits')
            except Exception as e:  # noqa: BLE001
                print(f'  {ids.shape[1]:>5} token → 失败: {str(e)[:100]}')
        del model
        if device == 'mps':
            torch.mps.empty_cache()


if __name__ == '__main__':
    main()
