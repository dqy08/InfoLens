import torch
import gc
from typing import Callable, Dict, List, Optional, Tuple

from backend.platform.format import round_to_sig_figs
from .pred_topk_format import pred_topk_pairs_from_flat_ids_and_probs
from backend.models.class_register import register_model, REGISTERED_MODELS
from backend.models.device import DeviceManager
from backend.models.model_manager import ensure_model_loaded
from backend.platform.runtime_config import load_runtime_config, DEFAULT_TOPK
from model_paths import DEFAULT_BASE_MODEL, INSTRUCT_MODEL_PATHS, MODEL_PATHS, resolve_hf_path

# 按 id(model) 缓存「仅含 BOS/等价起始符一步 forward」得到的末位词表 logits（全词表，不随分析文本变）
_bos_first_position_logits_cache: Dict[int, torch.Tensor] = {}


def compute_first_token_lm_with_bos_prefix_cache(
    model: torch.nn.Module,
    tokenizer,
    device: torch.device,
    first_token_id: int,
    effective_topk: int,
) -> Tuple[float, List[Tuple[str, float]]]:
    """
    首 token 无左文时的 workaround：与旧版 BOS 前缀一致，对单 token 输入 [bos] 做一步 forward，
    将末位 logits（预测首段文本第一个 token 的分布）缓存到 CPU，再在 CPU 上 softmax/topk。

    同一 model 实例复用同一份词表 logits，不在每次分析时重复 forward。
    """
    mid = id(model)
    if mid not in _bos_first_position_logits_cache:
        if tokenizer.bos_token_id is not None:
            bos_id = int(tokenizer.bos_token_id)
        elif tokenizer.eos_token_id is not None:
            bos_id = int(tokenizer.eos_token_id)
        else:
            bos_id = 0
        with torch.inference_mode():
            bos_in = torch.tensor([[bos_id]], device=device, dtype=torch.long)
            out = model(input_ids=bos_in)
            # [V]：在 BOS 条件下预测「第一个文本 token」的分布
            row = out.logits[0, -1, :].detach().float()
        _bos_first_position_logits_cache[mid] = row.cpu()

    logits = _bos_first_position_logits_cache[mid]
    probs = torch.softmax(logits, dim=-1)
    p = float(probs[first_token_id].item())

    topk_vals, topk_inds = torch.topk(probs, k=min(effective_topk, probs.shape[0]), dim=-1)
    topk_vals = topk_vals.float().numpy()
    topk_inds_flat = topk_inds.flatten().tolist()
    topk_tokens_decoded = tokenizer.batch_decode(
        [[tid] for tid in topk_inds_flat],
        skip_special_tokens=False,
    )
    pred_topk = [
        (topk_tokens_decoded[j], round_to_sig_figs(float(topk_vals[j])))
        for j in range(len(topk_tokens_decoded))
    ]
    return p, pred_topk


class AbstractLanguageChecker:
    """
    Abstract Class that defines the Backend API of GLTR.

    To extend the GLTR interface, you need to inherit this and
    fill in the defined functions.
    """

    def __init__(self):
        """
        In the subclass, you need to load all necessary components
        for the other functions.
        Typically, this will comprise a tokenizer and a model.
        """
        self.device = DeviceManager.get_device()
    

    def analyze_text(self, in_text):
        """
        Function that GLTR interacts with to analyze text and get token probabilities

        Params:
        - in_text: str -- The text that you want to analyze
        - topk: int, optional -- Desired pred_topk count (default from runtime_config.DEFAULT_TOPK)

        Output:
        - payload: dict -- The wrapper for results in this function, described below

        Payload values
        ==============
        bpe_strings: list of dict -- Each dict contains {"offset": [start, end], "raw": str,
            "real_topk": [rank, prob], "pred_topk": [(token, prob), ...]}
            - offset: character offsets in the original text [start, end]
            - raw: token text extracted from original text
            - real_topk: (ranking, prob) of each token（优先级默认0）
            - pred_topk: top-k 候选列表（若不可用则为空数组）
        """
        raise NotImplementedError



