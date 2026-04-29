#!/usr/bin/env python3
"""
批量分析JSON文件脚本

从指定目录递归搜索JSON文件，读取其中的文本内容，向后端发送分析请求，
并将结果保存到新文件。
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional, Tuple

try:
    import requests
except ImportError:
    print("错误: 需要安装 requests 库")
    print("请运行: pip install requests")
    sys.exit(1)


# 后端API地址
# DEFAULT_API_BASE = "https://dqy08-inforadar.hf.space"
DEFAULT_API_BASE = "http://localhost:5001"
API_ENDPOINT = "/api/analyze"

# Hugging Face Token（用于Private Space，可通过环境变量HF_TOKEN设置）
HF_TOKEN_ENV = "HF_TOKEN"

# 要搜索的目录列表
SEARCH_DIRS = [
    "data/demo/未读"
]


def find_json_files(base_dir: str, search_dirs: list) -> list[Path]:
    """递归搜索指定目录下的所有JSON文件"""
    json_files = []
    base_path = Path(base_dir)
    
    for search_dir in search_dirs:
        search_path = base_path / search_dir
        if not search_path.exists():
            print(f"⚠️  目录不存在: {search_path}")
            continue
        
        # 递归搜索所有.json文件
        for json_file in search_path.rglob("*.json"):
            json_files.append(json_file)
    
    return json_files


def load_json_file(file_path: Path) -> Optional[dict]:
    """加载JSON文件"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        print(f"❌ JSON解析错误 {file_path}: {e}")
        return None
    except Exception as e:
        print(f"❌ 读取文件错误 {file_path}: {e}")
        return None


def extract_text_from_json(data: dict) -> Optional[str]:
    """从JSON数据中提取文本内容"""
    if not isinstance(data, dict):
        return None
    
    # 尝试从 request.text 字段提取
    request = data.get('request', {})
    if isinstance(request, dict):
        text = request.get('text')
        if text:
            return text
    
    # 如果没有request.text，尝试直接获取text字段
    text = data.get('text')
    if text:
        return text
    
    return None


def get_model_from_json(data: dict) -> Optional[str]:
    """从JSON数据中提取模型名称（从result.model读取）"""
    if not isinstance(data, dict):
        return None
    
    result = data.get('result', {})
    if isinstance(result, dict):
        model = result.get('model')
        if model:
            return model
    
    return None


def generate_output_filename(input_path: Path, model_name: Optional[str] = None) -> Path:
    """生成输出文件名，处理后缀逻辑"""
    stem = input_path.stem  # 不含扩展名的文件名
    
    # 如果已有 _qwen2.5 后缀，则删除
    if stem.endswith('_qwen2.5'):
        stem = stem[:-8]  # 删除 '_qwen2.5'
    elif stem.endswith('_qwen2'):
        stem = stem[:-6]  # 删除 '_qwen2'
    
    # 如果有模型名，添加模型名后缀
    if model_name:
        # 清理模型名：只将空格替换为下划线，保留点和其他字符
        clean_model = model_name.replace(' ', '_')
        stem = f"{stem}_{clean_model}"
    
    # 构建新路径
    return input_path.parent / f"{stem}.json"


