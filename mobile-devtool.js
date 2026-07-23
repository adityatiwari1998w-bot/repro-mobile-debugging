/*!
 * mobile-devtool.js — on-page DevTools for mobile browsers.
 * Zero dependencies. Drop in via <script src="mobile-devtool.js"></script>
 * as early as possible (ideally first script in <head>) so console/network
 * interception starts before your app code runs.
 *
 * API: window.mobileDevtool.show() / .hide() / .destroy()
 */
(function () {
  'use strict';
  if (window.__MOBILE_DEVTOOL__) return;
  window.__MOBILE_DEVTOOL__ = true;

  var MAX_LOGS = 2000;
  var MAX_NET = 500;
  var MAX_BODY = 5242880;   // req/resp bodies kept in full up to 5 MB (safety ceiling only)
  var MAX_WS_FRAMES = 200;  // frames kept per websocket
  var MAX_WS_FRAME = 2000;  // chars per frame
  var MAX_PERSIST = 100;    // logs persisted across reloads (≈ <50 KB sessionStorage)
  var PERSIST_KEY = '__mdt_logs';
  var UI_KEY = '__mdt_ui';  // tiny prefs blob (<100 bytes)

  var state = {
    logs: [],        // {level, parts:[{text,type}], time, stack, count, indent}
    net: [],         // {id, method, url, status, ok, duration, start, reqBody, respBody, reqHeaders, respHeaders, type, error, frames?}
    netId: 0,
    filter: 'all',
    searchLog: '',
    searchNet: '',
    netRule: { pattern: '', mode: 'off' }, // off | delay | block
    groupDepth: 0,
    timers: {},
    tab: 'console',
    open: false,
    light: false,
    errBadge: 0,
    ui: null
  };

  /* ================= utilities ================= */

  function now() { return Date.now(); }

  function timeStr(t) {
    var d = new Date(t);
    function p(n, l) { n = String(n); while (n.length < (l || 2)) n = '0' + n; return n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
  }

  function safeStringify(obj, maxDepth) {
    var seen = [];
    function walk(v, depth) {
      if (v === null || typeof v !== 'object') return v;
      if (seen.indexOf(v) !== -1) return '[Circular]';
      if (depth > maxDepth) return (Array.isArray(v) ? '[Array]' : '[Object]');
      seen.push(v);
      var out;
      var MAX_ITEMS = 500; // breadth cap so huge structures can't freeze the page
      if (Array.isArray(v)) {
        out = v.slice(0, MAX_ITEMS).map(function (x) { return walk(x, depth + 1); });
        if (v.length > MAX_ITEMS) out.push('… ' + (v.length - MAX_ITEMS) + ' more items');
      } else if (v instanceof Error) {
        out = { name: v.name, message: v.message, stack: v.stack };
      } else if (typeof Node !== 'undefined' && v instanceof Node) {
        out = '<' + (v.nodeName || '').toLowerCase() + '>';
      } else {
        out = {};
        try {
          var keys = Object.keys(v);
          keys.slice(0, MAX_ITEMS).forEach(function (k) {
            try { out[k] = walk(v[k], depth + 1); } catch (e) { out[k] = '[unreadable]'; }
          });
          if (keys.length > MAX_ITEMS) out['…'] = (keys.length - MAX_ITEMS) + ' more keys';
        } catch (e) { out = String(v); }
      }
      seen.pop();
      return out;
    }
    try { return JSON.stringify(walk(obj, 0), null, 2); }
    catch (e) { try { return String(obj); } catch (e2) { return '[unserializable]'; } }
  }

  function preview(v) {
    var t = typeof v;
    if (v === null) return { text: 'null', type: 'null' };
    if (t === 'undefined') return { text: 'undefined', type: 'null' };
    if (t === 'number' || t === 'boolean' || t === 'bigint') return { text: String(v), type: 'num' };
    if (t === 'string') return { text: v, type: 'str' };
    if (t === 'function') {
      var name = v.name ? v.name : 'anonymous';
      return { text: 'ƒ ' + name + '()', type: 'fn' };
    }
    if (t === 'symbol') return { text: v.toString(), type: 'fn' };
    if (v instanceof Error) return { text: (v.stack || (v.name + ': ' + v.message)), type: 'err' };
    if (v.__mdtTable) return { text: '⊞ table', type: 'obj', full: v.__mdtTable };
    if (typeof Node !== 'undefined' && v instanceof Node) {
      var s = '<' + (v.nodeName || '').toLowerCase();
      if (v.id) s += ' id="' + v.id + '"';
      if (v.className && typeof v.className === 'string') s += ' class="' + v.className + '"';
      return { text: s + '>', type: 'obj', full: (v.outerHTML || '').slice(0, MAX_BODY) };
    }
    // object / array — one-line preview, expandable full JSON
    var full = safeStringify(v, 8);
    var line;
    try {
      if (Array.isArray(v)) {
        line = 'Array(' + v.length + ') ' + full.replace(/\s+/g, ' ');
      } else {
        var ctor = (v.constructor && v.constructor.name && v.constructor.name !== 'Object') ? v.constructor.name + ' ' : '';
        line = ctor + full.replace(/\s+/g, ' ');
      }
      if (line.length > 120) line = line.slice(0, 120) + '…';
    } catch (e) { line = '[object]'; }
    return { text: line, type: 'obj', full: full };
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function throttle(fn, ms) {
    var t = 0, timer = null;
    return function () {
      var self = this, args = arguments, dt = now() - t;
      if (dt >= ms) { t = now(); fn.apply(self, args); }
      else if (!timer) {
        timer = setTimeout(function () { timer = null; t = now(); fn.apply(self, args); }, ms - dt);
      }
    };
  }

  /* ================= console capture (immediate) ================= */

  var orig = {};
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (m) {
    orig[m] = console[m] ? console[m].bind(console) : null;
  });

  function pushLog(level, args, stack) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      try { parts.push(preview(args[i])); }
      catch (e) { parts.push({ text: '[unrenderable value]', type: 'null' }); }
    }
    var last = state.logs[state.logs.length - 1];
    // collapse identical consecutive logs
    if (last && last.level === level && last.key === partsKey(parts)) {
      last.count++;
      last.time = now();
      renderLogUpdate(last);
      return;
    }
    var entry = { level: level, parts: parts, time: now(), stack: stack || null, count: 1, key: partsKey(parts), indent: state.groupDepth };
    state.logs.push(entry);
    if (state.logs.length > MAX_LOGS) state.logs.shift();
    persistLogs();
    if ((level === 'error' || level === 'warn') && !(state.open && state.tab === 'console')) {
      state.errBadge++;
      renderBadge();
    }
    renderLogAppend(entry);
  }

  function partsKey(parts) {
    return parts.map(function (p) { return p.type + ':' + p.text + (p.full ? '#' + p.full.length : ''); }).join('|');
  }

  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (m) {
    console[m] = function () {
      var args = Array.prototype.slice.call(arguments);
      try { pushLog(m, args); } catch (e) { /* never break the page */ }
      if (orig[m]) orig[m].apply(null, args);
    };
  });

  /* console.time / group / table */
  var origTime = console.time && console.time.bind(console);
  var origTimeEnd = console.timeEnd && console.timeEnd.bind(console);
  var origGroup = console.group && console.group.bind(console);
  var origGroupEnd = console.groupEnd && console.groupEnd.bind(console);

  console.time = function (label) {
    state.timers[label || 'default'] = now();
    if (origTime) origTime(label);
  };
  console.timeEnd = function (label) {
    label = label || 'default';
    if (state.timers[label] != null) {
      pushLog('log', [label + ': ' + (now() - state.timers[label]) + 'ms']);
      delete state.timers[label];
    }
    if (origTimeEnd) origTimeEnd(label);
  };
  console.group = function () {
    var args = Array.prototype.slice.call(arguments);
    pushLog('log', args.length ? ['▾'].concat(args) : ['▾ group']);
    state.groupDepth = Math.min(state.groupDepth + 1, 6);
    if (origGroup) origGroup.apply(null, args);
  };
  console.groupEnd = function () {
    state.groupDepth = Math.max(state.groupDepth - 1, 0);
    if (origGroupEnd) origGroupEnd();
  };
  console.table = function (data, cols) {
    try { pushLog('log', [{ __mdtTable: textTable(data, cols) }]); }
    catch (e) { pushLog('log', [data]); }
    if (orig.table) orig.table(data, cols);
  };

  function textTable(data, cols) {
    var rows = Array.isArray(data) ? data : Object.keys(data || {}).map(function (k) { return data[k]; });
    rows = rows.slice(0, 200); // memory cap
    var keys = cols;
    if (!keys) {
      keys = [];
      rows.forEach(function (r) {
        if (r && typeof r === 'object') Object.keys(r).forEach(function (k) { if (keys.indexOf(k) === -1 && keys.length < 12) keys.push(k); });
      });
    }
    if (!keys.length) keys = ['value'];
    var table = [keys.slice()];
    rows.forEach(function (r, i) {
      table.push(keys.map(function (k) {
        var v = (r && typeof r === 'object') ? r[k] : (k === 'value' ? r : undefined);
        v = v === undefined ? '' : (typeof v === 'object' ? safeStringify(v, 1).replace(/\s+/g, ' ') : String(v));
        return v.slice(0, 30);
      }));
    });
    var widths = keys.map(function (_, c) {
      return Math.max.apply(null, table.map(function (row) { return row[c].length; }));
    });
    return table.map(function (row, i) {
      var line = row.map(function (cell, c) { return cell + new Array(widths[c] - cell.length + 1).join(' '); }).join(' │ ');
      return i === 1 ? widths.map(function (w) { return new Array(w + 1).join('─'); }).join('─┼─') + '\n' + line : line;
    }).join('\n');
  }

  /* persist a compact tail of logs across reloads (sessionStorage, hard-capped) */
  var persistTimer = null;
  function persistLogs() {
    if (persistTimer) return;
    persistTimer = setTimeout(function () {
      persistTimer = null;
      try {
        var out = state.logs.slice(-MAX_PERSIST).map(function (e) {
          return [e.level, e.parts.map(function (p) { return p.text; }).join(' ').slice(0, 500), e.time];
        });
        sessionStorage.setItem(PERSIST_KEY, JSON.stringify(out));
      } catch (e) { /* storage full/blocked — skip silently */ }
    }, 1000);
  }

  try {
    var prev = JSON.parse(sessionStorage.getItem(PERSIST_KEY) || '[]');
    if (prev.length) {
      prev.forEach(function (p) {
        state.logs.push({ level: p[0], parts: [{ text: p[1], type: p[0] === 'error' ? 'err' : 'str' }], time: p[2], count: 1, key: 'r' + Math.random(), indent: 0 });
      });
      state.logs.push({ level: 'info', parts: [{ text: '— ' + prev.length + ' logs restored from previous page load —', type: 'null' }], time: now(), count: 1, key: 'r' + Math.random(), indent: 0 });
    }
  } catch (e) {}

  function onWindowError(e) {
    if (e && e.message) {
      pushLog('error', [e.message + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ':' + e.colno + ')' : '')],
        e.error && e.error.stack);
    }
  }
  function onRejection(e) {
    pushLog('error', ['Unhandled promise rejection:', e.reason]);
  }
  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onRejection);

  /* ================= network capture (immediate) ================= */

  function pushNet(entry) {
    state.net.push(entry);
    if (state.net.length > MAX_NET) state.net.shift();
    renderNetThrottled();
    return entry;
  }

  function headersToText(h) {
    var out = [];
    try {
      if (h && typeof h.forEach === 'function') {
        h.forEach(function (v, k) { out.push(k + ': ' + v); });
      }
    } catch (e) {}
    return out.join('\n');
  }

  function bodyToText(b) {
    if (b == null) return '';
    if (typeof b === 'string') return b.slice(0, MAX_BODY);
    try {
      if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return b.toString();
      if (typeof FormData !== 'undefined' && b instanceof FormData) {
        var parts = [];
        b.forEach(function (v, k) { parts.push(k + '=' + (typeof v === 'string' ? v : '[file]')); });
        return parts.join('&');
      }
      if (typeof Blob !== 'undefined' && b instanceof Blob) return '[Blob ' + b.size + ' bytes]';
      if (b instanceof ArrayBuffer) return '[ArrayBuffer ' + b.byteLength + ' bytes]';
      return safeStringify(b, 4).slice(0, MAX_BODY);
    } catch (e) { return '[body]'; }
  }

  /* single throttle/block rule, set from the Network bar */
  function ruleMatch(url) {
    var r = state.netRule;
    return r.mode !== 'off' && r.pattern && String(url).indexOf(r.pattern) !== -1;
  }
  var RULE_DELAY_MS = 2000;

  // fetch
  if (window.fetch) {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var url, method = 'GET', reqHeaders = '', reqBody = '';
      try {
        if (typeof Request !== 'undefined' && input instanceof Request) {
          url = input.url; method = input.method || 'GET';
          reqHeaders = headersToText(input.headers);
        } else {
          url = String(input);
        }
        if (init) {
          if (init.method) method = init.method;
          if (init.headers) {
            if (typeof Headers !== 'undefined' && init.headers instanceof Headers) reqHeaders = headersToText(init.headers);
            else if (Array.isArray(init.headers)) reqHeaders = init.headers.map(function (p) { return p[0] + ': ' + p[1]; }).join('\n');
            else reqHeaders = Object.keys(init.headers).map(function (k) { return k + ': ' + init.headers[k]; }).join('\n');
          }
          if (init.body) reqBody = bodyToText(init.body);
        }
      } catch (e) { url = String(input); }

      var entry = pushNet({
        id: ++state.netId, type: 'fetch', method: method.toUpperCase(), url: url,
        status: null, ok: null, duration: null, start: now(),
        reqHeaders: reqHeaders, reqBody: reqBody, respHeaders: '', respBody: '', error: null
      });

      var self = this, fetchArgs = arguments;
      if (ruleMatch(url)) {
        if (state.netRule.mode === 'block') {
          entry.status = 0; entry.ok = false; entry.duration = 0;
          entry.error = 'Blocked by devtool rule';
          renderNetThrottled();
          return Promise.reject(new TypeError('Failed to fetch (blocked by mobile-devtool rule)'));
        }
        if (state.netRule.mode === 'delay') {
          return new Promise(function (resolve) { setTimeout(resolve, RULE_DELAY_MS); })
            .then(function () { return runFetch(); });
        }
      }
      return runFetch();

      function runFetch() {
      // strict mode makes bare fetch() calls arrive with this === undefined;
      // some browsers throw "Illegal invocation" unless fetch is called on window
      return origFetch.apply(self || window, fetchArgs).then(function (res) {
        entry.status = res.status;
        entry.ok = res.ok;
        entry.duration = now() - entry.start;
        entry.respHeaders = headersToText(res.headers);
        try {
          var ct = (res.headers.get && res.headers.get('content-type')) || '';
          if (/json|text|xml|javascript|html|urlencoded/i.test(ct)) {
            res.clone().text().then(function (t) {
              entry.respBody = t.slice(0, MAX_BODY);
              renderNetThrottled();
            }).catch(function () {});
          } else {
            entry.respBody = '[' + (ct || 'binary') + ']';
          }
        } catch (e) {}
        renderNetThrottled();
        return res;
      }).catch(function (err) {
        entry.status = 0;
        entry.ok = false;
        entry.duration = now() - entry.start;
        entry.error = String(err);
        renderNetThrottled();
        throw err;
      });
      } /* end runFetch */
    };
  }

  // XMLHttpRequest
  if (window.XMLHttpRequest) {
    var XP = XMLHttpRequest.prototype;
    var origOpen = XP.open, origSend = XP.send, origSetHeader = XP.setRequestHeader;
    XP.open = function (method, url) {
      this.__mdt = { method: String(method || 'GET').toUpperCase(), url: String(url), reqHeaders: [] };
      return origOpen.apply(this, arguments);
    };
    XP.setRequestHeader = function (k, v) {
      if (this.__mdt) this.__mdt.reqHeaders.push(k + ': ' + v);
      return origSetHeader.apply(this, arguments);
    };
    XP.send = function (body) {
      var xhr = this, meta = this.__mdt;
      if (meta) {
        var entry = pushNet({
          id: ++state.netId, type: 'xhr', method: meta.method, url: meta.url,
          status: null, ok: null, duration: null, start: now(),
          reqHeaders: meta.reqHeaders.join('\n'), reqBody: bodyToText(body),
          respHeaders: '', respBody: '', error: null
        });
        var done = function () {
          entry.status = xhr.status;
          entry.ok = xhr.status >= 200 && xhr.status < 400;
          entry.duration = now() - entry.start;
          try { entry.respHeaders = xhr.getAllResponseHeaders() || ''; } catch (e) {}
          try {
            if (!xhr.responseType || xhr.responseType === 'text') {
              entry.respBody = String(xhr.responseText || '').slice(0, MAX_BODY);
            } else {
              entry.respBody = '[' + xhr.responseType + ' response]';
            }
          } catch (e) {}
          renderNetThrottled();
        };
        xhr.addEventListener('load', done);
        xhr.addEventListener('error', function () {
          entry.status = 0; entry.ok = false; entry.error = 'Network error';
          entry.duration = now() - entry.start;
          renderNetThrottled();
        });
        xhr.addEventListener('abort', function () {
          entry.status = 0; entry.ok = false; entry.error = 'Aborted';
          entry.duration = now() - entry.start;
          renderNetThrottled();
        });
        if (ruleMatch(meta.url)) {
          if (state.netRule.mode === 'block') {
            entry.error = 'Blocked by devtool rule';
            setTimeout(function () {
              try {
                xhr.dispatchEvent(new Event('error'));
                xhr.dispatchEvent(new Event('loadend'));
              } catch (e) {}
              entry.status = 0; entry.ok = false; entry.duration = 0;
              entry.error = 'Blocked by devtool rule'; // our own error listener overwrites it during dispatch
              renderNetThrottled();
            }, 0);
            return; // never actually sent
          }
          if (state.netRule.mode === 'delay') {
            var sendArgs = arguments, sendSelf = this;
            setTimeout(function () { try { origSend.apply(sendSelf, sendArgs); } catch (e) {} }, RULE_DELAY_MS);
            return;
          }
        }
      }
      return origSend.apply(this, arguments);
    };
  }

  // WebSocket
  if (window.WebSocket) {
    var OrigWS = window.WebSocket;
    window.WebSocket = function WebSocket(url, protocols) {
      var ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
      try {
        var entry = pushNet({
          id: ++state.netId, type: 'ws', method: 'WS', url: String(url),
          status: null, ok: null, duration: null, start: now(),
          reqHeaders: '', reqBody: '', respHeaders: '', respBody: '', error: null,
          frames: [], dropped: 0
        });
        var addFrame = function (dir, data) {
          if (entry.frames.length >= MAX_WS_FRAMES) { entry.frames.shift(); entry.dropped++; }
          entry.frames.push({
            dir: dir, t: now(),
            data: (typeof data === 'string' ? data : '[binary]').slice(0, MAX_WS_FRAME)
          });
          renderNetThrottled();
        };
        ws.addEventListener('open', function () {
          entry.status = 101; entry.ok = true; entry.duration = now() - entry.start;
          renderNetThrottled();
        });
        ws.addEventListener('message', function (ev) { addFrame('↓', ev.data); });
        ws.addEventListener('close', function (ev) {
          entry.error = 'closed (' + ev.code + (ev.reason ? ' ' + ev.reason : '') + ')';
          renderNetThrottled();
        });
        ws.addEventListener('error', function () {
          entry.ok = false; if (entry.status === null) entry.status = 0;
          entry.error = 'connection error';
          renderNetThrottled();
        });
        var origWsSend = ws.send;
        ws.send = function (d) { addFrame('↑', d); return origWsSend.apply(ws, arguments); };
      } catch (e) { /* never break the socket */ }
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { window.WebSocket[k] = OrigWS[k]; });
  }

  /* ================= UI ================= */

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}',
    '.root{font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#e8e8ea}',
    '.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
    /* floating button */
    '.fab{position:fixed;z-index:2147483646;width:46px;height:46px;border-radius:50%;background:#1d1d22;border:1px solid #3a3a44;box-shadow:0 2px 10px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;touch-action:none;cursor:pointer;user-select:none}',
    '.fab svg{width:22px;height:22px;fill:none;stroke:#7dd3fc;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
    '.badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:#ef4444;color:#fff;font-size:11px;font-weight:700;display:none;align-items:center;justify-content:center}',
    /* panel */
    '.panel{position:fixed;z-index:2147483647;left:0;right:0;bottom:0;height:62vh;background:#151519;border-top:1px solid #33333d;box-shadow:0 -6px 24px rgba(0,0,0,.5);display:none;flex-direction:column;border-radius:12px 12px 0 0;overflow:hidden}',
    '.panel.open{display:flex}',
    '.hdr{display:flex;align-items:center;background:#1d1d22;border-bottom:1px solid #33333d;flex:none}',
    '.tabs{display:flex;overflow-x:auto;flex:1;scrollbar-width:none}',
    '.tabs::-webkit-scrollbar{display:none}',
    '.tab{padding:11px 14px;color:#9a9aa5;white-space:nowrap;cursor:pointer;border-bottom:2px solid transparent;font-weight:500}',
    '.tab.on{color:#7dd3fc;border-bottom-color:#7dd3fc}',
    '.hbtn{padding:10px 14px;color:#9a9aa5;cursor:pointer;flex:none;font-size:15px}',
    '.body{flex:1;overflow:hidden;display:flex;flex-direction:column}',
    '.pane{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;display:none;flex-direction:column}',
    '.pane.on{display:flex}',
    '.bar{display:flex;align-items:center;gap:6px;padding:6px 8px;background:#19191e;border-bottom:1px solid #2a2a33;flex:none;flex-wrap:wrap}',
    '.chip{padding:3px 10px;border-radius:20px;background:#26262e;color:#9a9aa5;cursor:pointer;font-size:12px}',
    '.chip.on{background:#0c4a6e;color:#7dd3fc}',
    '.scroll{flex:1;overflow:auto;-webkit-overflow-scrolling:touch}',
    /* console */
    '.log{padding:6px 10px;border-bottom:1px solid #222228;word-break:break-word;white-space:pre-wrap;display:flex;gap:8px}',
    '.log .t{color:#55555f;flex:none;font-size:11px;padding-top:1px}',
    '.log .c{flex:1;min-width:0}',
    '.log.warn{background:rgba(202,138,4,.09)}',
    '.log.warn .c{color:#fbbf24}',
    '.log.error{background:rgba(239,68,68,.09)}',
    '.log.error .c{color:#f87171}',
    '.log.info .c{color:#93c5fd}',
    '.log.debug .c{color:#9a9aa5}',
    '.log.result .c{color:#a7f3d0}',
    '.log.input .c{color:#c4b5fd}',
    '.cnt{display:inline-block;min-width:16px;text-align:center;background:#3f3f4a;border-radius:8px;font-size:10px;padding:0 4px;margin-right:6px;color:#d4d4dc}',
    '.val-str{color:#e8e8ea}.val-num{color:#f0abfc}.val-null{color:#7a7a85;font-style:italic}.val-fn{color:#93c5fd;font-style:italic}.val-obj{color:#fbd38d;cursor:pointer;text-decoration:underline dotted #7a7a85}.val-err{color:#f87171}',
    '.full{display:block;background:#101014;border:1px solid #2a2a33;border-radius:6px;padding:6px;margin-top:4px;max-height:40vh;overflow:auto;color:#d4d4dc}',
    '.stack{color:#8a8a95;font-size:11px;margin-top:3px;white-space:pre-wrap}',
    '.inrow{display:flex;gap:6px;padding:6px 8px;border-top:1px solid #2a2a33;background:#19191e;flex:none}',
    '.inrow input{flex:1;background:#101014;border:1px solid #33333d;border-radius:6px;color:#e8e8ea;padding:7px 10px;font-family:ui-monospace,Menlo,monospace;font-size:13px;outline:none}',
    '.inrow button{background:#0c4a6e;color:#7dd3fc;border:0;border-radius:6px;padding:0 16px;font-weight:600;cursor:pointer}',
    /* network */
    '.nrow{display:flex;gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid #222228;cursor:pointer}',
    '.nrow:active{background:#1d1d24}',
    '.nrow .m{flex:none;font-weight:700;font-size:11px;color:#93c5fd;width:44px}',
    '.nrow .u{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d4d4dc}',
    '.nrow .s{flex:none;font-weight:600}',
    '.nrow .s.ok{color:#4ade80}.nrow .s.bad{color:#f87171}.nrow .s.pend{color:#9a9aa5}',
    '.nrow .d{flex:none;color:#7a7a85;font-size:11px;width:52px;text-align:right}',
    '.ndetail{border-bottom:1px solid #33333d;background:#101014;padding:8px 10px;display:none}',
    '.ndetail.on{display:block}',
    '.ndetail h4{color:#7dd3fc;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin:8px 0 3px}',
    '.ndetail pre{white-space:pre-wrap;word-break:break-word;color:#d4d4dc;max-height:30vh;overflow:auto}',
    /* elements */
    '.tree{padding:6px 8px}',
    '.tnode{padding-left:14px}',
    '.tlabel{cursor:pointer;padding:2px 4px;border-radius:4px;word-break:break-all}',
    '.tlabel.sel{background:#0c4a6e}',
    '.tlabel .tg{color:#f472b6}.tlabel .at{color:#fbd38d}.tlabel .tx{color:#9a9aa5}',
    '.arrow{display:inline-block;width:14px;color:#7a7a85;cursor:pointer}',
    '.edetail{border-top:1px solid #33333d;background:#101014;padding:8px 10px;max-height:38%;overflow:auto;flex:none;display:none}',
    '.edetail.on{display:block}',
    '.kv{display:flex;gap:8px;padding:2px 0;border-bottom:1px solid #1c1c22}',
    '.kv .k{color:#7dd3fc;flex:none;min-width:110px;word-break:break-all}',
    '.kv .v{color:#d4d4dc;word-break:break-all}',
    '.hilite{position:fixed;z-index:2147483645;background:rgba(56,189,248,.25);border:1px solid #38bdf8;pointer-events:none;display:none;border-radius:2px}',
    '.hlabel{position:absolute;top:-22px;left:0;background:#0c4a6e;color:#7dd3fc;font-size:11px;padding:1px 6px;border-radius:4px;white-space:nowrap}',
    /* storage / info */
    '.sect{padding:8px 10px 2px;color:#7dd3fc;font-size:11px;text-transform:uppercase;letter-spacing:.05em;display:flex;justify-content:space-between;align-items:center}',
    '.sect .chip{text-transform:none}',
    '.srow{display:flex;gap:8px;padding:6px 10px;border-bottom:1px solid #222228;align-items:flex-start}',
    '.srow .k{color:#fbd38d;flex:none;max-width:38%;word-break:break-all}',
    '.srow .v{flex:1;color:#d4d4dc;word-break:break-all;white-space:pre-wrap}',
    '.srow .x{flex:none;color:#f87171;cursor:pointer;padding:0 6px;font-weight:700}',
    '.empty{padding:14px;color:#55555f;text-align:center}',
    '.btn{background:#26262e;color:#d4d4dc;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px}',
    'select.btn{-webkit-appearance:none;appearance:none}',
    '.search{background:#101014;border:1px solid #33333d;border-radius:6px;color:#e8e8ea;padding:4px 8px;font-size:12px;outline:none;width:110px;font-family:inherit}',
    '.srow .v.editable{text-decoration:underline dotted #7a7a85;cursor:pointer}',
    /* light theme */
    '.root.light .panel{background:#f6f6f8;border-top-color:#d5d5dd}',
    '.root.light .hdr,.root.light .fab{background:#ffffff;border-color:#d5d5dd}',
    '.root.light .tab{color:#5a5a66}.root.light .tab.on{color:#0369a1;border-bottom-color:#0369a1}',
    '.root.light .bar,.root.light .inrow{background:#efeff3;border-color:#d5d5dd}',
    '.root.light .chip{background:#e2e2e8;color:#5a5a66}.root.light .chip.on{background:#bae6fd;color:#075985}',
    '.root.light .btn{background:#e2e2e8;color:#33333d}',
    '.root.light .search,.root.light .inrow input{background:#fff;border-color:#c9c9d2;color:#1b1b22}',
    '.root.light .log{border-bottom-color:#e4e4ea}',
    '.root.light .log .c{color:#1b1b22}.root.light .log .t{color:#9a9aa5}',
    '.root.light .log.error .c{color:#b91c1c}.root.light .log.warn .c{color:#a16207}.root.light .log.info .c{color:#1d4ed8}',
    '.root.light .val-str{color:#1b1b22}.root.light .val-num{color:#9d174d}.root.light .val-obj{color:#b45309}',
    '.root.light .full,.root.light .ndetail,.root.light .edetail{background:#fff;color:#1b1b22;border-color:#d5d5dd}',
    '.root.light .ndetail pre{color:#33333d}',
    '.root.light .nrow{border-bottom-color:#e4e4ea}.root.light .nrow .u{color:#33333d}',
    '.root.light .srow{border-bottom-color:#e4e4ea}.root.light .srow .v{color:#33333d}',
    '.root.light .kv .v{color:#33333d}.root.light .kv{border-bottom-color:#e9e9ef}',
    '.root.light .tree,.root.light .tlabel .tx{color:#5a5a66}',
    '.root.light .inrow button{background:#0369a1;color:#fff}'
  ].join('\n');

  var ui = null;

  function buildUI() {
    if (ui) return;
    var host = document.createElement('div');
    host.id = '__mobile_devtool__';
    var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var root = el('div', 'root');
    var style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    shadow.appendChild(root);

    /* fab */
    var fab = el('div', 'fab');
    fab.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
    var badge = el('div', 'badge');
    fab.appendChild(badge);
    fab.style.right = '12px';
    fab.style.bottom = '80px';
    root.appendChild(fab);

    /* panel */
    var panel = el('div', 'panel');
    var hdr = el('div', 'hdr');
    var tabs = el('div', 'tabs');
    var TABS = [['console', 'Console'], ['network', 'Network'], ['elements', 'Elements'], ['storage', 'Storage'], ['perf', 'Perf'], ['info', 'Info']];
    var tabEls = {};
    TABS.forEach(function (t) {
      var te = el('div', 'tab', t[1]);
      te.addEventListener('click', function () { switchTab(t[0]); });
      tabEls[t[0]] = te;
      tabs.appendChild(te);
    });
    hdr.appendChild(tabs);
    var themeBtn = el('div', 'hbtn', '◐');
    themeBtn.title = 'Toggle light/dark';
    themeBtn.addEventListener('click', function () {
      state.light = !state.light;
      root.classList.toggle('light', state.light);
      savePrefs();
    });
    hdr.appendChild(themeBtn);
    var offBtn = el('div', 'hbtn', '⏻');
    offBtn.title = 'Remove devtool from this page';
    offBtn.addEventListener('click', function () {
      if (confirm('Remove the devtool from this page?\n(Console/network patches are restored. Re-run the bookmarklet or reload to bring it back.)')) {
        window.mobileDevtool.destroy();
      }
    });
    hdr.appendChild(offBtn);
    var closeBtn = el('div', 'hbtn', '✕');
    closeBtn.title = 'Minimize (floating button stays)';
    closeBtn.addEventListener('click', hide);
    hdr.appendChild(closeBtn);
    panel.appendChild(hdr);

    /* drag header vertically to resize the panel */
    (function () {
      var startY = null, startH = 0;
      hdr.addEventListener('pointerdown', function (e) {
        if (e.target !== hdr && e.target !== tabs) return; // don't hijack tab taps
        startY = e.clientY;
        startH = panel.getBoundingClientRect().height;
        try { hdr.setPointerCapture(e.pointerId); } catch (err) {} // keep tracking when finger leaves the header
      });
      hdr.addEventListener('pointermove', function (e) {
        if (startY === null) return;
        var h = startH + (startY - e.clientY);
        h = Math.min(Math.max(h, window.innerHeight * 0.25), window.innerHeight * 0.92);
        panel.style.height = h + 'px';
      });
      function end() {
        if (startY !== null) { state.panelH = panel.style.height || null; savePrefs(); }
        startY = null;
      }
      hdr.addEventListener('pointerup', end);
      hdr.addEventListener('pointercancel', end);
    })();

    var body = el('div', 'body');
    panel.appendChild(body);
    root.appendChild(panel);

    /* highlight box for element inspect */
    var hilite = el('div', 'hilite');
    var hlabel = el('div', 'hlabel');
    hilite.appendChild(hlabel);
    root.appendChild(hilite);

    /* ---- console pane ---- */
    var cPane = el('div', 'pane');
    var cBar = el('div', 'bar');
    var levels = ['all', 'log', 'info', 'warn', 'error'];
    var chipEls = {};
    levels.forEach(function (lv) {
      var c = el('div', 'chip' + (lv === 'all' ? ' on' : ''), lv);
      c.addEventListener('click', function () {
        state.filter = lv;
        levels.forEach(function (l) { chipEls[l].classList.toggle('on', l === lv); });
        renderConsole();
      });
      chipEls[lv] = c;
      cBar.appendChild(c);
    });
    var cSearch = document.createElement('input');
    cSearch.className = 'search';
    cSearch.placeholder = 'filter…';
    cSearch.addEventListener('input', throttle(function () {
      state.searchLog = cSearch.value.toLowerCase();
      renderConsole();
    }, 200));
    cBar.appendChild(cSearch);
    var cExport = el('button', 'btn', '⬇');
    cExport.title = 'Download logs (.txt); long-press concept: use API for .json';
    cExport.style.marginLeft = 'auto';
    cExport.addEventListener('click', function () { exportLogs('txt'); });
    cBar.appendChild(cExport);
    var cShare = el('button', 'btn', '⤴');
    cShare.title = 'Share logs';
    cShare.addEventListener('click', shareLogs);
    cBar.appendChild(cShare);
    var cClear = el('button', 'btn', 'Clear');
    cClear.addEventListener('click', function () { state.logs = []; try { sessionStorage.removeItem(PERSIST_KEY); } catch (e) {} renderConsole(); });
    cBar.appendChild(cClear);
    cPane.appendChild(cBar);
    var cScroll = el('div', 'scroll mono');
    cPane.appendChild(cScroll);
    var inRow = el('div', 'inrow');
    var input = document.createElement('input');
    input.placeholder = 'Run JavaScript…';
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    input.spellcheck = false;
    var runBtn = el('button', null, 'Run');
    function runCmd() {
      var code = input.value.trim();
      if (!code) return;
      input.value = '';
      state.logs.push({ level: 'input', parts: [{ text: '› ' + code, type: 'str' }], time: now(), count: 1, key: Math.random() });
      renderLogAppend(state.logs[state.logs.length - 1]);
      try {
        var res = (0, eval)(code); // indirect eval → global scope
        if (res instanceof Promise) {
          res.then(function (v) { pushResult(v); }, function (e) { pushLog('error', [e]); });
        } else pushResult(res);
      } catch (e) { pushLog('error', [e]); }
    }
    function pushResult(v) {
      state.logs.push({ level: 'result', parts: [{ text: '‹ ', type: 'str' }, preview(v)], time: now(), count: 1, key: Math.random() });
      renderLogAppend(state.logs[state.logs.length - 1]);
    }
    runBtn.addEventListener('click', runCmd);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') runCmd(); });
    inRow.appendChild(input);
    inRow.appendChild(runBtn);
    cPane.appendChild(inRow);
    body.appendChild(cPane);

    /* ---- network pane ---- */
    var nPane = el('div', 'pane');
    var nBar = el('div', 'bar');
    var nCount = el('div', 'chip on', '0 requests');
    nBar.appendChild(nCount);
    var nSearch = document.createElement('input');
    nSearch.className = 'search';
    nSearch.placeholder = 'filter URL…';
    nSearch.addEventListener('input', throttle(function () {
      state.searchNet = nSearch.value.toLowerCase();
      renderNet();
    }, 200));
    nBar.appendChild(nSearch);
    var nBundle = el('button', 'btn', '⬇ Bundle');
    nBundle.style.marginLeft = 'auto';
    nBundle.title = 'Export repro bundle zip (import into the repro extension via "Import a capture")';
    nBundle.addEventListener('click', exportBundle);
    nBar.appendChild(nBundle);
    var nExport = el('button', 'btn', '⬇ HAR');
    nExport.title = 'Export requests as HAR file';
    nExport.addEventListener('click', exportHAR);
    nBar.appendChild(nExport);
    var nClear = el('button', 'btn', 'Clear');
    nClear.addEventListener('click', function () { state.net = []; renderNet(); });
    nBar.appendChild(nClear);
    nPane.appendChild(nBar);
    /* throttle/block rule row */
    var rBar = el('div', 'bar');
    var rInput = document.createElement('input');
    rInput.className = 'search';
    rInput.placeholder = 'rule: URL contains…';
    rInput.style.flex = '1';
    var rMode = document.createElement('select');
    rMode.className = 'btn';
    [['off', 'rule: off'], ['delay', 'delay 2s'], ['block', 'block']].forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o[0]; opt.textContent = o[1];
      rMode.appendChild(opt);
    });
    function applyRule() {
      state.netRule.pattern = rInput.value.trim();
      state.netRule.mode = state.netRule.pattern ? rMode.value : 'off';
      rBar.style.background = state.netRule.mode !== 'off' ? 'rgba(239,68,68,.12)' : '';
    }
    rInput.addEventListener('input', applyRule);
    rMode.addEventListener('change', applyRule);
    rBar.appendChild(rInput);
    rBar.appendChild(rMode);
    nPane.appendChild(rBar);
    var nScroll = el('div', 'scroll mono');
    nPane.appendChild(nScroll);
    body.appendChild(nPane);

    /* ---- elements pane ---- */
    var ePane = el('div', 'pane');
    var eBar = el('div', 'bar');
    var pickBtn = el('button', 'btn', '⊕ Select element');
    var refreshBtn = el('button', 'btn', '↻ Refresh tree');
    eBar.appendChild(pickBtn);
    eBar.appendChild(refreshBtn);
    ePane.appendChild(eBar);
    var eScroll = el('div', 'scroll mono tree');
    ePane.appendChild(eScroll);
    var eDetail = el('div', 'edetail mono');
    ePane.appendChild(eDetail);
    body.appendChild(ePane);

    /* ---- storage pane ---- */
    var sPane = el('div', 'pane');
    var sScroll = el('div', 'scroll mono');
    sPane.appendChild(sScroll);
    body.appendChild(sPane);

    /* ---- perf pane ---- */
    var pPane = el('div', 'pane');
    var pScroll = el('div', 'scroll mono');
    pPane.appendChild(pScroll);
    body.appendChild(pPane);

    /* ---- info pane ---- */
    var iPane = el('div', 'pane');
    var iScroll = el('div', 'scroll mono');
    iPane.appendChild(iScroll);
    body.appendChild(iPane);

    ui = {
      host: host, root: root, fab: fab, badge: badge, panel: panel,
      tabEls: tabEls, panes: { console: cPane, network: nPane, elements: ePane, storage: sPane, perf: pPane, info: iPane },
      cScroll: cScroll, nScroll: nScroll, nCount: nCount, pScroll: pScroll,
      eScroll: eScroll, eDetail: eDetail, pickBtn: pickBtn,
      sScroll: sScroll, iScroll: iScroll,
      hilite: hilite, hlabel: hlabel,
      selected: null, picking: false
    };
    state.ui = ui;

    /* restore tiny prefs blob */
    try {
      var prefs = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
      if (prefs.light) { state.light = true; root.classList.add('light'); }
      if (prefs.h) { state.panelH = prefs.h; panel.style.height = prefs.h; }
      if (prefs.fx != null && prefs.fy != null) {
        fab.style.left = Math.min(prefs.fx, window.innerWidth - 46) + 'px';
        fab.style.top = Math.min(prefs.fy, window.innerHeight - 46) + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
      }
    } catch (e) {}

    /* fab drag + tap */
    (function () {
      var sx, sy, ox, oy, moved;
      fab.addEventListener('pointerdown', function (e) {
        sx = e.clientX; sy = e.clientY; moved = false;
        var r = fab.getBoundingClientRect();
        ox = r.left; oy = r.top;
        fab.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      fab.addEventListener('pointermove', function (e) {
        if (sx == null) return;
        var dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) + Math.abs(dy) > 8) moved = true;
        if (moved) {
          var x = Math.min(Math.max(0, ox + dx), window.innerWidth - 46);
          var y = Math.min(Math.max(0, oy + dy), window.innerHeight - 46);
          fab.style.left = x + 'px';
          fab.style.top = y + 'px';
          fab.style.right = 'auto';
          fab.style.bottom = 'auto';
        }
      });
      fab.addEventListener('pointerup', function () {
        if (!moved && sx != null) toggle();
        else if (moved) {
          var r = fab.getBoundingClientRect();
          state.fabX = Math.round(r.left); state.fabY = Math.round(r.top);
          savePrefs();
        }
        sx = null;
      });
      fab.addEventListener('pointercancel', function () { sx = null; });
    })();

    /* element picking */
    pickBtn.addEventListener('click', function () { startPicking(); });
    refreshBtn.addEventListener('click', function () { renderTree(); });

    document.documentElement.appendChild(host);
    renderBadge();
    renderConsole();
  }

  /* tiny prefs blob — deliberately minimal (<100 bytes) to respect device storage */
  function savePrefs() {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({
        light: state.light ? 1 : 0,
        h: state.panelH || undefined,
        fx: state.fabX, fy: state.fabY
      }));
    } catch (e) {}
  }

  /* ---- open/close/tabs ---- */

  function show() { buildUI(); state.open = true; ui.panel.classList.add('open'); switchTab(state.tab); }
  function hide() { if (!ui) return; state.open = false; ui.panel.classList.remove('open'); hideHilite(); stopFPS(); }
  function toggle() { state.open ? hide() : show(); }

  function switchTab(name) {
    state.tab = name;
    Object.keys(ui.tabEls).forEach(function (k) {
      ui.tabEls[k].classList.toggle('on', k === name);
      ui.panes[k].classList.toggle('on', k === name);
    });
    if (name === 'console') { state.errBadge = 0; renderBadge(); scrollBottom(ui.cScroll); }
    if (name === 'network') renderNet();
    if (name === 'elements' && !ui.eScroll.childNodes.length) renderTree();
    if (name === 'storage') renderStorage();
    if (name === 'perf') { renderPerf(); startFPS(); } else { stopFPS(); }
    if (name === 'info') renderInfo();
  }

  function renderBadge() {
    if (!ui) return;
    ui.badge.style.display = state.errBadge > 0 ? 'flex' : 'none';
    ui.badge.textContent = state.errBadge > 99 ? '99+' : state.errBadge;
  }

  function scrollBottom(node) {
    requestAnimationFrame(function () { node.scrollTop = node.scrollHeight; });
  }

  /* ---- console rendering ---- */

  function logNode(entry) {
    var row = el('div', 'log ' + entry.level);
    row.__entry = entry;
    if (entry.indent) row.style.paddingLeft = (10 + entry.indent * 14) + 'px';
    var t = el('span', 't', timeStr(entry.time));
    var c = el('span', 'c');
    if (entry.count > 1) c.appendChild(el('span', 'cnt', String(entry.count)));
    entry.parts.forEach(function (p, i) {
      if (i > 0) c.appendChild(document.createTextNode(' '));
      var span = el('span', 'val-' + p.type, p.text);
      if (p.type === 'obj' && p.full) {
        span.addEventListener('click', function () {
          var existing = c.querySelector('.full[data-i="' + i + '"]');
          if (existing) { existing.remove(); return; }
          var pre = el('pre', 'full', p.full);
          pre.setAttribute('data-i', i);
          c.appendChild(pre);
        });
      }
      c.appendChild(span);
    });
    if (entry.stack) c.appendChild(el('div', 'stack', entry.stack));
    row.appendChild(t);
    row.appendChild(c);
    return row;
  }

  function matchFilter(entry) {
    var levelOk;
    if (state.filter === 'all') levelOk = true;
    else if (state.filter === 'log') levelOk = entry.level === 'log' || entry.level === 'debug' || entry.level === 'result' || entry.level === 'input';
    else levelOk = entry.level === state.filter;
    if (!levelOk) return false;
    if (!state.searchLog) return true;
    return entry.parts.some(function (p) { return p.text.toLowerCase().indexOf(state.searchLog) !== -1; });
  }

  function renderConsole() {
    if (!ui) return;
    ui.cScroll.textContent = '';
    var frag = document.createDocumentFragment();
    state.logs.forEach(function (entry) {
      if (matchFilter(entry)) frag.appendChild(logNode(entry));
    });
    if (!frag.childNodes.length) frag.appendChild(el('div', 'empty', 'No logs'));
    ui.cScroll.appendChild(frag);
    scrollBottom(ui.cScroll);
  }

  function renderLogAppend(entry) {
    if (!ui || !matchFilter(entry)) return;
    var emptyMsg = ui.cScroll.querySelector('.empty');
    if (emptyMsg) emptyMsg.remove();
    var nearBottom = ui.cScroll.scrollHeight - ui.cScroll.scrollTop - ui.cScroll.clientHeight < 80;
    ui.cScroll.appendChild(logNode(entry));
    while (ui.cScroll.childNodes.length > MAX_LOGS) ui.cScroll.removeChild(ui.cScroll.firstChild);
    if (nearBottom) scrollBottom(ui.cScroll);
  }

  function renderLogUpdate(entry) {
    if (!ui) return;
    var rows = ui.cScroll.querySelectorAll('.log');
    var last = rows[rows.length - 1];
    if (last && last.__entry === entry) {
      var rep = logNode(entry);
      last.replaceWith(rep);
    }
  }

  /* ---- network rendering ---- */

  function renderNet() {
    if (!ui || !ui.panes.network.classList.contains('on')) {
      if (ui) updateNetCount();
      return;
    }
    updateNetCount();
    var open = {};
    ui.nScroll.querySelectorAll('.ndetail.on').forEach(function (d) { open[d.getAttribute('data-id')] = true; });
    ui.nScroll.textContent = '';
    var frag = document.createDocumentFragment();
    var list = state.searchNet
      ? state.net.filter(function (n) { return n.url.toLowerCase().indexOf(state.searchNet) !== -1; })
      : state.net;
    if (!list.length) frag.appendChild(el('div', 'empty', state.net.length ? 'No matching requests' : 'No requests captured yet'));
    list.forEach(function (n) {
      var row = el('div', 'nrow');
      row.appendChild(el('span', 'm', n.method));
      var u;
      try { u = new URL(n.url, location.href); u = u.pathname.split('/').pop() || u.hostname; } catch (e) { u = n.url; }
      var uEl = el('span', 'u', u || n.url);
      uEl.title = n.url;
      row.appendChild(uEl);
      var sCls = n.status === null ? 'pend' : (n.ok ? 'ok' : 'bad');
      row.appendChild(el('span', 's ' + sCls, n.status === null ? '…' : (n.status || 'ERR')));
      row.appendChild(el('span', 'd', n.duration != null ? n.duration + 'ms' : ''));
      var detail = el('div', 'ndetail' + (open[n.id] ? ' on' : ''));
      detail.setAttribute('data-id', n.id);
      if (open[n.id]) fillDetail(detail, n);
      row.addEventListener('click', function () {
        var isOpen = detail.classList.toggle('on');
        if (isOpen) fillDetail(detail, n);
      });
      frag.appendChild(row);
      frag.appendChild(detail);
    });
    ui.nScroll.appendChild(frag);
  }

  function updateNetCount() {
    if (ui) ui.nCount.textContent = state.net.length + ' request' + (state.net.length === 1 ? '' : 's');
  }

  function fillDetail(detail, n) {
    detail.textContent = '';
    function sec(title, text) {
      if (!text) return;
      detail.appendChild(el('h4', null, title));
      var pre = el('pre', null, text);
      detail.appendChild(pre);
    }
    sec('General', n.method + ' ' + n.url + '\nStatus: ' + (n.status === null ? 'pending' : n.status) +
      (n.duration != null ? '\nDuration: ' + n.duration + 'ms' : '') +
      '\nType: ' + n.type + (n.error ? '\nError: ' + n.error : ''));
    if (n.frames) {
      sec('Frames (↑ sent / ↓ received' + (n.dropped ? ', ' + n.dropped + ' oldest dropped' : '') + ')',
        n.frames.length
          ? n.frames.map(function (f) { return f.dir + ' ' + timeStr(f.t) + '  ' + f.data; }).join('\n')
          : '(none yet)');
    }
    sec('Request headers', n.reqHeaders);
    sec('Request body', n.reqBody);
    sec('Response headers', n.respHeaders);
    var body = n.respBody;
    if (body && /^[\s]*[{\[]/.test(body)) {
      try { body = JSON.stringify(JSON.parse(body), null, 2); } catch (e) {}
    }
    sec('Response body', body);
  }

  var renderNetThrottled = throttle(function () { renderNet(); }, 300);

  /* ---- HAR export ---- */

  function parseHeaderText(text) {
    var out = [];
    (text || '').split('\n').forEach(function (line) {
      var i = line.indexOf(':');
      if (i > 0) out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
    });
    return out;
  }

  function headerValue(headers, name) {
    for (var i = 0; i < headers.length; i++) {
      if (headers[i].name.toLowerCase() === name) return headers[i].value;
    }
    return '';
  }

  function buildHAR() {
    var entries = state.net.filter(function (n) { return n.status !== null && n.type !== 'ws'; }).map(function (n) {
      var reqHeaders = parseHeaderText(n.reqHeaders);
      var respHeaders = parseHeaderText(n.respHeaders);
      var query = [];
      try {
        new URL(n.url, location.href).searchParams.forEach(function (v, k) {
          query.push({ name: k, value: v });
        });
      } catch (e) {}
      var entry = {
        startedDateTime: new Date(n.start).toISOString(),
        time: n.duration || 0,
        request: {
          method: n.method,
          url: (function () { try { return new URL(n.url, location.href).href; } catch (e) { return n.url; } })(),
          httpVersion: 'HTTP/1.1',
          headers: reqHeaders,
          queryString: query,
          cookies: [],
          headersSize: -1,
          bodySize: n.reqBody ? n.reqBody.length : 0
        },
        response: {
          status: n.status || 0,
          statusText: n.error || '',
          httpVersion: 'HTTP/1.1',
          headers: respHeaders,
          cookies: [],
          content: {
            size: n.respBody ? n.respBody.length : 0,
            mimeType: headerValue(respHeaders, 'content-type') || 'x-unknown',
            text: n.respBody || ''
          },
          redirectURL: headerValue(respHeaders, 'location'),
          headersSize: -1,
          bodySize: n.respBody ? n.respBody.length : 0
        },
        cache: {},
        timings: { send: 0, wait: n.duration || 0, receive: 0 },
        _resourceType: n.type,
        pageref: 'page_1'
      };
      if (n.reqBody) {
        entry.request.postData = {
          mimeType: headerValue(reqHeaders, 'content-type') || 'text/plain',
          text: n.reqBody
        };
      }
      return entry;
    });
    return {
      log: {
        version: '1.2',
        creator: { name: 'repro-mobile-devtools', version: '1.1.0' },
        pages: [{
          startedDateTime: new Date().toISOString(),
          id: 'page_1',
          title: location.href,
          pageTimings: { onContentLoad: -1, onLoad: -1 }
        }],
        entries: entries
      }
    };
  }

  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

  function exportHAR() {
    try {
      var har = buildHAR();
      downloadBlob(new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' }), 'devtool-' + stamp() + '.har');
      return har;
    } catch (e) {
      pushLog('error', ['HAR export failed:', e]);
      return null;
    }
  }

  /* ---- repro bundle export ----
     Produces a zip compatible with the repro debug-extension's "Import a capture":
     data.json { session, events } (+ summary.md, network.har). Zip entries use
     STORE (no compression) with sizes/CRC in local headers — same as repro's own writer. */

  var BOOT = now();

  function headersToObjMap(text) {
    var o = {};
    (text || '').split('\n').forEach(function (line) {
      var i = line.indexOf(':');
      if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
    return o;
  }

  function buildBundleData() {
    var sid = 'sess_' + BOOT + '_' + Math.random().toString(36).slice(2, 8);
    var events = [];
    events.push({
      sessionId: sid, type: 'env', t: BOOT,
      data: {
        url: location.href,
        title: document.title,
        userAgent: navigator.userAgent,
        platform: navigator.platform || '',
        language: navigator.language,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        screen: { w: screen.width, h: screen.height },
        dpr: window.devicePixelRatio || 1,
        online: navigator.onLine,
        cookiesEnabled: navigator.cookieEnabled,
        time: new Date(BOOT).toISOString(),
        tz: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return ''; } })()
      }
    });
    state.logs.forEach(function (e) {
      var level = (e.level === 'result' || e.level === 'input') ? 'log' : e.level;
      var data = {
        level: level,
        args: e.parts.map(function (p) { return p.full || p.text; })
      };
      if (e.stack) { data.stack = e.stack; data.uncaught = true; }
      if (e.count > 1) data.args.push('(repeated x' + e.count + ')');
      events.push({ sessionId: sid, type: 'console', t: e.time, data: data });
    });
    state.net.forEach(function (n) {
      var data = {
        kind: n.type, // fetch | xhr | ws
        method: n.method,
        url: n.url,
        status: n.status === null ? 0 : n.status,
        statusText: n.error || '',
        ok: !!n.ok,
        duration: n.duration || 0,
        startTime: n.start,
        requestHeaders: headersToObjMap(n.reqHeaders),
        responseHeaders: headersToObjMap(n.respHeaders)
      };
      if (n.reqBody) data.requestBody = n.reqBody;
      if (n.respBody) data.responseBody = n.respBody;
      if (n.frames) data.ws = { frames: n.frames, dropped: n.dropped || 0 };
      events.push({ sessionId: sid, type: 'network', t: n.start, data: data });
    });
    events.sort(function (a, b) { return a.t - b.t; });
    return {
      session: {
        id: sid,
        startedAt: BOOT,
        endedAt: now(),
        url: location.href,
        title: document.title,
        tabId: null,
        perf: false,
        label: 'mobile-devtool capture — ' + location.host,
        options: { video: false, console: true, network: true, actions: false, perf: false, code: false }
      },
      events: events,
      shots: [],
      clips: []
    };
  }

  function buildBundleSummary(data) {
    var errs = state.logs.filter(function (e) { return e.level === 'error'; });
    var failed = state.net.filter(function (n) { return n.status !== null && !n.ok; });
    var lines = [
      '# Capture summary',
      '',
      '- **Page:** ' + location.href,
      '- **Captured:** ' + new Date(BOOT).toISOString() + ' → ' + new Date().toISOString(),
      '- **Device:** ' + navigator.userAgent,
      '- **Logs:** ' + state.logs.length + ' (' + errs.length + ' errors)',
      '- **Requests:** ' + state.net.length + ' (' + failed.length + ' failed)',
      ''
    ];
    if (errs.length) {
      lines.push('## Errors');
      lines.push('');
      errs.slice(-20).forEach(function (e) {
        lines.push('- `' + timeStr(e.time) + '` ' + e.parts.map(function (p) { return p.text; }).join(' ').slice(0, 300));
      });
      lines.push('');
    }
    if (failed.length) {
      lines.push('## Failed requests');
      lines.push('');
      failed.slice(-20).forEach(function (n) {
        lines.push('- `' + n.method + '` ' + n.url + ' → ' + (n.status || n.error || 'ERR'));
      });
      lines.push('');
    }
    return lines.join('\n');
  }

  /* minimal STORE-only zip writer (mirrors repro's own format) */
  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var nn = 0; nn < 256; nn++) {
      var c = nn;
      for (var k = 0; k < 8; k++) c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1);
      t[nn] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = -1;
    for (var i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
    return (c ^ -1) >>> 0;
  }

  function makeZip(files) { // files: [{name, text}]
    var enc = new TextEncoder();
    var chunks = [], central = [], offset = 0;
    files.forEach(function (f) {
      var nameB = enc.encode(f.name);
      var data = enc.encode(f.text);
      var crc = crc32(data);
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);  // local header sig
      lh.setUint16(4, 20, true);          // version needed
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); // compressed (STORE)
      lh.setUint32(22, data.length, true); // uncompressed
      lh.setUint16(26, nameB.length, true);
      chunks.push(new Uint8Array(lh.buffer), nameB, data);
      var cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);  // central dir sig
      cd.setUint16(4, 20, true);          // version made by
      cd.setUint16(6, 20, true);          // version needed
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameB.length, true);
      cd.setUint32(42, offset, true);     // local header offset
      central.push(new Uint8Array(cd.buffer), nameB);
      offset += 30 + nameB.length + data.length;
    });
    var cdSize = 0;
    central.forEach(function (c) { cdSize += c.length; });
    var eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, offset, true);
    var all = chunks.concat(central, [new Uint8Array(eocd.buffer)]);
    return new Blob(all, { type: 'application/zip' });
  }

  function exportBundle() {
    try {
      var data = buildBundleData();
      var files = [
        { name: 'data.json', text: JSON.stringify(data, null, 2) },
        { name: 'summary.md', text: buildBundleSummary(data) }
      ];
      if (state.net.some(function (n) { return n.type !== 'ws'; })) {
        files.push({ name: 'network.har', text: JSON.stringify(buildHAR(), null, 2) });
      }
      var d = new Date();
      function p2(x) { return String(x).padStart(2, '0'); }
      var name = 'repro-bundle-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + '.zip';
      downloadBlob(makeZip(files), name);
      return data;
    } catch (e) {
      pushLog('error', ['Bundle export failed:', e]);
      return null;
    }
  }

  /* ---- console log export / share ---- */

  function logsText() {
    return state.logs.map(function (e) {
      var line = '[' + timeStr(e.time) + '] ' + e.level.toUpperCase().slice(0, 5) + ' ' +
        (e.count > 1 ? '(x' + e.count + ') ' : '') +
        e.parts.map(function (p) { return p.text; }).join(' ');
      return e.stack ? line + '\n' + e.stack : line;
    }).join('\n');
  }

  function logsJSON() {
    return state.logs.map(function (e) {
      return {
        time: new Date(e.time).toISOString(),
        level: e.level,
        count: e.count,
        message: e.parts.map(function (p) { return p.full || p.text; }).join(' '),
        stack: e.stack || undefined
      };
    });
  }

  function exportLogs(format) {
    try {
      if (format === 'json') {
        downloadBlob(new Blob([JSON.stringify(logsJSON(), null, 2)], { type: 'application/json' }), 'console-' + stamp() + '.json');
      } else {
        downloadBlob(new Blob([logsText()], { type: 'text/plain' }), 'console-' + stamp() + '.txt');
      }
    } catch (e) { pushLog('error', ['Log export failed:', e]); }
  }

  function shareLogs() {
    var text = logsText();
    if (text.length > 60000) text = '…(truncated)\n' + text.slice(-60000);
    if (navigator.share) {
      navigator.share({ title: 'Console logs — ' + location.host, text: text }).catch(function () {});
    } else {
      exportLogs('txt');
    }
  }

  /* ---- elements panel ---- */

  function isOurs(node) {
    while (node) {
      if (node.id === '__mobile_devtool__') return true;
      node = node.parentNode || node.host;
    }
    return false;
  }

  function nodeLabel(node, container) {
    var tg = el('span', 'tg', '<' + node.nodeName.toLowerCase());
    container.appendChild(tg);
    if (node.attributes) {
      for (var i = 0; i < Math.min(node.attributes.length, 4); i++) {
        var a = node.attributes[i];
        container.appendChild(el('span', 'at', ' ' + a.name + '="' + a.value.slice(0, 40) + '"'));
      }
      if (node.attributes.length > 4) container.appendChild(el('span', 'at', ' …'));
    }
    container.appendChild(el('span', 'tg', '>'));
  }

  function renderTreeNode(node, depth) {
    var wrap = el('div', 'tnode');
    var label = el('div', 'tlabel');
    var kids = Array.prototype.filter.call(node.children || [], function (c) { return !isOurs(c); });
    var arrow = el('span', 'arrow', kids.length ? '▸' : ' ');
    label.appendChild(arrow);
    nodeLabel(node, label);
    var textPreview = '';
    if (!kids.length && node.textContent) {
      textPreview = node.textContent.trim().slice(0, 40);
      if (textPreview) label.appendChild(el('span', 'tx', ' ' + textPreview));
    }
    wrap.appendChild(label);
    var childBox = el('div');
    childBox.style.display = 'none';
    wrap.appendChild(childBox);
    var expanded = false;
    function toggleKids(force) {
      if (!kids.length) return;
      expanded = force != null ? force : !expanded;
      arrow.textContent = expanded ? '▾' : '▸';
      childBox.style.display = expanded ? 'block' : 'none';
      if (expanded && !childBox.childNodes.length) {
        kids.forEach(function (c) { childBox.appendChild(renderTreeNode(c, depth + 1)); });
      }
    }
    arrow.addEventListener('click', function (e) { e.stopPropagation(); toggleKids(); });
    label.addEventListener('click', function () {
      selectElement(node, label);
      toggleKids(true);
    });
    if (depth < 2) toggleKids(true);
    label.__domNode = node;
    return wrap;
  }

  function renderTree() {
    ui.eScroll.textContent = '';
    ui.eScroll.appendChild(renderTreeNode(document.documentElement, 0));
  }

  function selectElement(node, labelEl) {
    if (ui.selected) ui.selected.classList.remove('sel');
    if (labelEl) { labelEl.classList.add('sel'); ui.selected = labelEl; }
    showDetail(node);
    flashHilite(node);
  }

  function showDetail(node) {
    var d = ui.eDetail;
    d.classList.add('on');
    d.textContent = '';
    function kv(k, v) {
      if (v == null || v === '') return;
      var row = el('div', 'kv');
      row.appendChild(el('span', 'k', k));
      row.appendChild(el('span', 'v', String(v)));
      d.appendChild(row);
    }
    kv('tag', node.nodeName.toLowerCase());
    if (node.attributes) {
      for (var i = 0; i < node.attributes.length; i++) {
        kv('@' + node.attributes[i].name, node.attributes[i].value);
      }
    }
    try {
      var r = node.getBoundingClientRect();
      kv('rect', Math.round(r.width) + '×' + Math.round(r.height) + ' @ (' + Math.round(r.left) + ',' + Math.round(r.top) + ')');
      var cs = getComputedStyle(node);
      ['display', 'position', 'z-index', 'margin', 'padding', 'font-size', 'color', 'background-color', 'overflow', 'flex-direction'].forEach(function (p) {
        kv(p, cs.getPropertyValue(p));
      });
    } catch (e) {}
  }

  function flashHilite(node) {
    try {
      var r = node.getBoundingClientRect();
      var h = ui.hilite;
      h.style.display = 'block';
      h.style.left = r.left + 'px';
      h.style.top = r.top + 'px';
      h.style.width = r.width + 'px';
      h.style.height = r.height + 'px';
      ui.hlabel.textContent = node.nodeName.toLowerCase() +
        (node.id ? '#' + node.id : '') + ' ' + Math.round(r.width) + '×' + Math.round(r.height);
      clearTimeout(flashHilite.__t);
      flashHilite.__t = setTimeout(hideHilite, 1800);
    } catch (e) {}
  }

  function hideHilite() { if (ui) ui.hilite.style.display = 'none'; }

  function startPicking() {
    ui.picking = true;
    hide(); // let user see the page
    ui.fab.style.opacity = '0.35';
    function onDown(e) {
      var target = e.target;
      if (isOurs(target)) { cleanup(); return; } // tapping our own UI cancels picking
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      show();
      switchTab('elements');
      // expand tree to the node
      revealInTree(target);
      selectElement(target, findLabel(target));
    }
    function onMove(e) {
      var t = document.elementFromPoint(e.clientX, e.clientY);
      if (t && !isOurs(t)) flashHilite(t);
    }
    function cleanup() {
      ui.picking = false;
      ui.fab.style.opacity = '';
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointermove', onMove, true);
      hideHilite();
    }
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove, true);
  }

  function revealInTree(target) {
    // rebuild tree, then walk down expanding path
    renderTree();
    var path = [];
    var n = target;
    while (n && n !== document.documentElement) { path.unshift(n); n = n.parentElement; }
    var scope = ui.eScroll;
    path.forEach(function (pn) {
      var labels = scope.querySelectorAll('.tlabel');
      for (var i = 0; i < labels.length; i++) {
        if (labels[i].__domNode === pn.parentElement) {
          labels[i].click(); // expands
          break;
        }
      }
    });
  }

  function findLabel(target) {
    var labels = ui.eScroll.querySelectorAll('.tlabel');
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].__domNode === target) {
        labels[i].scrollIntoView({ block: 'center' });
        return labels[i];
      }
    }
    return null;
  }

  /* ---- storage panel ---- */

  function renderStorage() {
    var s = ui.sScroll;
    s.textContent = '';

    function section(title, entries, onDelete, onClear, onEdit) {
      var head = el('div', 'sect');
      head.appendChild(el('span', null, title + ' (' + entries.length + ')'));
      if (entries.length && onClear) {
        var clr = el('span', 'chip', 'clear all');
        clr.addEventListener('click', function () { onClear(); renderStorage(); });
        head.appendChild(clr);
      }
      s.appendChild(head);
      if (!entries.length) { s.appendChild(el('div', 'empty', 'empty')); return; }
      entries.forEach(function (kv) {
        var row = el('div', 'srow');
        row.appendChild(el('span', 'k', kv[0]));
        var v = kv[1];
        if (v && v.length > 300) v = v.slice(0, 300) + '… (' + v.length + ' chars)';
        var vEl = el('span', 'v' + (onEdit ? ' editable' : ''), v);
        if (onEdit) {
          vEl.title = 'Tap to edit';
          vEl.addEventListener('click', function () {
            var next = prompt('Edit "' + kv[0] + '"', kv[1]);
            if (next !== null) { onEdit(kv[0], next); renderStorage(); }
          });
        }
        row.appendChild(vEl);
        if (onDelete) {
          var x = el('span', 'x', '✕');
          x.addEventListener('click', function () { onDelete(kv[0]); renderStorage(); });
          row.appendChild(x);
        }
        s.appendChild(row);
      });
    }

    function storeEntries(store) {
      var out = [];
      try { for (var i = 0; i < store.length; i++) { var k = store.key(i); out.push([k, store.getItem(k)]); } } catch (e) {}
      return out;
    }

    try {
      section('localStorage', storeEntries(localStorage),
        function (k) { localStorage.removeItem(k); },
        function () { localStorage.clear(); },
        function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} });
    } catch (e) { section('localStorage', []); }

    try {
      section('sessionStorage', storeEntries(sessionStorage),
        function (k) { sessionStorage.removeItem(k); },
        function () { sessionStorage.clear(); },
        function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} });
    } catch (e) { section('sessionStorage', []); }

    var cookies = [];
    try {
      (document.cookie || '').split(';').forEach(function (c) {
        c = c.trim();
        if (!c) return;
        var eq = c.indexOf('=');
        cookies.push([decodeURIComponent(c.slice(0, eq)), decodeURIComponent(c.slice(eq + 1))]);
      });
    } catch (e) {}
    section('Cookies', cookies, function (k) {
      document.cookie = encodeURIComponent(k) + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
    }, null, function (k, v) {
      try { document.cookie = encodeURIComponent(k) + '=' + encodeURIComponent(v) + ';path=/'; } catch (e) {}
    });
  }

  /* ---- perf panel ---- */

  /* long-task observer: tiny ring buffer of durations only */
  var longTasks = { count: 0, recent: [], obs: null };
  try {
    if (window.PerformanceObserver) {
      longTasks.obs = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          longTasks.count++;
          longTasks.recent.push(Math.round(e.duration));
          if (longTasks.recent.length > 20) longTasks.recent.shift();
        });
      });
      longTasks.obs.observe({ entryTypes: ['longtask'] });
    }
  } catch (e) { longTasks.obs = null; }

  /* FPS meter — runs ONLY while Perf tab is visible (battery/CPU friendly) */
  var fps = { on: false, frames: 0, last: 0, val: null };
  function fpsLoop(t) {
    if (!fps.on) return;
    fps.frames++;
    if (t - fps.last >= 1000) {
      fps.val = fps.frames;
      fps.frames = 0;
      fps.last = t;
      if (ui && ui.fpsEl) ui.fpsEl.textContent = fps.val + ' fps';
    }
    requestAnimationFrame(fpsLoop);
  }
  function startFPS() {
    if (fps.on || !window.requestAnimationFrame) return;
    fps.on = true; fps.frames = 0; fps.last = 0;
    requestAnimationFrame(fpsLoop);
  }
  function stopFPS() { fps.on = false; }

  function ms(v) { return v == null || isNaN(v) ? 'n/a' : Math.round(v) + 'ms'; }
  function kb(v) { return v == null ? 'n/a' : (v / 1048576).toFixed(1) + ' MB'; }

  function renderPerf() {
    var s = ui.pScroll;
    s.textContent = '';
    function sect(title) { s.appendChild(el('div', 'sect', title)); }
    function row(k, v, liveRef) {
      var r = el('div', 'srow');
      r.appendChild(el('span', 'k', k));
      var val = el('span', 'v', v);
      r.appendChild(val);
      s.appendChild(r);
      if (liveRef) ui[liveRef] = val;
    }

    sect('Frame rate');
    row('FPS (live)', fps.val != null ? fps.val + ' fps' : 'measuring…', 'fpsEl');

    sect('Page load');
    var nav = null;
    try { nav = performance.getEntriesByType('navigation')[0]; } catch (e) {}
    if (nav) {
      row('DNS', ms(nav.domainLookupEnd - nav.domainLookupStart));
      row('TCP + TLS', ms(nav.connectEnd - nav.connectStart));
      row('Time to first byte', ms(nav.responseStart - nav.requestStart));
      row('Download', ms(nav.responseEnd - nav.responseStart));
      row('DOM interactive', ms(nav.domInteractive));
      row('DOMContentLoaded', ms(nav.domContentLoadedEventEnd));
      row('Full load', ms(nav.loadEventEnd || (now() - performance.timeOrigin)));
      row('Transfer size', nav.transferSize ? (nav.transferSize / 1024).toFixed(1) + ' KB' : 'n/a');
    } else {
      row('Navigation timing', 'not supported');
    }
    try {
      performance.getEntriesByType('paint').forEach(function (p) {
        row(p.name === 'first-contentful-paint' ? 'First contentful paint' : p.name, ms(p.startTime));
      });
    } catch (e) {}

    sect('Resources');
    try {
      var res = performance.getEntriesByType('resource');
      var total = 0;
      res.forEach(function (r) { total += r.transferSize || 0; });
      row('Count', String(res.length));
      row('Transferred', (total / 1024).toFixed(1) + ' KB');
    } catch (e) { row('Resources', 'not supported'); }

    sect('Memory');
    if (performance.memory) {
      row('JS heap used', kb(performance.memory.usedJSHeapSize));
      row('JS heap limit', kb(performance.memory.jsHeapSizeLimit));
    } else {
      row('JS heap', 'n/a (Chrome only)');
    }
    row('Devtool buffers', state.logs.length + ' logs, ' + state.net.length + ' requests (capped)');

    sect('Long tasks (>50ms)');
    if (longTasks.obs) {
      row('Count since load', String(longTasks.count));
      row('Recent durations', longTasks.recent.length ? longTasks.recent.join(', ') + ' ms' : 'none');
    } else {
      row('Long tasks', 'not supported');
    }
  }

  /* ---- info panel ---- */

  function renderInfo() {
    var s = ui.iScroll;
    s.textContent = '';
    var n = navigator;
    var items = [
      ['URL', location.href],
      ['User agent', n.userAgent],
      ['Platform', n.platform || ''],
      ['Language', n.language],
      ['Online', String(n.onLine)],
      ['Cookies enabled', String(n.cookieEnabled)],
      ['Viewport', window.innerWidth + ' × ' + window.innerHeight],
      ['Screen', screen.width + ' × ' + screen.height],
      ['Pixel ratio', String(window.devicePixelRatio)],
      ['Touch points', String(n.maxTouchPoints || 0)],
      ['Memory (approx)', (n.deviceMemory ? n.deviceMemory + ' GB' : 'n/a')],
      ['Connection', (n.connection && n.connection.effectiveType) || 'n/a'],
      ['Referrer', document.referrer || 'none'],
      ['Doc ready state', document.readyState]
    ];
    items.forEach(function (it) {
      var row = el('div', 'srow');
      row.appendChild(el('span', 'k', it[0]));
      row.appendChild(el('span', 'v', it[1]));
      s.appendChild(row);
    });
  }

  /* ================= boot ================= */

  function boot() {
    try { buildUI(); } catch (e) { if (orig.error) orig.error('mobile-devtool failed to init:', e); }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.mobileDevtool = {
    show: show,
    hide: hide,
    getHAR: buildHAR,       // returns HAR 1.2 object
    exportHAR: exportHAR,   // triggers .har file download
    getLogs: logsJSON,      // returns logs as array of objects
    exportLogs: exportLogs, // ('txt'|'json') triggers download
    shareLogs: shareLogs,   // navigator.share (falls back to download)
    getBundle: buildBundleData,   // returns { session, events, shots, clips }
    exportBundle: exportBundle,   // downloads repro-bundle-*.zip (repro extension compatible)
    destroy: function () {
      if (ui && ui.host && ui.host.parentNode) ui.host.parentNode.removeChild(ui.host);
      ui = null;
      // restore all patched APIs so nothing lingers (and re-injection won't double-wrap)
      ['log', 'info', 'warn', 'error', 'debug'].forEach(function (m) {
        if (orig[m]) console[m] = orig[m];
      });
      if (origTime) console.time = origTime;
      if (origTimeEnd) console.timeEnd = origTimeEnd;
      if (origGroup) console.group = origGroup;
      if (origGroupEnd) console.groupEnd = origGroupEnd;
      if (orig.table) console.table = orig.table;
      if (typeof OrigWS !== 'undefined' && OrigWS) window.WebSocket = OrigWS;
      stopFPS();
      if (longTasks.obs) { try { longTasks.obs.disconnect(); } catch (e) {} }
      try { sessionStorage.removeItem(PERSIST_KEY); } catch (e) {}
      if (typeof origFetch === 'function') window.fetch = origFetch;
      if (typeof XP !== 'undefined' && XP && origOpen) {
        XP.open = origOpen;
        XP.send = origSend;
        XP.setRequestHeader = origSetHeader;
      }
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onRejection);
      window.__MOBILE_DEVTOOL__ = false;
    }
  };
})();
