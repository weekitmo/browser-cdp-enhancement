---
name: browser-cdp-enhancement
license: MIT
description: >-
  Use when an AI agent needs reliable web access beyond plain search: choosing between
  WebSearch, WebFetch, curl, Jina, and a real browser; reading pages; verifying information
  against primary sources; using logged-in Chromium browser sessions; operating dynamic or
  anti-scraping sites; interacting with visible controls through an Accessibility Tree first
  workflow; inspecting console output; uploading files; extracting media; sampling video
  frames; or finding previously visited/internal pages from local bookmarks and history.
  This skill provides the CDP proxy workflow, browser selection and startup checks, tab
  hygiene, site-experience reuse, and parallel research guidance for browser-based tasks.
metadata:
  author: weekitmo
  version: "1.0.0"
---

# browser-cdp-enhancement Skill

## 前置检查

在开始联网操作前，先检查 CDP 模式可用性：

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-deps.mjs"
```

**退出码含义：**
- **0**：检查通过，浏览器已连接，Proxy 就绪
- **1**：错误（Node 版本问题、端口占用等）
- **2**：需要用户选择浏览器（首次使用或保存的配置失效）

**当退出码为 2 时**，agent 必须引导用户完成浏览器选择：

1. 解析输出中的 `installed` 列表
2. 用 `AskUserQuestion` 让用户选择浏览器，选项为检测到的浏览器列表
3. 运行 `node "${CLAUDE_SKILL_DIR}/scripts/check-deps.mjs" --launch "<浏览器名>"` 启动并连接
4. 选择会自动保存到 `.cdp-browser.json`，后续使用无需再次选择

**当退出码为 1 且提示浏览器未连接时**，引导用户：
- **首次配置**：推荐使用 `--launch` 自动启动（无需手动操作浏览器）
- **手动配置**（备选）：在浏览器地址栏打开 `chrome://inspect/#remote-debugging`（Vivaldi 为 `vivaldi://inspect/#remote-debugging`），勾选 "Allow remote debugging"
- **永久免弹窗**：用 `--remote-debugging-port=9222` 参数启动浏览器（如 `open -a "Brave Browser" --args --remote-debugging-port=9222 --remote-allow-origins=*`）

**`--detect` 参数**（可选）：`node check-deps.mjs --detect` 输出已安装浏览器 JSON 列表，不启动任何东西。

> **Node.js 22+**：必需（使用原生 WebSocket）。版本低于 22 可用但需安装 `ws` 模块。

检查通过后并必须在回复中向用户直接展示以下须知，再启动 CDP Proxy 执行操作：

```
温馨提示：部分站点对浏览器自动化操作检测严格，存在账号封禁风险。已内置防护措施但无法完全避免，Agent 继续操作即视为接受。
```

## Shell 工作流

执行本 skill 涉及 `curl`/CDP/API 调用、JSON 处理、临时文件、URL 编解码或批量文本清洗时，先读取 `references/shell-workflow.md`。入口文件只保留原则；具体 Bash/Zsh 命令模式、`jq`/`python3`/`rg`/`sed`/`tee`/`mktemp` 用法和输出收敛规则放在该参考文件中。

## 浏览哲学

**像人一样思考，兼顾高效与适应性的完成任务。**

执行任务时不会过度依赖固有印象所规划的步骤，而是带着目标进入，边看边判断，遇到阻碍就解决，发现内容不够就深入——全程围绕「我要达成什么」做决策。这个 skill 的所有行为都应遵循这个逻辑。

**① 拿到请求** — 先明确用户要做什么，定义成功标准：什么算完成了？需要获取什么信息、执行什么操作、达到什么结果？这是后续所有判断的锚点。

**② 选择起点** — 根据任务性质、平台特征、达成条件，选一个最可能直达的方式作为第一步去验证。一次成功当然最好；不成功则在③中调整。比如，需要操作页面、需要登录态、已知静态方式不可达的平台（小红书、微信公众号等）→ 直接 CDP

