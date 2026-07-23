# repro-mobile-devtools

On-page DevTools for mobile browsers. A single vanilla JS file with zero dependencies — drop it into any page and get a full debugging panel on the device itself: console, network inspector, DOM elements, storage, and device info.

Built for debugging web apps on real phones where desktop DevTools can't reach: embedded WebViews, in-app browsers, customer devices, or quick reproduction of mobile-only bugs.

## Features

- **Console** — captures `console.log/info/warn/error/debug`, uncaught errors, and unhandled promise rejections. Expandable object previews, duplicate-log collapsing with counters, level filters, and a JS eval input to run code on the page.
- **Network** — intercepts `fetch` and `XMLHttpRequest`. Shows method, status, duration, request/response headers and bodies (JSON pretty-printed). Tap a row for full details. Export everything as a **HAR 1.2 file** for analysis in Chrome DevTools, Charles, or any HAR viewer.
- **Elements** — DOM tree with expand/collapse, plus a tap-to-inspect mode: hide the panel, tap any element on the page, and see its attributes, bounding rect, and key computed styles with an on-screen highlight.
- **Storage** — view localStorage, sessionStorage, and cookies. Delete individual keys or clear a store entirely.
- **Info** — user agent, viewport, screen size, device pixel ratio, connection type, touch points, language, online status, and more.
- **Floating button** — draggable, stays out of the way, shows a red badge counting warnings/errors that happened while the panel was closed.
- **Safe by construction** — all captured content is rendered with `textContent` (no XSS from logged strings, URLs, or response bodies). Nothing is ever sent off the device.

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

Save this as a bookmark on your phone, tap it on any page:

```
javascript:(function(){var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/adityatiwari1998w-bot/repro-mobile-debugging@main/mobile-devtool.min.js';document.body.appendChild(s)})()
```

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
```

Re-injecting the script after `destroy()` is safe — patches are fully unwound, so nothing double-wraps.

## Panel guide

| Panel | How to use |
|---|---|
| Console | Chips filter by level. Tap orange object previews to expand full JSON. Repeated identical lines collapse with a counter. Type JS in the bottom input and hit Run — results (including awaited promises) print inline. |
| Network | Row shows method, path, status (green = ok, red = failed, `…` = pending) and duration. Tap a row to expand general info, request/response headers and bodies. "⬇ HAR" downloads all captured requests as a `.har` file — open it in Chrome DevTools (Network tab → import) or any HAR viewer. |
| Elements | Tap `▸` arrows to expand the tree. Tap a node label to see details below. Tap "⊕ Select element" to hide the panel and pick an element by tapping the page; tapping the floating button cancels picking. "↻ Refresh tree" re-reads the DOM. |
| Storage | Each store lists key/value rows; `✕` deletes a key, "clear all" empties the store. Long values are truncated with a character count. |
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

- Keeps the last **500 logs** and **200 requests**; request/response bodies truncated at **20 KB**; object serialization capped at depth 6 and 100 items/keys per level (shown as `… N more`).
- Response bodies are read only for text-like content types (JSON, text, XML, HTML, urlencoded); binary shows as `[content-type]`.
- Not captured: WebSocket frames, `navigator.sendBeacon`, service-worker internal fetches, requests made before the script loads.
- Requires pointer-events support (iOS 13+, all modern Android). The floating button won't respond on very old browsers.
- The eval input can be covered by the on-screen keyboard on some iOS versions — scroll the panel if needed.

## License

MIT
