# Shell 工作流约定

执行 `browser-cdp-enhancement` 时，Shell 是轻量自动化层：用于调用 CDP Proxy、本地脚本、静态网页、JSON 过滤、临时文件和输出收敛。目标是少试错、少污染上下文、少破坏用户环境。

## 常用工具分工

- `curl`：调用 Web/CDP/本地 HTTP API。默认 `-sS`；需要 HTTP 非 2xx 立即失败时用 `-fsS`。
- `jq`：解析、过滤、构造 JSON。不要用脆弱的 `grep`/`sed` 解析 JSON。
- `rg` / `rg --files`：优先用于内容搜索和文件列表查找；不可用时内容搜索退回 `grep`，文件列表退回 `find`。
- `fd`：优先用于按文件名/路径查找，语法简洁、默认尊重忽略规则；不可用时退回 `find`。
- `grep`：`rg` 不可用时的内容搜索兜底；仅用于纯文本搜索，不用于解析 JSON。
- `find`：POSIX 兜底，适合无 `fd`/`rg --files` 环境、精确控制深度/类型/时间，或需要跨系统兼容。
- shell glob：已知目录结构时用于简单展开，避免无谓全盘扫描。
- `sed -n 'A,Bp'` / `head` / `tail`：分段读取长文件或长日志，避免无意义灌入上下文。
- `cat`：只用于短文件；长文件优先 `sed` 分段。
- `tee`：关键输出同时保存和查看摘要。
- `mktemp`：保存截图、HTML、JSON、日志等临时产物，避免覆盖用户文件。
- `python3 - <<'PY'`：URL encode/decode、复杂文本转换、HTML/JSON 小脚本、时间处理、批量数据清洗。
- `node`：运行 skill 自带脚本，或处理与浏览器/CDP 生态更贴近的轻量 JS。

## 命令前检查

需要依赖外部命令时，先检查是否存在；缺失时优先换用已有工具或本 skill 自带脚本，不默认全局安装。

```bash
for cmd in curl jq python3 node rg; do
  command -v "$cmd" >/dev/null 2>&1 || printf 'missing: %s\n' "$cmd" >&2
done
```

## CDP 调用模式

```bash
CDP="http://localhost:4567"

# 创建 tab 并提取 target id；兼容不同返回字段名
target="$({ curl -sS "$CDP/new?url=https://example.com" || true; } | jq -r '.targetId // .id // empty')"
[ -n "$target" ] || { echo "failed to create target" >&2; exit 1; }

# 列出 tab：保存完整结果，只把摘要放进上下文
tmp="$(mktemp -t cdp-targets.XXXXXX.json)"
curl -sS "$CDP/targets" | tee "$tmp" | jq '.[] | {id, title, url}'
```

POST JSON 时优先用 `jq -nc` 或 heredoc，避免 `echo '{...}'` 的引号陷阱：

```bash
jq -nc --arg role "button" --arg name "提交" \
  '{role:$role,name:$name,exact:true}' |
curl -sS -X POST "$CDP/clickAX?target=$target" \
  -H 'content-type: application/json' \
  --data-binary @-
```

复杂 `/eval` JS 用 heredoc 或临时文件，避免 shell/JS/JSON 三层引号混乱：

```bash
js='(() => {
  return [...document.querySelectorAll("a")]
    .slice(0, 20)
    .map(a => ({text: a.innerText.trim(), href: a.href}));
})()'

curl -sS -X POST "$CDP/eval?target=$target" --data-binary "$js" | jq .
```

## URL 与文本处理

```bash
encoded="$(
python3 - <<'PY'
from urllib.parse import quote
print(quote('搜索 关键词', safe=''))
PY
)"
```

较复杂的数据清洗也优先用短 Python 脚本，并把原始输入保留到临时文件，便于复查。

## 输出与文件卫生

- 大输出先写到 `mktemp` 路径，再用 `jq`/`rg`/`sed` 摘要查看。
- 临时截图、HTML、JSON、日志默认写入 `/tmp` 或 `mktemp` 路径；只有用户要求或示例沉淀时才写入项目。
- 不覆盖用户文件；写项目文件前先确认路径属于当前 skill/repo 的预期位置。
- 命令失败时保留关键错误行和复现命令，不贴整段噪声日志。
