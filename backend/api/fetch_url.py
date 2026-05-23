"""URL 文本提取 API"""
import json
import re
from urllib.parse import urlparse
import trafilatura
import requests
from backend.api.utils import handle_api_error

# 单次提取的最大字符数上限（防止异常大页面影响性能）
MAX_EXTRACTED_TEXT_LENGTH = 20000


def _is_valid_url(url: str) -> bool:
    """验证 URL 格式"""
    try:
        result = urlparse(url)
        return all([result.scheme in ['http', 'https'], result.netloc])
    except Exception:
        return False


def _is_local_or_private(url: str) -> bool:
    """检查是否为本地或私有网络地址（防止 SSRF 攻击）"""
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname
        
        if not hostname:
            return True
        
        # 检查是否为 localhost
        if hostname in ['localhost', '127.0.0.1', '::1']:
            return True
        
        # 检查是否为私有 IP 地址
        private_patterns = [
            r'^10\.',  # 10.0.0.0/8
            r'^172\.(1[6-9]|2[0-9]|3[0-1])\.',  # 172.16.0.0/12
            r'^192\.168\.',  # 192.168.0.0/16
            r'^169\.254\.',  # 169.254.0.0/16 (link-local)
        ]
        
        for pattern in private_patterns:
            if re.match(pattern, hostname):
                return True
        
        return False
    except Exception:
        return True  # 解析失败时保守处理，拒绝访问


def _format_article_text(metadata: dict) -> str:
    """
    将元数据和正文格式化为类似网页显示的纯文本
    
    Args:
        metadata: trafilatura 提取的 JSON 数据（已解析为字典）
    
    Returns:
        格式化后的文章文本
    """
    lines = []
    
    # 标题
    if metadata.get('title'):
        lines.append(metadata['title'])
        lines.append('')
    
    # 元数据信息（无标签，直接显示内容）
    meta_parts = []
    if metadata.get('author'):
        meta_parts.append(metadata['author'])
    if metadata.get('date'):
        meta_parts.append(metadata['date'])
    # if metadata.get('hostname'):
    #     meta_parts.append(metadata['hostname'])
    if metadata.get('source-hostname'):
        meta_parts.append(metadata['source-hostname'])
    # if metadata.get('filedate'):
    #     meta_parts.append(metadata['filedate'])

    if meta_parts:
        lines.append(' | '.join(meta_parts))
        lines.append('')
    
    # 正文
    if metadata.get('text'):
        lines.append(metadata['text'])
    
    return '\n'.join(lines)


def fetch_url(fetch_request):
    """
    从 URL 提取文本内容
    
    Args:
        fetch_request: 包含 url 字段的字典
    
    Returns:
        (响应字典, 状态码) 元组
    """
    url = fetch_request.get('url', '').strip()
    
    # 验证 URL
    if not url:
        return {
            'success': False,
            'message': '缺少 URL 参数，请提供 url 字段'
        }, 400
    
    if not _is_valid_url(url):
        return {
            'success': False,
            'message': f'无效的 URL 格式: {url}'
        }, 400
    
    # 安全检查：防止 SSRF 攻击
    if _is_local_or_private(url):
        return {
            'success': False,
            'message': '不允许访问本地或私有网络地址'
        }, 400
    
    # 提取文本和元数据
    try:
        from backend.platform.access_log import log_fetch_url
        log_fetch_url(url)
        
        # 使用 requests 下载网页，设置浏览器 User-Agent 和请求头
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
        }
        
        # 下载网页内容（设置超时和请求头）
        response = requests.get(url, headers=headers, timeout=10, allow_redirects=True)
        response.raise_for_status()
        
        # 检查响应内容类型
        content_type = response.headers.get('Content-Type', '').lower()
        if 'text/html' not in content_type and 'text/xml' not in content_type:
            return {
                'success': False,
                'message': f'不支持的内容类型: {content_type}，仅支持 HTML/XML 页面'
            }, 400
        
        # 使用 trafilatura 提取结构化数据（包含元数据和正文）
        result_json = trafilatura.extract(
            response.text,
            url=url,
            with_metadata=True,
            output_format='json'
        )
        
        if not result_json:
            print("⚠️ 无法提取页面内容")
            return {
                'success': False,
                'message': '无法从网页中提取文本内容，可能不是文章页面或页面需要验证'
            }, 400
        
        # 解析 JSON 数据
        metadata = json.loads(result_json)
        
        # 检查是否有正文内容
        if not metadata.get('text') or not metadata['text'].strip():
            print("⚠️ 提取到元数据但无正文内容")
            print("元数据:", json.dumps(metadata, ensure_ascii=False, indent=2))
            return {
                'success': False,
                'message': '无法从网页中提取正文内容'
            }, 400
        
        # 格式化文本（元数据 + 正文）
        formatted_text = _format_article_text(metadata)
        original_char_count = len(formatted_text)
        
        # 构建返回消息（如果截断了，添加提示）
        message = None
        # 检查并截断超长文本
        if original_char_count > MAX_EXTRACTED_TEXT_LENGTH:
            formatted_text = formatted_text[:MAX_EXTRACTED_TEXT_LENGTH]
            message = f'内容较长，已截断为前 {MAX_EXTRACTED_TEXT_LENGTH} 字符（原始长度: {original_char_count} 字符）'
        
        char_count = len(formatted_text)
        
        # 打印提取结果
        # print(formatted_text.split('\n')[:4])
        # print(f"✓ 提取成功: {char_count} 字符" + (f" (截断前: {original_char_count} 字符)" if original_char_count > char_count else ""))
        # 打印除正文外的metadata内容
        metadata_less = metadata.copy()
        metadata_less['raw_text'] = ''
        metadata_less['text'] = ''
        # print(json.dumps(metadata_less, ensure_ascii=False, indent=2))
        
        return {
            'success': True,
            'text': formatted_text,
            'url': url,
            'char_count': char_count,
            'message': message
        }, 200
        
    except requests.exceptions.Timeout:
        return {
            'success': False,
            'message': '请求超时，请检查网络连接或稍后重试'
        }, 400
    except requests.exceptions.RequestException as e:
        return {
            'success': False,
            'message': f'无法访问 URL: {str(e)}'
        }, 400
    except Exception as e:  # noqa: BLE001
        error_response = handle_api_error('URL 文本提取失败', e)
        return error_response, 500
