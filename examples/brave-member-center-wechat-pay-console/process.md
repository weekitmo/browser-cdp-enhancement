# Process: Brave Member Center WeChat Pay Console Logs

## Task

Use the local Brave browser to visit the local development page:

```text
http://localhost:9051/web/member-center/#/
```

Then switch the payment method, choose `微信支付`, click `立即开通`, and capture DevTools console logs. No screenshot should be taken.

## Environment

- Date: 2026-05-08
- Browser: Brave Browser
- CDP browser port: `9222`
- CDP proxy: `http://localhost:4567`
- Page target: `053DA04DE0D9D579557000CBA3DD0135`
- Output directory: `examples/brave-member-center-wechat-pay-console/`

## Steps

### 1. Verify and switch to Brave CDP

Checked the CDP tooling:

```bash
node scripts/check-deps.mjs
```

Observed:

```text
node: ok (v22.22.0)
chrome: ok (port 9222)
proxy: ready
```

Because the task explicitly required Brave, verified the actual listener with `lsof` and `/json/version`, then launched Brave on port `9222`:

```bash
open -na 'Brave Browser' --args --remote-debugging-port=9222 '--remote-allow-origins=*'
lsof -nP -iTCP:9222 -sTCP:LISTEN
curl -s http://localhost:9222/json/version
```

Decisive evidence:

```text
Brave Browser is listening on 127.0.0.1:9222
```

`browser-listener.txt` stores a redacted `lsof` note, and `browser-version.json` stores the full `/json/version` response.

### 2. Open the member-center page and enable console capture

Opened a new CDP tab:

```bash
curl -s "http://localhost:4567/new?url=http://localhost:9051/web/member-center/%23/"
```

Result:

```json
{ "targetId": "053DA04DE0D9D579557000CBA3DD0135" }
```

Enabled and cleared console capture before the interaction:

```bash
curl -s "http://localhost:4567/console/enable?target=053DA04DE0D9D579557000CBA3DD0135"
curl -s "http://localhost:4567/console/clear?target=053DA04DE0D9D579557000CBA3DD0135"
```

Confirmed the page loaded:

```json
{
  "title": "会员中心",
  "url": "http://localhost:9051/web/member-center/#/",
  "ready": "complete"
}
```

### 3. Click payment-method switcher

AX Tree did not expose the payment-method switcher with a useful accessible name, so this step used a real mouse click through `/clickAt` with a CSS selector fallback:

```bash
curl -s -X POST "http://localhost:4567/clickAt?target=053DA04DE0D9D579557000CBA3DD0135" \
  -d '.pay-method-selector'
```

Observed click result:

```json
{
  "clicked": true,
  "tag": "DIV",
  "text": "支付宝支付 点击切换 "
}
```

After the click, the page text included the payment selection panel:

```text
取消
选择支付方式
支付宝支付
微信支付
```

### 4. Choose WeChat pay

Clicked the second method box in the bottom sheet:

```bash
curl -s -X POST "http://localhost:4567/clickAt?target=053DA04DE0D9D579557000CBA3DD0135" \
  -d '.selection-popup .method-box:nth-of-type(2)'
```

Observed click result:

```json
{
  "clicked": true,
  "tag": "DIV",
  "text": "微信支付"
}
```

Final page text then showed:

```text
微信支付
点击切换
立即开通
```

### 5. Click `立即开通` with AX Tree

After the payment method was selected, AX Tree exposed the button with accessible name `立即开通`, so the final action used `/clickAX`:

```bash
curl -s -X POST "http://localhost:4567/clickAX?target=053DA04DE0D9D579557000CBA3DD0135" \
  -d '{"role":"button","name":"立即开通","exact":true}'
```

Observed click result:

```json
{
  "clicked": true,
  "node": {
    "role": "button",
    "name": "立即开通"
  },
  "matchCount": 1
}
```

### 6. Capture console logs

Fetched DevTools console entries:

```bash
curl -s "http://localhost:4567/console?target=053DA04DE0D9D579557000CBA3DD0135" > console-log.json
```

Saved sanitized output to `console-log.json`. Summary:

- `count`: 5
- `error`: 3 entries from `chrome-extension://[extension-id-redacted]/content-scripts/host.js`, triggered through Vant touch emulator.
- `warning`: 1 entry, `[native] sendSensorsLog unsupported Object`, from the local member-center primary-action code path.
- `log`: 1 entry, `🍍 "pay" store installed 🆕`.

## Result

The requested Brave browser flow completed, and DevTools console logs were saved in this example directory. No screenshot was captured.
