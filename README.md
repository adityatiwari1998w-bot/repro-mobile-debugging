# repro-mobile-devtools

On-page DevTools for mobile browsers. A single vanilla JS file with zero dependencies — drop it into any page and get a full debugging panel on the device itself: console, network inspector, DOM elements, storage, and device info.

Built for debugging web apps on real phones where desktop DevTools can't reach: embedded WebViews, in-app browsers, customer devices, or quick reproduction of mobile-only bugs.

## Features

- **Console** — captures `console.log/info/warn/error/debug/time/group/table`, uncaught errors, and unhandled promise rejections. Expandable object previews, duplicate-log collapsing, level filters, **text search**, a JS eval input, **export as .txt/.json**, and **share via the system share sheet**. A small tail of logs (40 entries) **survives page reloads** so crash-on-load bugs stay visible.
- **Network** — intercepts `fetch`, `XMLHttpRequest`, and **WebSocket** (frames shown per socket). Method, status, duration, headers, bodies (JSON pretty-printed), **URL search filter**, and a **throttle/block rule** — delay or fail requests matching a URL substring to test error handling. Export everything as a **HAR 1.2 file**.
- **Elements** — DOM tree with expand/collapse, plus a tap-to-inspect mode: hide the panel, tap any element on the page, and see its attributes, bounding rect, and key computed styles with an on-screen highlight.
- **Storage** — view localStorage, sessionStorage, and cookies. **Tap a value to edit it**, delete individual keys, or clear a store entirely.
- **Perf** — live **FPS meter** (runs only while the tab is visible), page-load waterfall (DNS/TCP/TTFB/download/DOMContentLoaded/load), first contentful paint, resource count and transfer size, JS heap (Chrome), and **long-task detection**.
- **Info** — user agent, viewport, screen size, device pixel ratio, connection type, touch points, language, online status, and more.
- **Repro bundle export** — "⬇ Repro bundle" downloads a `repro-bundle-*.zip` that imports directly into the **repro debug-extension** via "Import a capture". Includes console, network, env, **user actions** (clicks with element selectors, inputs with password masking, key combos, SPA navigations), **storage snapshots** (start/end localStorage/sessionStorage/cookies, so the report can diff them), and **perf events** (TTFB/FCP/LCP/CLS/load vitals + long tasks) — plus `summary.md` and `network.har`.
- **UI** — draggable floating button with error badge (position remembered), drag the panel header to resize, light/dark theme toggle.
- **Safe by construction** — all captured content is rendered with `textContent` (no XSS from logged strings, URLs, or response bodies). Nothing is ever sent off the device.
- **Mobile-friendly memory budget** — hard caps everywhere: 2000 logs / 500 requests in memory, 200 frames per socket, 5 MB per-body safety ceiling; persisted state is ≤ ~50 KB of sessionStorage (cleared when the tab closes) plus a <100-byte prefs blob. Observers and the FPS loop only run while visible.

## Install

```bash
npm install repro-mobile-devtools
```

Or via CDN:

```html
<script src="https://cdn.jsdelivr.net/gh/adityatiwari1998w-bot/repro-mobile-debugging@main/mobile-devtool.min.js"></script>
<!-- or, once published to npm -->
<script src="https://unpkg.com/repro-mobile-devtools"></script>
```

Or just copy `mobile-devtool.js` (readable) / `mobile-devtool.min.js` (26 KB) into your project.

## Quick start

Add as the **first** script in `<head>` so interception starts before your app code runs — anything logged or fetched before the script loads is not captured:

```html
<script src="https://cdn.jsdelivr.net/gh/adityatiwari1998w-bot/repro-mobile-debugging@main/mobile-devtool.min.js"></script>
```

A floating `>_` button appears bottom-right. Tap it to open the panel; drag it to reposition.

## Usage in real apps

### Your own web app (gate it — never ship to production)

Plain HTML:

```html
<script>
  // enable with ?debug=1 once, then it sticks for the session
  if (location.search.includes('debug=1')) sessionStorage.__dbg = 1;
  if (sessionStorage.__dbg) document.write('<script src="https://cdn.jsdelivr.net/gh/adityatiwari1998w-bot/repro-mobile-debugging@main/mobile-devtool.min.js"><\/script>');
</script>
```

Bundled app (Vite/webpack — React, Vue, etc.), top of your entry file:

```js
if (import.meta.env.DEV || location.search.includes('debug=1')) {
  import('repro-mobile-devtools');
}
```

### Sites you don't own — bookmarklet

A bookmarklet is a bookmark whose URL is JavaScript instead of a web address. Tapping it runs the code on the current page — injecting the devtool into any site you're viewing, including ones you can't edit.

The code (must stay on one single line, `javascript:` prefix intact):

```
javascript:(function(){var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/adityatiwari1998w-bot/repro-mobile-debugging@main/mobile-devtool.min.js';document.body.appendChild(s)})()
```

**iPhone (Safari):**

1. Bookmark any page (Share → Add Bookmark), name it "DevTools"
2. Copy the `javascript:...` line above
3. Bookmarks → Edit → tap "DevTools" → replace the URL field with the pasted code → Save

**Android (Chrome):**