def analyze_text(api_base: str, text: str, model: Optional[str] = None, token: Optional[str] = None, max_retries: int = 3) -> Optional[dict]:
    """向后端发送分析请求，支持自动重试"""
    # URL 拼接：确保正确拼接路径
    api_base = api_base.rstrip('/')
    endpoint = API_ENDPOINT.lstrip('/')
    url = f"{api_base}/{endpoint}"
    
    payload = {
        "text": text,
        "model": model if model else "default"  # 使用 "default" 让后端使用默认模型
    }
    
    # 构建请求头
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    
    # 重试逻辑
    last_error = None
    for attempt in range(1, max_retries + 1):
        try:
            response = requests.post(
                url,
                json=payload,
                headers=headers,
                timeout=300  # 5分钟超时
            )
            response.raise_for_status()
            if attempt > 1:
                print(f"   ✅ 重试成功 (第 {attempt} 次尝试)")
            return response.json()
            
        except requests.exceptions.SSLError as e:
            last_error = e
            if attempt < max_retries:
                wait_time = attempt * 2  # 2秒、4秒、6秒
                print(f"   ⚠️  SSL错误 (尝试 {attempt}/{max_retries})，{wait_time}秒后重试...")
                time.sleep(wait_time)
            else:
                print(f"❌ SSL错误: {e}")
                print(f"   💡 提示: 网络连接不稳定，已重试 {max_retries} 次仍失败")
                
        except requests.exceptions.RequestException as e:
            last_error = e
            # 对于某些错误，不重试（如 404, 401, 400）
            if hasattr(e, 'response') and e.response is not None:
                status_code = e.response.status_code
                if status_code in [404, 401, 400]:
                    print(f"❌ API请求错误: {e}")
                    print(f"   响应状态码: {status_code}")
                    if status_code == 404:
                        print(f"   💡 提示: 如果是Private Space，请确保设置了HF Token")
                    elif status_code == 401:
                        print(f"   💡 提示: Token无效或已过期，请检查HF Token")
                    return None
            
            # 对于其他错误，尝试重试
            if attempt < max_retries:
                wait_time = attempt * 2
                print(f"   ⚠️  请求错误 (尝试 {attempt}/{max_retries})，{wait_time}秒后重试...")
                time.sleep(wait_time)
            else:
                print(f"❌ API请求错误: {e}")
                if hasattr(e, 'response') and e.response is not None:
                    try:
                        error_detail = e.response.json()
                        print(f"   错误详情: {error_detail}")
                    except:
                        if e.response.text:
                            print(f"   响应内容: {e.response.text[:200]}")
    
    return None


def save_result(output_path: Path, result: dict):
    """保存分析结果到文件"""
    try:
        # 确保输出目录存在
        output_path.parent.mkdir(parents=True, exist_ok=True)
        
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"✅ 已保存")
    except Exception as e:
        print(f"❌ 保存文件错误 {output_path}: {e}")


def process_file(
    file_path: Path,
    api_base: str,
    dry_run: bool = False,
    no_write: bool = False,
    token: Optional[str] = None
) -> Tuple[bool, Optional[Path]]:
    """处理单个JSON文件"""
    print(f"\n📄 处理文件: {file_path}")
    
    # 加载JSON文件
    data = load_json_file(file_path)
    if data is None:
        return False, None
    
    # 提取文本
    text = extract_text_from_json(data)
    if not text:
        print(f"⚠️  未找到文本内容，跳过")
        return False, None
    
    # 提取模型名（仅用于日志显示，实际请求使用默认模型）
    original_model = get_model_from_json(data)
    
    print(f"   文本长度: {len(text)} 字符")
    if original_model:
        print(f"   原文件模型: {original_model} (将使用默认模型)")
    else:
        print(f"   将使用默认模型")
    
    if dry_run:
        # dry-run模式下，无法知道实际使用的模型，使用占位符
        print(f"   [DRY RUN] 将发送分析请求（使用默认模型，不实际执行）")
        # 输出文件名会在实际运行时从响应中获取模型名后生成
        return True, None
    
    # 发送分析请求（传递 "default" 让后端使用默认模型）
    print(f"   📤 发送分析请求（使用默认模型）...")
    result = analyze_text(api_base, text, "default", token)  # 传递 "default" 使用默认模型
    
    if result is None:
        print(f"   ❌ 分析失败")
        return False, None
    
    # 检查是否有错误
    if result.get('success') is False:
        error_msg = result.get('message', '未知错误')
        print(f"   ❌ 分析失败: {error_msg}")
        return False, None
    
    # 从响应中提取实际使用的模型名（用于生成输出文件名）
    response_model = None
    result_info = result.get('result', {})
    if isinstance(result_info, dict):
        response_model = result_info.get('model')
    
    if response_model:
        print(f"   实际使用模型: {response_model}")
    else:
        # 如果响应中没有模型名，使用 "default" 作为占位符
        response_model = "default"
        print(f"   ⚠️  响应中未找到模型名，使用 'default' 作为文件名后缀")
    
    # 使用响应中的模型名生成输出文件名
    output_path = generate_output_filename(file_path, response_model)
    print(f"   输出文件: {output_path}")
    
    # 保存结果（除非指定了 --no-write）
    if no_write:
        print(f"   [NO WRITE] 跳过保存文件")
    else:
        save_result(output_path, result)
    
    return True, output_path


