# repro-mobile-devtools

Eruda-like on-page DevTools for mobile browsers. Single vanilla JS file, zero dependencies.

## Install

```bash
npm install repro-mobile-devtools
```

Or via CDN (after publishing):

```html
<script src="https://unpkg.com/repro-mobile-devtools"></script>
<!-- or -->
<script src="https://cdn.jsdelivr.net/npm/repro-mobile-devtools"></script>
```

## Usage

Add as the **first** script in `<head>` so it intercepts console/network calls before your app runs:

```html
<script src="mobile-devtool.js"></script>
```

In a bundled app, load it only for debugging:

```js
if (import.meta.env.DEV || location.search.includes('debug=1')) {
  import('repro-mobile-devtools');
}
```

A floating button appears (draggable). Tap it to open the panel.

## Panels

- **Console** — captures `console.log/info/warn/error/debug`, uncaught errors, unhandled promise rejections. Tap object previews to expand full JSON. Duplicate lines collapse with a counter. Filter chips + JS eval input at the bottom.
- **Network** — captures `fetch` and `XMLHttpRequest`: method, status, duration, headers, request/response bodies (JSON pretty-printed). Tap a row for details.
- **Elements** — DOM tree with expand/collapse. "⊕ Select element" hides the panel and lets you tap any element on the page; shows attributes, rect, and key computed styles with an on-screen highlight.
- **Storage** — localStorage, sessionStorage, cookies. Delete individual keys or clear all.
- **Info** — UA, viewport, screen, pixel ratio, connection, touch points, etc.

Warnings/errors that occur while the panel is closed show a red badge on the button.

## API

```js
mobileDevtool.show();
mobileDevtool.hide();
mobileDevtool.destroy();
```

## Demo

Open `demo.html` on your phone (or serve the folder: `npx serve .`) and tap the buttons to exercise every panel.

## Limits

- Keeps last 500 logs / 200 requests; bodies truncated at 20 KB.
- Response bodies read only for text-ish content types; binary shown as `[type]`.
- WebSocket and sendBeacon traffic not captured (yet).