**③ 过程校验** — 每一步的结果都是证据，不只是成功或失败的二元信号。用结果对照①的成功标准，更新你对目标的判断：路径在推进吗？结果的整体面貌（质量、相关度、量级）是否指向目标可达？发现方向错了立即调整，不在同一个方式上反复重试——搜索没命中不等于"还没找对方法"，也可能是"目标不存在"；API 报错、页面缺少预期元素、重试无改善，都是在告诉你该重新评估方向。遇到弹窗、登录墙等障碍，判断它是否真的挡住了目标：挡住了就处理，没挡住就绕过——内容可能已在页面 DOM 中，交互只是展示手段。

**④ 完成判断** — 对照定义的任务成功标准，确认任务完成后才停止，但也不要过度操作，不为了"完整"而浪费代价。

## 联网工具选择

- **确保信息的真实性，一手信息优于二手信息**：搜索引擎和聚合平台是信息发现入口。当多次搜索尝试后没有质的改进时，升级到更根本的获取方式：定位一手来源（官网、官方平台、原始页面）。

| 场景 | 工具 |
|------|------|
| 搜索摘要或关键词结果，发现信息来源 | **WebSearch** |
| URL 已知，需要从页面定向提取特定信息 | **WebFetch**（拉取网页内容，由小模型根据 prompt 提取，返回处理后结果） |
| URL 已知，需要原始 HTML 源码（meta、JSON-LD 等结构化字段） | **curl** |
| 非公开内容，或已知静态层无效的平台（小红书、微信公众号等公开内容也被反爬限制） | **浏览器 CDP**（直接，跳过静态层） |
| 需要登录态、交互操作，或需要像人一样在浏览器内自由导航探索 | **浏览器 CDP** |

浏览器 CDP 不要求 URL 已知——可从任意入口出发，通过页面内搜索、点击、跳转等方式找到目标内容。WebSearch、WebFetch、curl 均不处理登录态。

**网页转 Markdown 预处理**（可与 WebFetch/curl 组合使用，用于减少冗余 token）：公开正文页可优先尝试 Jina Reader 或 Cloudflare `markdown.new`，必要时用本地 Python 正文抽取；具体选择、命令、限制与 fallback 见 `references/web-to-markdown.md`。这类方式适合文章、博客、文档、PDF 等正文页；对登录态、前端渲染、数据面板、商品页等可能失真或缺内容，需改用 curl 结构化抽取或浏览器 CDP。

进入浏览器层后，**先用页面语义操作，再用 DOM 结构补充**：

- **找控件**：可见/可操作元素先用 `/ax` 查 Accessibility Tree（角色、可访问名称、状态），不要先猜 CSS selector。
- **点控件**：按钮、链接、tab、菜单项、复选框等优先用 `/clickAX` 真实鼠标点击；AX 不可用时再退回 `/click` / `/clickAt` / `/eval`。
- **读数据**：批量提取列表、表格、媒体 URL、隐藏 DOM 状态时用 `/eval`；这类结构化读取不是点击定位，不必强行走 AX。
- **补视觉**：页面语义或 DOM 都不足以判断时再用 `/screenshot`，尤其是图片/视频承载核心信息时。

浏览网页时，**先了解页面结构，再决定下一步动作**。不需要提前规划所有步骤。

### 强规则：AX Tree First 操作模式

当目标是用户可见/可操作控件（按钮、链接、输入框、菜单项、复选框、tab、搜索框、作者名、卡片入口等），**必须优先使用 Accessibility Tree（AX Tree）按语义定位**，再退回 CSS selector / JS query。AX Tree 基于浏览器暴露给无障碍技术的角色与可访问名称，通常比猜 DOM 结构或 class 更稳定，更接近用户描述里的「提交按钮」「搜索输入框」「某个作者主页」，也能用更少 token 看清页面可操作结构。

