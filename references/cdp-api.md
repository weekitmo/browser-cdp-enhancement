# CDP Proxy API 参考

## 基础信息

- 地址：`http://localhost:4567`
- 启动：`node ~/.claude/skills/browser-cdp-enhancement/scripts/cdp-proxy.mjs &`
- 启动后持续运行，不建议主动停止（重启后可能需要浏览器重新授权）
- 强制停止：`pkill -f cdp-proxy.mjs`

## API 端点

### GET /health
健康检查，返回连接状态。
```bash
curl -s http://localhost:4567/health
```

### GET /targets
列出所有已打开的页面 tab。返回数组，每项含 `targetId`、`title`、`url`。
```bash
curl -s http://localhost:4567/targets
```

### GET /new?url=URL
创建新后台 tab，自动等待页面加载完成。返回 `{ targetId }`.
```bash
curl -s "http://localhost:4567/new?url=https://example.com"
```

### GET /close?target=ID
关闭指定 tab。
```bash
curl -s "http://localhost:4567/close?target=TARGET_ID"
```

### GET /navigate?target=ID&url=URL
在已有 tab 中导航到新 URL，自动等待加载。
```bash
curl -s "http://localhost:4567/navigate?target=ID&url=https://example.com"
```

### GET /back?target=ID
后退一页。
```bash
curl -s "http://localhost:4567/back?target=ID"
```

### GET /info?target=ID
获取页面基础信息（title、url、readyState）。
```bash
curl -s "http://localhost:4567/info?target=ID"
```

### POST /eval?target=ID
执行 JavaScript 表达式，POST body 为 JS 代码。
```bash
curl -s -X POST "http://localhost:4567/eval?target=ID" -d 'document.title'
```

### POST /click?target=ID
JS 层面点击（`el.click()`），POST body 为 CSS 选择器。自动 scrollIntoView 后点击。简单快速，覆盖大多数场景。
```bash
curl -s -X POST "http://localhost:4567/click?target=ID" -d 'button.submit'
```

### POST /clickAt?target=ID
CDP 浏览器级真实鼠标点击（`Input.dispatchMouseEvent`），POST body 为 CSS 选择器。先获取元素坐标，再模拟鼠标按下/释放。算真实用户手势，能触发文件对话框、绕过部分反自动化检测。
```bash
curl -s -X POST "http://localhost:4567/clickAt?target=ID" -d 'button.upload'
```

### GET /ax?target=ID&role=button&name=提交&exact=1
查询 Accessibility Tree 节点。适合按用户可见语义定位按钮、链接、输入框、菜单项等控件。返回 `role`、`name`、`properties`、`backendDOMNodeId` 等摘要。
```bash
curl -s "http://localhost:4567/ax?target=ID&role=button&name=提交&exact=1"
curl -s "http://localhost:4567/ax?target=ID&role=textbox&name=搜索"
```

### POST /clickAX?target=ID
按 Accessibility Tree 的 `role` / `name` 定位节点，通过 `backendDOMNodeId` 映射到 DOM box，再用真实鼠标事件点击中心点。POST body 为 JSON；可选 `exact`、`index`、`properties`。
```bash
curl -s -X POST "http://localhost:4567/clickAX?target=ID" \
  -d '{"role":"button","name":"提交","exact":true}'
```

### POST /setFiles?target=ID
给 file input 设置本地文件路径（`DOM.setFileInputFiles`），完全绕过文件对话框。POST body 为 JSON。
```bash
curl -s -X POST "http://localhost:4567/setFiles?target=ID" -d '{"selector":"input[type=file]","files":["/path/to/file1.png","/path/to/file2.png"]}'
```

### GET /scroll?target=ID&y=3000&direction=down
滚动页面。`direction` 可选 `down`（默认）、`up`、`top`、`bottom`。滚动后自动等待 800ms 供懒加载触发。
```bash
curl -s "http://localhost:4567/scroll?target=ID&y=3000"
curl -s "http://localhost:4567/scroll?target=ID&direction=bottom"
```

### GET /screenshot?target=ID&file=/tmp/shot.png
截图。指定 `file` 参数保存到本地文件；不指定则返回图片二进制。可选 `format=jpeg`。
```bash
curl -s "http://localhost:4567/screenshot?target=ID&file=/tmp/shot.png"
```

## /eval 使用提示

- POST body 为任意 JS 表达式，返回 `{ value }` 或 `{ error }`
- 支持 `awaitPromise`：可以写 async 表达式
- 返回值必须是可序列化的（字符串、数字、对象），DOM 节点不能直接返回，需要提取属性
- 提取大量数据时用 `JSON.stringify()` 包裹，确保返回字符串
- 根据页面实际 DOM 结构编写选择器，不要套用固定模板

## 错误处理

| 错误 | 原因 | 解决 |
|------|------|------|
| `未发现已开启远程调试的浏览器` | 浏览器未开启远程调试 | 提示用户用 `scripts/check-deps.mjs --launch <浏览器名>` 启动，或在对应 inspect 页面勾选 Allow |
| `attach 失败` | targetId 无效或 tab 已关闭 | 用 `/targets` 获取最新列表 |
| `CDP 命令超时` | 页面长时间未响应 | 重试或检查 tab 状态 |
| `未找到匹配的 AX 节点` | AX Tree 中没有符合 role/name 的节点 | 放宽 `name`、检查 `/ax` 候选，或退回 `/eval` / CSS selector |
| `端口已被占用` | 另一个 proxy 已在运行 | 已有实例可直接复用 |
