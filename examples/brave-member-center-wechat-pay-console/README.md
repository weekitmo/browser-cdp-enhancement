# Example: Brave Member Center WeChat Pay Console Logs

This example demonstrates using `browser-cdp-enhancement` with the local Brave browser to operate a local member-center development page and capture DevTools console output.

## Scenario

1. Use Brave with CDP proxy.
2. Visit `http://localhost:9051/web/member-center/#/`.
3. Click the payment-method switcher.
4. In the bottom sheet, choose `微信支付`.
5. Click the bottom `立即开通` button.
6. Save DevTools console logs.

No screenshot is included because the task explicitly requested no screenshot.

## Files

| File | Purpose |
|------|---------|
| `process.md` | Step-by-step operation record and decisive evidence. |
| `console-log.json` | Sanitized DevTools console entries captured after clicking `立即开通`. |
| `browser-listener.txt` | `lsof` evidence showing Brave listening on CDP port `9222`. |
| `browser-version.json` | Browser `/json/version` response for the Brave CDP session. |
| `page-state.json` | Final observed task state summary. |
| `.cdp-browser.json` | Brave browser launch/config snapshot used for this run. |

## Reproduction note

The console log reflects the local development state observed on 2026-05-08 from the Brave browser session.