**默认决策顺序：**

1. **用户会说得出的东西**（按钮、链接、输入框、tab、菜单、作者名、搜索结果）→ 先 `/ax`。
2. **需要点击/进入/切换的东西** → 先 `/clickAX`；若 AX 节点没有坐标或点击失败，再记录原因并退回 `/clickAt` / `/click` / `/eval`。
3. **需要输入文字** → 先用 `/ax` 找 textbox/searchbox 并点击聚焦；若代理没有专门输入端点，可在已确认目标后用最小 `/eval` 设置值并触发 input/keyboard 事件。
4. **需要批量读取数据**（视频卡片、表格行、JSON-LD、媒体 URL）→ 用 `/eval` 结构化提取；这是读取数据，不是控件定位。
5. **如果没有先用 AX** 就直接写 `document.querySelector(...)` 定位可见控件，必须能说明例外：AX 不暴露目标、目标在 canvas/Shadow DOM/iframe 中不可达、需要复杂状态读取，或这是批量数据提取。

常用流程：

1. 先用 AX Tree 查候选节点：

```bash
curl -s "http://localhost:4567/ax?target=ID&role=button&name=提交&exact=1"
curl -s "http://localhost:4567/ax?target=ID&role=textbox&name=搜索"
```

2. 确认节点的 `role`、`name`、`properties`、`backendDOMNodeId` 符合目标。
3. 对可点击控件，优先用真实鼠标事件点击 AX 节点：

```bash
curl -s -X POST "http://localhost:4567/clickAX?target=ID" \
  -d '{"role":"button","name":"提交","exact":true}'
```

`/ax` 内部使用 `Accessibility.enable` + `Accessibility.getFullAXTree`；`/clickAX` 会通过 AX 节点的 `backendDOMNodeId` 映射到 DOM box，再用 `Input.dispatchMouseEvent` 点击中心点。若 AX Tree 没暴露目标、节点无坐标、或需要读取/修改复杂页面状态，再使用 `/eval` 与 DOM API 兜底。不要盲目优先写 `document.querySelector(...)`；先让浏览器告诉你页面的语义结构。

### 补充：本地浏览器资源

用户指向**本人访问过的页面**（"我之前看的那个讲 X 的文章"、"上次打开过的 XX 面板"）或**组织内部系统**（"我们的 XX 平台"、"公司那个 YY 系统"等公网搜不到的目标）时，检索本地 Chromium 系浏览器书签/历史。脚本支持 Chrome、Brave、Vivaldi、Edge；默认优先使用 `.cdp-browser.json` 中选择的浏览器，找不到配置或数据目录时自动扫描全部已存在的数据目录。

```bash
node "${CLAUDE_SKILL_DIR}/scripts/find-url.mjs" [关键词...] [--browser chrome|brave|vivaldi|edge|all] [--only bookmarks|history] [--limit N] [--since 1d|7h|YYYY-MM-DD] [--sort recent|visits]
```

关键词空格分词、多词 AND，匹配 title + url（可省略）；`--browser all` 可跨浏览器查找；`--since` / `--sort` 仅作用于历史；默认按最近访问倒序，`--sort visits` 按访问次数排序（适合"高频访问的网站"这类场景）。

### 程序化操作与 GUI 交互

浏览器内操作页面有两种方式：

- **程序化方式**（构造 URL 直接导航、eval 操作 DOM）：成功时速度快、精确，但对网站来说不是正常用户行为，可能触发反爬机制。
- **GUI 交互**（点击按钮、填写输入框、滚动浏览）：GUI 是为人设计的，网站不会限制正常的 UI 操作，确定性最高，但步骤多、速度慢。

根据对目标平台的了解来灵活选择方式。GUI 交互也是程序化方式的有效探测——通过一次真实交互观察站点的实际行为（URL 模式、必需参数、页面跳转逻辑），为后续程序化操作提供依据；同时当程序化方式受阻时，GUI 交互是可靠的兜底。

