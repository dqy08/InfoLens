"""进程启动时的环境变量修复（仅依赖 stdlib，不引入 OpenMP 等）。"""

import os
import multiprocessing


def diagnose_and_fix_thread_env_vars() -> None:
    """
    诊断并修复 OMP_NUM_THREADS 和 MKL_NUM_THREADS 环境变量。

    在 HF Space 的 CUDA 容器中，可能预设了无效的环境变量值，
    这会导致 bitsandbytes 库初始化时 libgomp 报错。
    """
    actual_cores = multiprocessing.cpu_count()
    env_vars = ['OMP_NUM_THREADS', 'MKL_NUM_THREADS']
    is_first_fix = True

    for env_var in env_vars:
        value = os.environ.get(env_var)
        if value is None:
            continue

        stripped = value.strip()
        is_valid = False
        reason = ""

        if not stripped:
            reason = "值为空字符串"
        elif not stripped.isdigit():
            reason = f"包含非数字字符: {repr(stripped)}"
        else:
            try:
                int_value = int(stripped)
                if int_value <= 0:
                    reason = f"值 <= 0: {int_value}"
                else:
                    is_valid = True
            except ValueError:
                reason = f"无法转换为整数: {repr(stripped)}"

        if not is_valid:
            if is_first_fix:
                print(f"🔍 检测到无效的线程环境变量（实际 CPU 核数: {actual_cores}）:")
                is_first_fix = False
            os.environ[env_var] = str(actual_cores)
            print(f"   {env_var}:")
            print(f"      - 原始值: {repr(value)}")
            print(f"      - 问题: {reason}")
            print(f"      - 🔧 已自动修复: {env_var}={actual_cores}")
