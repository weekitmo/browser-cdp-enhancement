# Process: Bilibili “卡特亚” 2026 年 1–4 月视频热度

## Task

Use the local Vivaldi browser to visit Bilibili, search `卡特亚`, enter the author homepage, collect videos published from January through April 2026, sort by play count descending, and output a Top 10 game heat ranking.

This rerun intentionally follows an **AX-first** interaction strategy:

- Use `/ax` to locate visible links/buttons by role and accessible name.
- Use `/clickAX` for author entry, upload tab, and pagination.
- Use `/eval` only for bulk data extraction from loaded video cards, not for finding clickable controls.

## Environment

- Date: 2026-05-08
- Browser: Vivaldi
- CDP proxy: `http://localhost:4567`
- Search page: `https://search.bilibili.com/all?keyword=%E5%8D%A1%E7%89%B9%E4%BA%9A`
- Author homepage: `https://space.bilibili.com/43222001`
- Author upload page: `https://space.bilibili.com/43222001/upload/video`
- Output directory: `examples/bilibili-kataya-jan-apr-2026-video-heat/`

## Steps

### 1. Verify Vivaldi CDP connection

Ran:

```bash
node scripts/check-deps.mjs --launch Vivaldi
curl -s http://localhost:4567/health
curl -s http://localhost:4567/targets
```

Observed:

- Vivaldi launched with `--remote-debugging-port=9222`.
- `.cdp-browser.json` recorded `browser: Vivaldi`.
- `/health` returned `connected: true`.
- `/targets` returned Vivaldi tabs.

### 2. Search Bilibili and locate the author with AX Tree

Opened the Bilibili search page for `卡特亚`. Then queried AX Tree for link nodes containing `卡特亚`:

```bash
curl -s "http://localhost:4567/ax?target=SEARCH_TARGET&role=link&name=%E5%8D%A1%E7%89%B9%E4%BA%9A"
```

Relevant AX result:

```json
{
  "role": "link",
  "name": "卡特亚",
  "properties": {
    "url": "https://space.bilibili.com/43222001?spm_id_from=333.337.0.0"
  }
}
```

Clicked the exact author link via AX:

```bash
curl -s -X POST "http://localhost:4567/clickAX?target=SEARCH_TARGET" \
  -d '{"role":"link","name":"卡特亚","exact":true}'
```

Observed click evidence:

```json
{
  "clicked": true,
  "node": { "role": "link", "name": "卡特亚" },
  "matchCount": 1
}
```

The click opened the author homepage in a browser tab:

```text
https://space.bilibili.com/43222001?spm_id_from=333.337.0.0
```

### 3. Enter the upload page with AX Tree

On the author homepage, queried AX nodes for `投稿`:

```bash
curl -s "http://localhost:4567/ax?target=AUTHOR_TARGET&name=%E6%8A%95%E7%A8%BF"
```

Relevant AX result:

```json
{
  "role": "link",
  "name": "投稿 999+",
  "properties": {
    "url": "https://space.bilibili.com/43222001/upload"
  }
}
```

Clicked the upload entry with AX:

```bash
curl -s -X POST "http://localhost:4567/clickAX?target=AUTHOR_TARGET" \
  -d '{"name":"投稿"}'
```

The page reached:

```text
https://space.bilibili.com/43222001/upload/video
```

Visible page evidence:

- Author: `卡特亚`
- Section: `TA的视频`
- Upload card list is visible.

### 4. Extract page 1 data with structured DOM reading

For bulk card data, used `/eval` after the page was already reached through AX interactions. This is intentional: video cards are data records, not a single visible control to click.

Extraction pattern:

```js
[...document.querySelectorAll('.upload-video-card')].map(card => {
  const link = card.querySelector('a[href*="/video/BV"]');
  const lines = card.innerText.trim().split('\n').map(s => s.trim()).filter(Boolean);
  return { href: link?.href?.split('?')[0], lines };
})
```

Each card generally exposed:

```text
播放量
弹幕数
时长
标题
发布日期
```

Page 1 covered recent videos down to `2026-02-16`, including April and March 2026 records.

### 5. Click pagination with AX Tree

After scrolling to reveal pagination, queried AX Tree for the `下一页` button:

```bash
curl -s "http://localhost:4567/ax?target=AUTHOR_TARGET&role=button&name=%E4%B8%8B%E4%B8%80%E9%A1%B5&exact=1"
```

AX result:

```json
{
  "role": "button",
  "name": "下一页",
  "properties": {
    "focusable": true
  }
}
```

Clicked the pagination button with AX:

```bash
curl -s -X POST "http://localhost:4567/clickAX?target=AUTHOR_TARGET" \
  -d '{"role":"button","name":"下一页","exact":true}'
```

Observed click evidence:

```json
{
  "clicked": true,
  "node": { "role": "button", "name": "下一页" },
  "matchCount": 1
}
```

Page 2 loaded additional cards covering `2026-02-15` through `2026-01-02`, then older 2025 videos.

### 6. Filter January–April 2026 and sort by play count

Filtering rule:

- Keep cards dated from `2026-01-01` through `2026-04-30`.
- Bilibili displays current-year dates as `MM-DD`; because the run happened on 2026-05-08, these were recorded as `2026-MM-DD`.
- Convert `万` view counts to numbers for sorting, while preserving the original display text.

Extracted sample size:

```text
61 videos from 2026-01-02 through 2026-04-30
```

Raw extracted sample:

```text
jan-apr-2026-videos.json
```

Final ranking:

```text
game-heat-ranking.md
```

### 7. Save final artifacts

Captured the final page after the AX pagination click:

```bash
curl -s "http://localhost:4567/screenshot?target=AUTHOR_TARGET&file=$(pwd)/examples/bilibili-kataya-jan-apr-2026-video-heat/final-page.png"
```

Copied the browser config snapshot:

```bash
cp .cdp-browser.json examples/bilibili-kataya-jan-apr-2026-video-heat/.cdp-browser.json
```

## Result

Top 10 ranking output:

```text
examples/bilibili-kataya-jan-apr-2026-video-heat/game-heat-ranking.md
```

Supporting artifacts:

```text
examples/bilibili-kataya-jan-apr-2026-video-heat/jan-apr-2026-videos.json
examples/bilibili-kataya-jan-apr-2026-video-heat/final-page.png
examples/bilibili-kataya-jan-apr-2026-video-heat/.cdp-browser.json
```