**站点内交互产生的链接是可靠的**：通过用户视角中的可交互单元（卡片、条目、按钮）进行的站点内交互，自然到达的 URL 天然携带平台所需的完整上下文。而手动构造的 URL 可能缺失隐式必要参数，导致被拦截、返回错误页面、甚至触发反爬。

## 浏览器 CDP 模式

通过 CDP Proxy 直连用户日常浏览器，天然携带登录态，无需启动独立浏览器。
若无用户明确要求，不主动操作用户已有 tab，所有操作都在自己创建的后台 tab 中进行，保持对用户环境的最小侵入。不关闭用户 tab 的前提下，完成任务后关闭自己创建的 tab，保持环境整洁。

### 启动

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-deps.mjs"
```

脚本会依次检查 Node.js、浏览器调试端口，并确保 Proxy 已连接（未运行则自动启动并等待）。Proxy 启动后持续运行。

### Proxy API

所有操作通过 curl 调用 HTTP API：

```bash
# 列出用户已打开的 tab
curl -s http://localhost:4567/targets

# 创建新后台 tab（自动等待加载）
curl -s "http://localhost:4567/new?url=https://example.com"

# 页面信息
curl -s "http://localhost:4567/info?target=ID"

# 执行任意 JS：可读写 DOM、提取数据、操控元素、触发状态变更、提交表单、调用内部方法
curl -s -X POST "http://localhost:4567/eval?target=ID" -d 'document.title'

# 捕获页面渲染状态（含视频当前帧）
curl -s "http://localhost:4567/screenshot?target=ID&file=/tmp/shot.png"

# 导航、后退
curl -s "http://localhost:4567/navigate?target=ID&url=URL"
curl -s "http://localhost:4567/back?target=ID"

# 点击（POST body 为 CSS 选择器）— JS el.click()，简单快速，覆盖大多数场景
curl -s -X POST "http://localhost:4567/click?target=ID" -d 'button.submit'

# 真实鼠标点击 — CDP Input.dispatchMouseEvent，算用户手势，能触发文件对话框
curl -s -X POST "http://localhost:4567/clickAt?target=ID" -d 'button.upload'

# Accessibility Tree 查询与点击 — 优先用于语义明确的控件定位
curl -s "http://localhost:4567/ax?target=ID&role=button&name=提交&exact=1"
curl -s -X POST "http://localhost:4567/clickAX?target=ID" -d '{"role":"button","name":"提交","exact":true}'

# 文件上传 — 直接设置 file input 的本地文件路径，绕过文件对话框
curl -s -X POST "http://localhost:4567/setFiles?target=ID" -d '{"selector":"input[type=file]","files":["/path/to/file.png"]}'

# 滚动（触发懒加载）
curl -s "http://localhost:4567/scroll?target=ID&y=3000"
curl -s "http://localhost:4567/scroll?target=ID&direction=bottom"

# 关闭 tab
curl -s "http://localhost:4567/close?target=ID"

# 开启 console 日志捕获（必须先调用才能获取日志）
curl -s "http://localhost:4567/console/enable?target=ID"

# 获取 console 日志（可选参数：level=error,warn&limit=50&clear=1）
curl -s "http://localhost:4567/console?target=ID"
curl -s "http://localhost:4567/console?target=ID&level=error"
curl -s "http://localhost:4567/console?target=ID&level=error,warn&limit=20&clear=1"

