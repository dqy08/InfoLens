"""数值格式化等无 I/O 纯工具。"""
import math


def round_to_sig_figs(x: float, n: int = 7) -> float:
    """将浮点数舍入为 n 位有效数字。0 或非有限值原样返回。"""
    if x == 0 or not math.isfinite(x):
        return x
    return float(f"{x:.{n}g}")