1. Star any page to bookmark it, name it "DevTools"
2. Menu → Bookmarks → long-press it → Edit → replace the URL with the pasted code → Save
3. To run it: type "DevTools" in the address bar and tap the bookmark suggestion (tapping it from the bookmarks list won't execute JS)

**Easier:** edit the bookmark on your desktop browser with sync enabled (Chrome or Safari/iCloud) — it syncs to your phone automatically, no mobile typing.

**Usage:** open the target site, tap the bookmarklet, then reproduce the bug — logs/requests from *before* the tap aren't captured. Won't work on sites whose CSP blocks external scripts, or on browser-internal pages. If pasting strips the `javascript:` prefix, retype it manually.

### Persistent across reloads — userscript

A bookmarklet dies on page reload (nothing re-runs it). For persistence, install `mobile-devtool.user.js` in a userscript manager — it injects the devtool on **every page load** until you toggle it off:

- **Android:** Chrome doesn't support extensions — use a browser that does, e.g. Kiwi or Firefox, and install **Tampermonkey**, then open the raw `mobile-devtool.user.js` URL to install.
- **iOS:** install the **Userscripts** app from the App Store, enable it in Safari extensions, and add the file.
- Edit the `@match` rule to limit it to the domains you're debugging (recommended — by default it runs everywhere except google.com).

For your own app, the `?debug=1` + sessionStorage snippet in "Usage in real apps" achieves the same thing without any extension.

### Removing / detaching

- **✕** in the panel header minimizes to the floating button.
- **⏻** in the panel header fully removes the devtool and restores all patched APIs (`console`, `fetch`, XHR, WebSocket) — same as running `mobileDevtool.destroy()`.
- A page reload also clears a bookmarklet injection.
- One-tap removal bookmarklet: `javascript:window.mobileDevtool&&mobileDevtool.destroy()`

### Native app WebViews

Inject at document start so early logs/requests are captured:

- **Android:** `webView.evaluateJavascript(jsFileContents, null)` after page load starts, or serve the file and inject a script tag.
- **iOS:** add a `WKUserScript` with the file contents, `injectionTime: .atDocumentStart`.

## API

```js
mobileDevtool.show();     // open the panel
mobileDevtool.hide();     // close the panel
mobileDevtool.destroy();  // remove the UI and restore console/fetch/XHR patches
mobileDevtool.getHAR();   // returns captured requests as a HAR 1.2 object
mobileDevtool.exportHAR();// downloads captured requests as a .har file
mobileDevtool.getLogs();  // returns console logs as an array of objects
mobileDevtool.exportLogs('txt' | 'json'); // downloads console logs
mobileDevtool.shareLogs();// system share sheet (falls back to download)
mobileDevtool.getBundle();   // returns { session, events, ... } (repro capture format)
mobileDevtool.exportBundle();// downloads repro-bundle-*.zip for the repro extension
```

Re-injecting the script after `destroy()` is safe — patches are fully unwound, so nothing double-wraps.

## Panel guide

| Panel | How to use |
|---|---|
| Console | Chips filter by level. Tap orange object previews to expand full JSON. Repeated identical lines collapse with a counter. Type JS in the bottom input and hit Run — results (including awaited promises) print inline. |
| Network | Row shows method, path, status (green = ok, red = failed, `…` = pending) and duration. Tap a row to expand general info, request/response headers and bodies. "⬇ HAR" downloads a `.har` file for Chrome DevTools or any HAR viewer. "⬇ Repro bundle" downloads a repro capture zip — in the repro extension choose **Import a capture** and pick the file to replay the session (console + network + device info). |
| Elements | Tap `▸` arrows to expand the tree. Tap a node label to see details below. Tap "⊕ Select element" to hide the panel and pick an element by tapping the page; tapping the floating button cancels picking. "↻ Refresh tree" re-reads the DOM. |
| Storage | Each store lists key/value rows; tap a dotted-underlined value to edit it, `✕` deletes a key, "clear all" empties the store. Long values are truncated with a character count. |
| Perf | FPS updates live while the tab is open. "Long tasks" counts main-thread blocks >50ms — the usual cause of jank. JS heap needs Chrome. |
| Info | Read-only device/page facts. Values refresh each time you open the tab. |

## Demo

Open `demo.html` on a phone — its buttons exercise every panel:

```bash
npx serve .
# open the printed URL on your phone (same Wi-Fi) → /demo.html
```

## Development

```bash
npm install          # dev dependency: terser
npm run build        # produces mobile-devtool.min.js
npm publish          # runs build automatically via prepublishOnly
```

The source is a single IIFE in `mobile-devtool.js` — console/network interception is installed immediately at parse time; the UI (in a shadow root, styles fully isolated) builds on `DOMContentLoaded`.

## Security notes

- The eval input runs arbitrary JS in the page — same power as browser DevTools, but it means you should **never load this script for end users in production**. Gate it behind a debug flag.
- The Storage and Network panels display cookies, tokens, and response bodies on-screen. Everything stays in memory on the device; nothing is transmitted anywhere.
- Pages with a strict Content-Security-Policy may block the script itself (`script-src`) or the eval input (`unsafe-eval`). Eval failures degrade gracefully into a console error.

## Limits

- Keeps the last **2000 logs** and **500 requests**; request/response bodies stored **in full** (5 MB per-body safety ceiling); WebSocket frames capped at 200 per socket / 2000 chars each; object serialization capped at depth 8 and 500 items/keys per level (shown as `… N more`).
- Response bodies are read only for text-like content types (JSON, text, XML, HTML, urlencoded); binary shows as `[content-type]`.
- Not captured: `navigator.sendBeacon`, service-worker internal fetches, requests made before the script loads.
- The throttle/block rule applies one URL-substring pattern at a time; XHR blocking fires synthetic `error`/`loadend` events (readyState doesn't reach 4).
- Requires pointer-events support (iOS 13+, all modern Android). The floating button won't respond on very old browsers.
- The eval input can be covered by the on-screen keyboard on some iOS versions — scroll the panel if needed.

## License

MIT