# 清空日志缓冲区
curl -s "http://localhost:4567/console/clear?target=ID"
```

### 页面内导航

两种方式打开页面内的链接：

- **`/click`**：在当前 tab 内直接点击用户视角中的可交互单元，简单直接，串行处理。适合需要在同一页面内连续操作的场景，如点击展开、翻页、进入详情等。
- **`/new` + 完整 URL**：使用目标链接的完整地址（包含所有URL参数），在新 tab 中打开。适合需要同时访问多个页面的场景。

很多网站的链接包含会话相关的参数（如 token），这些参数是正常访问所必需的。提取 URL 时应保留完整地址，不要裁剪或省略参数。

### 媒体资源提取

判断内容在图片里时，用 `/eval` 从 DOM 直接拿图片 URL，再定向读取——比全页截图精准得多。

### 技术事实
- 页面中存在大量已加载但未展示的内容——轮播中非当前帧的图片、折叠区块的文字、懒加载占位元素等，它们存在于 DOM 中但对用户不可见。以数据结构（容器、属性、节点关系）为单位思考，可以直接触达这些内容。
- DOM 中存在选择器不可跨越的边界（Shadow DOM 的 `shadowRoot`、iframe 的 `contentDocument`等）。eval 递归遍历可一次穿透所有层级，返回带标签的结构化内容，适合快速了解未知页面的完整结构。
- `/scroll` 到底部会触发懒加载，使未进入视口的图片完成加载。提取图片 URL 前若未滚动，部分图片可能尚未加载。
- 拿到媒体资源 URL 后，公开资源可直接下载到本地后用读取；需要登录态才可获取的资源才需要在浏览器内 navigate + screenshot。
- 短时间内密集打开大量页面（如批量 `/new`）可能触发网站的反爬风控。
- 平台返回的"内容不存在""页面不见了"等提示不一定反映真实状态，也可能是访问方式的问题（如 URL 缺失必要参数、触发反爬）而非内容本身的问题。

### 视频内容获取

用户浏览器真实渲染，截图可捕获当前视频帧。核心能力：通过 `/eval` 操控 `<video>` 元素（获取时长、seek 到任意时间点、播放/暂停/全屏），配合 `/screenshot` 采帧，可对视频内容进行离散采样分析。

### 登录判断

用户日常浏览器天然携带登录态，大多数常用网站已登录。

登录判断的核心问题只有一个：**目标内容拿到了吗？**

打开页面后先尝试获取目标内容。只有当确认**目标内容无法获取**且判断登录能解决时，才告知用户：
> "当前页面在未登录状态下无法获取[具体内容]，请在你的浏览器中登录 [网站名]，完成后告诉我继续。"

登录完成后无需重启任何东西，直接刷新页面继续。

### 任务结束

用 `/close` 关闭自己创建的 tab，必须保留用户原有的 tab 不受影响。

Proxy 持续运行，不建议主动停止——重启后可能需要在浏览器中重新授权 CDP 连接。

## 并行调研：子 Agent 分治策略

任务包含多个**独立**调研目标时（如同时调研 N 个项目、N 个来源），鼓励合理分治给子 Agent 并行执行，而非主 Agent 串行处理。

**好处：**
- **速度**：多子 Agent 并行，总耗时约等于单个子任务时长
- **上下文保护**：抓取内容不进入主 Agent 上下文，主 Agent 只接收摘要，节省 token

**并行 CDP 操作**：每个子 Agent 在当前用户浏览器实例中，自行创建所需的后台 tab（`/new`），自行操作，任务结束自行关闭（`/close`）。所有子 Agent 共享一个用户浏览器、一个 Proxy，通过不同 targetId 操作不同 tab，无竞态风险。

**子 Agent Prompt 写法：目标导向，而非步骤指令**
- 必须在子 Agent prompt 中写 `必须加载 browser-cdp-enhancement skill 并遵循指引` ，子 Agent 会自动加载 skill，无需在 prompt 中复制 skill 内容或指定路径。
- 子 Agent 有自主判断能力。主 Agent 的职责是说清楚**要什么**，仅在必要与确信时限定**怎么做**。过度指定步骤会剥夺子 Agent 的判断空间，反而引入主 Agent 的假设错误。**避免 prompt 用词对子 Agent 行为的暗示**：「搜索xx」会把子 Agent 锚定到 WebSearch，而实际上有些反爬站点需要 CDP 直接访问主站才能有效获取内容。主 Agent 写 prompt 时应描述目标（「获取」「调研」「了解」），避免用暗示具体手段的动词（「搜索」「抓取」「爬取」）。

**分治判断标准：**

| 适合分治 | 不适合分治 |
|----------|-----------|
| 目标相互独立，结果互不依赖 | 目标有依赖关系，下一个需要上一个的结果 |
| 每个子任务量足够大（多页抓取、多轮搜索） | 简单单页查询，分治开销大于收益 |
| 需要 CDP 浏览器或长时间运行的任务 | 几次 WebSearch / Jina 就能完成的轻量查询 |

## 信息核实类任务

核实的目标是**一手来源**，而非更多的二手报道。多个媒体引用同一个错误会造成循环印证假象。

搜索引擎和聚合平台是信息发现入口，是**定位**信息的工具，不可用于直接**证明**真伪。找到来源后，直接访问读取原文。同一原则适用于工具能力/用法的调研——官方文档是一手来源，不确定时先查文档或源码，不猜测。

| 信息类型 | 一手来源 |
|----------|---------|
| 政策/法规 | 发布机构官网 |
| 企业公告 | 公司官方新闻页 |
| 学术声明 | 原始论文/机构官网 |
| 工具能力/用法 | 官方文档、源码 |

**找不到官网时**：权威媒体的原创报道（非转载）可作为次级依据，但需向用户说明："未找到官方原文，以下核实来自[媒体名]报道，存在转述误差可能。"单一来源时同样向用户声明。

## 站点经验

操作中积累的特定网站经验，按域名存储在 `references/site-experience/` 下。

确定目标网站后，如果前置检查输出的 site-experience 列表中有匹配的站点，必须读取对应文件获取先验知识（平台特征、有效模式、已知陷阱）。经验内容标注了发现日期，当作可能有效的提示而非保证——如果按经验操作失败，回退通用模式并更新经验文件。

CDP 操作成功完成后，如果发现了有必要记录经验的新站点或新模式（URL 结构、平台特征、操作策略），主动写入对应的站点经验文件。只写经过验证的事实，不写未确认的猜测。

文件格式：

```markdown
---
domain: example.com
aliases: [示例, Example]
updated: 2026-05-08
---
## 平台特征
架构、反爬行为、登录需求、内容加载方式等事实

