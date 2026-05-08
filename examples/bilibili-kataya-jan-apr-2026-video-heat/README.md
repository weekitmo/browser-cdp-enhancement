# Example: Bilibili Kataya Jan–Apr 2026 Video Heat

This example demonstrates an AX-first browser research flow with `browser-cdp-enhancement`:

1. Launch and verify the local Vivaldi browser through the CDP proxy.
2. Visit Bilibili, search for `卡特亚`, and use Accessibility Tree (`/ax`) to find the author result.
3. Click the author and upload-page entries with `/clickAX` instead of DOM selectors.
4. Use Accessibility Tree to locate and click the `下一页` pagination button, covering a real pagination interaction.
5. Extract January–April 2026 video cards from the first two upload pages.
6. Normalize Bilibili view-count text such as `213.8万` into sortable numbers.
7. Produce a Markdown Top 10 ranking by play count.
8. Save the execution process, final-page screenshot, raw data, and browser config snapshot.

## Files

| File | Purpose |
|------|---------|
| `process.md` | Step-by-step AX-first execution record, including CDP commands and observations. |
| `game-heat-ranking.md` | Final Top 10 game heat ranking in Markdown. |
| `jan-apr-2026-videos.json` | Full extracted January–April 2026 sample used for sorting and verification. |
| `final-page.png` | Screenshot of the final Bilibili author upload page after clicking `下一页`. |
| `.cdp-browser.json` | Vivaldi browser selection/config snapshot used for the run. |

## Reproduction note

Bilibili play counts change over time. The ranking in this example reflects the page state observed on 2026-05-08 from the local Vivaldi browser session.
