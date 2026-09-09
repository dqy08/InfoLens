"""测量 MPS 打分时的显存去向：权重 vs logits 张量，以及固定窗口能省多少。

固定窗口只用于测内存量级，不等价于后端保留完整左文的 KV-cache 分块。
"""
import sys
import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

UNIT = (
    '语言模型对下一个词的预测概率，可以用来衡量这个词携带的信息量。'
    'Surprisal theory holds that processing difficulty is proportional to negative log probability. '
)


def gib(n):
    return n / 2**30


@torch.inference_mode()
def score_whole(model, ids):
    """一次性前向：logits 全量落地，峰值最高。"""
    logits = model(ids, use_cache=False).logits[0].float()
    logprobs = torch.log_softmax(logits[:-1], dim=-1)
    return -logprobs.gather(1, ids[0, 1:, None]).squeeze(1)


@torch.inference_mode()
def score_windowed(model, ids, window=1024, stride=768):
    """固定窗口近似：每块只保留目标 token 的 logprob，logits 立即释放。

    window 内前 (window - stride) 个 token 只作左文，不取值；较早左文会被丢弃。
    """
    n = ids.shape[1]
    out = torch.zeros(n - 1)
    pos = 0
    while pos < n - 1:
        start = max(0, pos - (window - stride))
        end = min(n, pos + stride + 1)
        chunk = ids[:, start:end]
        logits = model(chunk, use_cache=False).logits[0]
        # chunk 内位置 j 的 logits 预测 j+1；只取 pos 之后的部分
        first = pos - start
        sel = logits[first:-1]
        tgt = chunk[0, first + 1:]
        lse = torch.logsumexp(sel.float(), dim=-1)
        out[pos:pos + len(tgt)] = (lse - sel.float().gather(1, tgt[:, None]).squeeze(1)).cpu()
        pos += len(tgt)
        del logits, sel
    return out


def main():
    model_id = sys.argv[1] if len(sys.argv) > 1 else 'Qwen/Qwen3-0.6B-Base'
    device = sys.argv[2] if len(sys.argv) > 2 else 'mps'
    if device != 'mps':
        sys.exit('bench_scoring_memory.py 只支持 MPS 内存指标')

    tokenizer = AutoTokenizer.from_pretrained(model_id)
    model = AutoModelForCausalLM.from_pretrained(model_id, dtype=torch.float16).to(device).eval()
    vocab = model.config.vocab_size
    weights = sum(p.numel() * p.element_size() for p in model.parameters())
    print(f'{model_id} @ {device}')
    print(f'词表 {vocab}, 权重 fp16 {gib(weights):.2f} GiB\n')

    for target in (1000, 3000, 8000):
        text = UNIT
        while len(tokenizer(text)['input_ids']) < target:
            text += UNIT
        ids = tokenizer(text, return_tensors='pt')['input_ids'].to(device)
        n = ids.shape[1]
        print(f'--- {n} token ---')
        print(f'  logits 理论体积: fp16 {gib(n * vocab * 2):.2f} GiB / fp32 {gib(n * vocab * 4):.2f} GiB')

        for name, fn in (('整段', score_whole), ('固定窗1024', score_windowed)):
            torch.mps.empty_cache()
            base = torch.mps.driver_allocated_memory()
            t0 = time.perf_counter()
            try:
                bits = fn(model, ids) / torch.log(torch.tensor(2.0))
                torch.mps.synchronize()
                el = time.perf_counter() - t0
                peak = torch.mps.driver_allocated_memory() - base
                print(f'  {name:<10} {el:6.2f}s  额外占用 {gib(peak):5.2f} GiB  均值 {bits.mean():.2f} bits')
            except Exception as e:  # noqa: BLE001
                print(f'  {name:<10} 失败: {str(e)[:90]}')
        print()


if __name__ == '__main__':
    main()