def main():
    parser = argparse.ArgumentParser(
        description="批量分析JSON文件",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 干运行模式（不实际分析）
  python analyze_json.py --dry-run
  
  # 实际分析但不保存文件
  python analyze_json.py --no-write
  
  # 实际分析并保存文件
  python analyze_json.py
  
  # 指定自定义API地址
  python analyze_json.py --api-base http://localhost:5001
  
  # 限制最多分析10个文件
  python analyze_json.py --max-file 10
  
  # 使用HF Token访问Private Space
  python analyze_json.py --hf-token hf_xxxxxxxxxxxxx
  
  # 或通过环境变量设置HF Token
  export HF_TOKEN=hf_xxxxxxxxxxxxx
  python analyze_json.py
        """
    )
    
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='干运行模式，不实际发送分析请求'
    )
    
    parser.add_argument(
        '--no-write',
        action='store_true',
        help='不实际保存文件（仍会发送分析请求）'
    )
    
    parser.add_argument(
        '--api-base',
        type=str,
        default=DEFAULT_API_BASE,
        help=f'后端API基础地址 (默认: {DEFAULT_API_BASE})'
    )
    
    parser.add_argument(
        '--base-dir',
        type=str,
        default='.',
        help='项目根目录 (默认: 当前目录)'
    )
    
    parser.add_argument(
        '--max-file',
        type=int,
        default=None,
        help='最多分析的文件数量 (默认: 无限制)'
    )
    
    parser.add_argument(
        '--hf-token',
        type=str,
        default=None,
        help=f'Hugging Face Token（用于Private Space，也可通过环境变量{HF_TOKEN_ENV}设置）'
    )
    
    args = parser.parse_args()
    
    # 获取HF Token（优先使用命令行参数，其次环境变量）
    hf_token = args.hf_token or os.environ.get(HF_TOKEN_ENV)
    
    # 显示配置
    print("=" * 60)
    print("批量分析JSON文件")
    print("=" * 60)
    print(f"API地址: {args.api_base}")
    print(f"基础目录: {args.base_dir}")
    print(f"搜索目录: {', '.join(SEARCH_DIRS)}")
    print(f"模式: {'DRY RUN (不实际分析)' if args.dry_run else '实际分析'}")
    if args.max_file:
        print(f"最大文件数: {args.max_file}")
    if hf_token:
        token_preview = hf_token[:10] + "..." if len(hf_token) > 10 else hf_token
        print(f"HF Token: {token_preview} (已设置)")
    else:
        print(f"HF Token: 未设置 (如果是Private Space，请通过 --hf-token 或环境变量 {HF_TOKEN_ENV} 设置)")
    print("=" * 60)
    
    # 查找所有JSON文件
    print(f"\n🔍 搜索JSON文件...")
    json_files = find_json_files(args.base_dir, SEARCH_DIRS)
    
    if not json_files:
        print("❌ 未找到任何JSON文件")
        return
    
    print(f"✅ 找到 {len(json_files)} 个JSON文件")
    
    # 根据 max_file 限制文件数量
    if args.max_file and args.max_file > 0:
        original_count = len(json_files)
        json_files = json_files[:args.max_file]
        if len(json_files) < original_count:
            print(f"📌 限制处理数量: {len(json_files)} 个文件 (共找到 {original_count} 个)")
    
    # 处理每个文件
    success_count = 0
    failed_count = 0
    total_to_process = len(json_files)
    
    for i, json_file in enumerate(json_files, 1):
        print(f"\n[{i}/{total_to_process}]")
        success, output_path = process_file(json_file, args.api_base, args.dry_run, args.no_write, hf_token)
        
        if success:
            success_count += 1
        else:
            failed_count += 1
    
    # 统计结果
    print("\n" + "=" * 60)
    print("处理完成")
    print("=" * 60)
    print(f"成功: {success_count}")
    print(f"失败: {failed_count}")
    print(f"总计: {total_to_process}")
    print("=" * 60)


if __name__ == '__main__':
    main()

