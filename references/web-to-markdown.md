# 网页转 Markdown / 正文抽取

当目标是文章、博客、文档、公告、PDF 等“正文为主”的页面，先尝试网页转 Markdown 预处理，再决定是否把完整页面交给模型或进入 CDP。这样可以减少冗余导航、页脚、广告、脚本和样式带来的 token 消耗。

## 选择顺序

| 场景 | 优先方式 | 说明 |
|------|----------|------|
| 公开正文页、希望最快拿到 Markdown | Jina Reader | 通用性强；可能返回缓存快照；适合文章、文档、PDF |
| 公开正文页、Jina 不理想或想交叉验证 | Cloudflare `markdown.new` | 输出简洁；对单页前端渲染页面可能效果不好 |
| 需要控制请求头、代理、清洗逻辑，或不想依赖第三方转换服务 | 本地 Python | 需第三方库；适合可安装/已有依赖的环境 |
| 登录态、反爬、SPA 渲染、需要交互后内容 | CDP 浏览器 | 网页转 Markdown 通常拿不到真实内容，直接进浏览器层 |
| 表格/数据面板/商品页/搜索结果页 | curl/CDP 结构化抽取 | 正文抽取器可能选错区块或丢字段 |

## Jina Reader

调用方式：在原 URL 前加 `https://r.jina.ai/`，保留原 URL scheme。

```bash
curl -LfsS "https://r.jina.ai/https://example.com"
```

特点：
- 适合文章、博客、文档、PDF 等正文页。
- 可能返回缓存快照；遇到时效性要求高的任务，要回源或用其他方式核对。
- 有速率限制时不要密集重试，换用 `markdown.new`、WebFetch、curl 或 CDP。

## Cloudflare markdown.new

调用方式：在原 URL 前加 `https://markdown.new/`，保留原 URL scheme。

```bash
curl -LfsS "https://markdown.new/https://example.com"
```

特点：
- 输出通常简洁，适合作为 Jina 的替代或交叉验证。
- 对单页前端渲染、需要 JS 执行、需要登录态的页面可能效果不好。
- 如果返回空、错误区块或缺关键内容，不要反复重试；升级到 CDP 或结构化抽取。

## 本地 Python fallback

仅在依赖已存在，或任务明确值得创建临时虚拟环境时使用。不要默认全局 `pip install`。

依赖通常是：

```bash
python3 - <<'PY'
mods = ['requests', 'readability', 'html2text']
for m in mods:
    try:
        __import__(m)
        print(f'ok: {m}')
    except Exception as e:
        print(f'missing: {m} ({e.__class__.__name__})')
PY
```

示例脚本：

```python
from readability import Document  # package: readability-lxml
import html2text
import requests


def url2md(url):
    html = requests.get(url, timeout=20).text
    clean_html = Document(html).summary()
    md = html2text.HTML2Text()
    md.ignore_images = True
    md.ignore_links = False
    return md.handle(clean_html)

print(url2md("https://example.com"))
```

若需要临时安装，优先使用项目外临时 venv，并记录命令；任务结束后可删除：

```bash
venv="$(mktemp -d)/venv"
python3 -m venv "$venv"
"$venv/bin/python" -m pip install -q requests readability-lxml html2text
"$venv/bin/python" url2md.py
```

## 使用原则

- 网页转 Markdown 是“预处理/降噪”，不是事实核验。重要信息仍需一手来源、原页面或官方文档确认。
- 如果两种转换结果冲突，以原页面运行时行为、HTML 源码、官方结构化数据或 CDP 观察为准。
- 对时效性强的内容，警惕缓存；必要时直接 curl 原 URL 或用浏览器刷新确认。
- 对图片、视频、动态列表、隐藏状态、交互后内容，直接用 CDP/DOM/媒体提取，不强行转 Markdown。
