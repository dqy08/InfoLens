"""设备管理：CPU/CUDA/MPS 检测与内存统计"""

import os
import torch


class DeviceManager:
    """设备管理工具类，统一处理设备相关的操作"""

    @staticmethod
    def clear_cache(device: torch.device) -> None:
        """清理设备缓存"""
        if device.type == "cuda":
            torch.cuda.empty_cache()
        elif device.type == "mps":
            torch.mps.empty_cache()

    @staticmethod
    def synchronize(device: torch.device) -> None:
        """同步设备操作"""
        if device.type == "cuda":
            torch.cuda.synchronize()
        elif device.type == "mps":
            torch.mps.synchronize()

    @staticmethod
    def get_device() -> torch.device:
        """
        获取计算设备
        优先级：1. FORCE_CPU=1 强制 CPU  2. cuda > mps > cpu
        """
        if os.environ.get('FORCE_CPU') == '1':
            return torch.device("cpu")
        if torch.cuda.is_available():
            return torch.device("cuda")
        if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")

    @staticmethod
    def get_device_name(device: torch.device) -> str:
        """获取设备显示名称"""
        if device.type == "cuda":
            return "GPU"
        elif device.type == "mps":
            return "Apple Silicon"
        else:
            return "CPU"

    @staticmethod
    def print_model_load_stats(model: torch.nn.Module, load_time: float) -> None:
        """打印模型加载统计信息（大小、时间、速度）"""
        # 计算模型大小
        model_size_bytes = sum(p.numel() * p.element_size() for p in model.parameters())
        model_size_mb = model_size_bytes / (1024 * 1024)
        # 计算加载速度
        load_speed_mb_per_sec = model_size_mb / load_time if load_time > 0 else 0
        # 格式化大小
        size_str = f"{model_size_mb:.1f}MB" if model_size_mb < 1024 else f"{model_size_mb / 1024:.2f}GB"
        # 格式化时间
        if load_time < 1:
            time_str = f"{load_time * 1000:.1f}ms"
        elif load_time < 60:
            time_str = f"{load_time:.2f}s"
        else:
            time_str = f"{int(load_time // 60)}m{load_time % 60:.1f}s"
        print(f"✅ 模型加载完成 [大小: {size_str}, 耗时: {time_str}, 速度: {load_speed_mb_per_sec:.1f}MB/s]")

    @staticmethod
    def print_cuda_memory_summary(title="GPU 内存统计", device=0):
        """打印详细的 CUDA 内存统计信息"""
        if not torch.cuda.is_available():
            return
        print(f"\n{'='*60}")
        print(f"🔍 {title}")
        print(f"{'='*60}")
        # 基本统计
        allocated = torch.cuda.memory_allocated(device) / 1024**3
        reserved = torch.cuda.memory_reserved(device) / 1024**3
        max_allocated = torch.cuda.max_memory_allocated(device) / 1024**3
        total = torch.cuda.get_device_properties(device).total_memory / 1024**3
        print(f"📊 总显存: {total:.2f} GB")
        print(f"✅ 已分配 (allocated): {allocated:.2f} GB  ({allocated/total*100:.1f}%)")
        print(f"📦 已预留 (reserved): {reserved:.2f} GB  ({reserved/total*100:.1f}%)")
        print(f"📈 峰值分配: {max_allocated:.2f} GB")
        print(f"💚 可用空间: {total - reserved:.2f} GB  ({(total-reserved)/total*100:.1f}%)")
        print(f"🔸 碎片化: {reserved - allocated:.2f} GB")
        # 详细统计（简化版）
        try:
            stats = torch.cuda.memory_stats(device)
            num_allocs = stats.get("num_alloc_retries", 0)
            num_ooms = stats.get("num_ooms", 0)
            if num_allocs > 0 or num_ooms > 0:
                print(f"⚠️  分配重试: {num_allocs} 次, OOM: {num_ooms} 次")
        except Exception:
            pass
        print(f"{'='*60}\n")