## 有效模式
已验证的 URL 模式、操作策略、选择器

## 已知陷阱
什么会失败以及为什么
```
经验/陷阱内容标注发现日期，当作"可能有效的提示"而非"保证正确的事实"。

## References 索引

| 文件 | 何时加载 |
|------|---------|
| `references/shell-workflow.md` | 执行 curl/CDP/API 调用、JSON 处理、临时文件、URL 编解码或批量文本清洗前 |
| `references/web-to-markdown.md` | 需要用 Jina Reader、Cloudflare markdown.new 或本地 Python 将网页正文转 Markdown、减少 token 前 |
| `references/cdp-api.md` | 需要 CDP API 详细参考、JS 提取模式、错误处理时 |
| `references/site-experience/{domain}.md` | 确定目标网站后，读取对应站点经验 |

## Examples 索引

| 目录 | 展示内容 |
|------|---------|
| `examples/bilibili-kataya-jan-apr-2026-video-heat/` | 使用本地 Vivaldi + CDP 访问 B 站，按 AX Tree First 模式搜索作者、点击进入主页/投稿页、点击“下一页”翻页，提取 2026 年 1–4 月视频列表，按播放量生成 Markdown 排名，并保存过程记录、截图和浏览器配置快照 |
| `examples/brave-member-center-wechat-pay-console/` | 使用本地 Brave + CDP 访问本地会员中心开发页，点击支付方式切换，在弹出面板选择“微信支付”，再用 AX Tree 点击“立即开通”，保存 DevTools console 日志且不截图 |