@register_model(name='qwen2.5-0.5b')
class QwenLM(AbstractLanguageChecker):
    """
    Qwen 系列模型支持
    默认使用 Qwen2.5-0.5B Base 模型（适合计算 surprisal 和信息量）
    """
    def __init__(self, model_path=None, model_name=None):
        super(QwenLM, self).__init__()
        model_name = model_name or getattr(self.__class__, '_registered_model_name', DEFAULT_BASE_MODEL)
        if model_path is not None and str(model_path).strip():
            resolved = str(model_path).strip()
        else:
            resolved = resolve_hf_path(model_name)

        # 加载运行时配置（支持部分覆盖）
        self._load_runtime_config(model_name)

        self.tokenizer, self.model, self.device = ensure_model_loaded(resolved)

        # ============================================================
        # 关于 torch.compile() 的性能优化讨论结论：
        # 
        # CPU 环境：
        # - 成本 > 收益，不推荐使用
        # 
        # CUDA 环境（如果未来升级到 GPU Space）：
        # - 加速比：30-70%（显著提升）
        # - 编译时间：相对推理时间更短
        # - Triton 内核优化：显著减少显存读写
        # - 结论：强烈推荐使用，需配合预热确保形状覆盖
        # 如需启用，可在此处添加：
        #   if torch.cuda.is_available() and hasattr(torch, 'compile'):
        #       self.model = torch.compile(self.model, mode="default")
        #       # 并在启动时运行预热推理覆盖 chunk_size 长度
        # ============================================================
        
        # 初始化分析计数器（用于控制GPU内存统计打印频率）
        self._analysis_count = 0

    def _load_runtime_config(self, model_name: Optional[str]):
        """
        加载运行时配置：基于模型和平台的四层配置合并
        
        Args:
            model_name: 模型标识符（如 'qwen3-1.7b'）
        """
        # 调用配置模块的完整加载流程
        # 返回: (platform, max_token_length, chunk_size)
        self.platform, self.max_length, self.chunk_size = load_runtime_config(
            model_name=model_name or "default_model"
        )

    def _encode_text(self, in_text: str) -> Tuple[torch.Tensor, List[Tuple[int, int]]]:
        """编码文本并返回 token_ids 和 offsets"""
        # 使用 tokenizer 的原生截断功能
        enc_out = self.tokenizer(
            in_text, 
            return_tensors='pt', 
            return_offsets_mapping=True,
            max_length=self.max_length,
            truncation=True
        )
        token_ids = enc_out['input_ids']
        token_offsets = enc_out['offset_mapping'][0].tolist()
                
        # 通过最后一个 offset 和文本长度对比判断是否截断
        if token_offsets:
            last_offset_end = token_offsets[-1][1]
            if last_offset_end < len(in_text):
                # 文本被截断了，警告token截断信息，和字数截断信息
                print(f"⚠️  文本过长，已截断至前 {self.max_length} token ({len(in_text)} char -> {last_offset_end} char)")
        
        token_ids = token_ids.to(self.device)
        
        return token_ids, token_offsets

    def _run_inference_and_process_chunked(
        self, 
        token_ids: torch.Tensor, 
        effective_topk: int,
        progress_callback: Optional[Callable[[int, int, str, Optional[int]], None]] = None
    ) -> Tuple[List[List[Tuple[str, float]]], List[float]]:
        """
        分块推理并即时处理：核心内存优化逻辑
        利用 KV Cache 分段计算 Logits，计算完立即释放，避免保留全量 Logits。

        数值说明：在 float16（如 MPS）上，在「仅前缀 forward」vs「整段 forward」同位置 logits 的逐元素对比，可能出现微小差异；
        float16（MPS/CUDA）可能因实现路径出现约 1%的 量级差，非掩码错误。CPU float32 下则完全一致。
        """
        seq_len = token_ids.shape[1]
        
        # 使用初始化时根据平台确定的 chunk_size
        chunk_size = self.chunk_size
        
        real_probs_list = []
        pred_topk_list = []
        past_key_values = None
        
        # 预先清理
        DeviceManager.clear_cache(self.device)
        
        full_input_ids = token_ids
        
        # 因果 LM：logits[i] 预测 input_ids[i+1]；首 token 无左文，不在此循环中计分
        
        # 我们使用 past_key_values 增量推理
        # 第一次：输入 input_ids[:, :chunk_size]，输出 logits 对应位置 0..chunk_size-1 (预测 1..chunk_size)
        
        total_chunks = (seq_len + chunk_size - 1) // chunk_size
        
        with torch.inference_mode():
            for i in range(total_chunks):
                start_idx = i * chunk_size
                end_idx = min((i + 1) * chunk_size, seq_len)
                current_chunk_len = end_idx - start_idx
                
                # 准备输入（统一逻辑，避免边界 token 重复）
                if i == 0:
                    input_chunk = full_input_ids[:, :end_idx]
                else:
                    input_chunk = full_input_ids[:, start_idx:end_idx]
                
                # 1. 运行推理
                outputs = self.model(
                    input_ids=input_chunk, 
                    past_key_values=past_key_values, 
                    use_cache=True
                )
                
                past_key_values = outputs.past_key_values

                logits = outputs.logits
                
                # 获取 targets
                # full_input_ids[:, 1:] 是所有 targets
                # 当前块 targets 范围: [start_idx : end_idx]
                chunk_targets = full_input_ids[:, 1+start_idx : 1+end_idx]
                valid_len = chunk_targets.shape[1]
                if valid_len == 0:
                    continue
                # 最后一块覆盖到序列末尾时，最后一个 logit 位预测的是「下一 token」，需裁掉
                current_logits = logits[:, :valid_len, :]
                
                # 2. 处理当前块的 Softmax 和 TopK
                probs_chunk = torch.softmax(current_logits, dim=2)
                
                # 提取真实概率
                chunk_target_probs = torch.gather(probs_chunk, 2, chunk_targets.unsqueeze(-1))
                real_probs_list.extend(chunk_target_probs.flatten().detach().cpu().float().numpy().tolist())
                
                # 提取 TopK
                # 由于 chunk_size 已确保小于 MPS_TOPK_BUG_THRESHOLD，所以直接计算
                topk_vals, topk_inds = torch.topk(probs_chunk, k=effective_topk, dim=2)
                chunk_pred_topk = self._decode_topk_tokens(
                    topk_vals, topk_inds, effective_topk, valid_len
                )
                pred_topk_list.extend(chunk_pred_topk)
                
                # 3. 立即释放内存
                del logits
                del current_logits
                del probs_chunk
                del chunk_target_probs
                # outputs 会在下一次循环时被覆盖，无需手动处理
                
                # 进度更新（基于实际处理的 token 数量）
                if progress_callback:
                    pct = int(end_idx / seq_len * 100)  # 推理阶段独立的 0-100%
                    progress_callback(2, 3, 'inference', pct)

        # 循环结束，清理 KV Cache
        del past_key_values
        DeviceManager.clear_cache(self.device)
        
        return pred_topk_list, real_probs_list

    def _decode_topk_tokens(
        self,
        topk_prob_values: torch.Tensor,
        topk_prob_inds: torch.Tensor,
        effective_topk: int,
        seq_len: int
    ) -> List[List[Tuple[str, float]]]:
        """解码 TopK tokens 并构建预测列表（长度等于参与 topk 的序列长度）"""
        topk_prob_values_cpu = topk_prob_values[0].detach().cpu().float().numpy()
        topk_prob_inds_flat = topk_prob_inds[0].cpu().flatten().tolist()
        probs_flat = topk_prob_values_cpu.flatten().tolist()
        flat_pairs = pred_topk_pairs_from_flat_ids_and_probs(
            topk_prob_inds_flat, probs_flat, self.tokenizer
        )
        return [
            flat_pairs[i * effective_topk : (i + 1) * effective_topk]
            for i in range(seq_len)
        ]

    def _build_bpe_strings(
        self,
        token_offsets: List[Tuple[int, int]],
        real_topk: List[Tuple[int, float]],
        pred_topk: List[List[Tuple[str, float]]],
        in_text: str
    ) -> List[Dict]:
        """构建最终的 BPE 字符串列表"""
        # 确保长度一致
        min_len = min(len(token_offsets), len(real_topk), len(pred_topk) if pred_topk else len(token_offsets))
        
        bpe_strings = []
        for idx in range(min_len):
            start, end = token_offsets[idx]
            raw_text = in_text[start:end] if start < end else ""
            token_payload = {
                "offset": [start, end],
                "raw": raw_text,
                "real_topk": list(real_topk[idx]),
                "pred_topk": pred_topk[idx] if pred_topk else []
            }
            bpe_strings.append(token_payload)
        
        return bpe_strings

    def analyze_text(self, in_text: str, progress_callback: Optional[Callable[[int, int, str, Optional[int]], None]] = None) -> Dict[str, List[Dict]]:
        """
        计算文本中每个 token 的概率
        
        进度回调参数: (step: int, total_steps: int, stage: str, percentage: Optional[int])
        - step: 当前步骤 (1-based)
        - total_steps: 总步骤数 (固定为 3)
        - stage: 阶段名称 (encoding/inference/processing)
        - percentage: 可选的百分比，仅在 inference 阶段提供
        """
        TOTAL_STEPS = 3
        
        try:
            # Step 1: 编码文本
            if progress_callback: 
                progress_callback(1, TOTAL_STEPS, 'encoding', None)
            token_ids, token_offsets = self._encode_text(in_text)
            
            # Step 2: 分块推理并处理（带百分比进度）
            # 这取代了原来的 _run_model_inference, MPS 流式处理, 和 _process_topk
            
            if progress_callback:
                progress_callback(2, 3, 'inference', 0)
            pred_topk, real_topk_probs = self._run_inference_and_process_chunked(
                token_ids, DEFAULT_TOPK, progress_callback
            )
            
            # Step 3: 构建结果
            if progress_callback: 
                progress_callback(3, TOTAL_STEPS, 'processing', None)

            if token_ids.shape[1] >= 1:
                p0, pred0 = compute_first_token_lm_with_bos_prefix_cache(
                    self.model,
                    self.tokenizer,
                    self.device,
                    int(token_ids[0, 0].item()),
                    DEFAULT_TOPK,
                )
                pred_topk.insert(0, pred0)
                real_topk_probs.insert(0, p0)

            seq_len = len(real_topk_probs)
            real_topk = list(zip([0] * seq_len, [round_to_sig_figs(p) for p in real_topk_probs]))
            
            bpe_strings = self._build_bpe_strings(token_offsets, real_topk, pred_topk, in_text)
            
            # 最终清理
            DeviceManager.clear_cache(self.device)
            gc.collect()
            
            # 更新分析计数器
            self._analysis_count += 1
            
            # 打印分析任务完成后的内存统计（第1、11、21...次分析后打印）
            if self.device.type == "cuda" and (self._analysis_count - 1) % 10 == 0:
                device_idx = self.device.index if self.device.index is not None else 0
                DeviceManager.print_cuda_memory_summary(device=device_idx)
            
            return {'bpe_strings': bpe_strings}
            
        except Exception as e:
            import traceback
            print(f"❌ Error in QwenLM.analyze_text: {e}")
            traceback.print_exc()
            return {'bpe_strings': []}
    
    # _cleanup_tensors 方法已被移除，因为不再需要显式清理小张量


# ============================================================
# 自动注册：根据 MODEL_PATHS 与 INSTRUCT_MODEL_PATHS 自动注册所有模型
# ============================================================
# 只需要在 model_paths.py 中添加模型路径，即可自动注册
# 无需手动创建子类，实现 DRY 原则
def _auto_register_models():
    """自动注册 MODEL_PATHS 与 INSTRUCT_MODEL_PATHS 中的所有模型"""
    for model_name in (*MODEL_PATHS.keys(), *INSTRUCT_MODEL_PATHS.keys()):
        if model_name not in REGISTERED_MODELS:
            # 动态创建模型类并注册
            # 使用闭包捕获当前 model_name
            def make_init():
                def __init__(self):
                    QwenLM.__init__(self)
                return __init__
            
            model_class = type(
                f'QwenLM_{model_name.replace(".", "_").replace("-", "_")}',
                (QwenLM,),
                {
                    '__init__': make_init(),
                    '__doc__': f'{model_name} 模型支持（自动注册）'
                }
            )
            register_model(model_name)(model_class)

# 执行自动注册
_auto_register_models()

