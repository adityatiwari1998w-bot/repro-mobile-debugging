// ==UserScript==
// @name         repro-mobile-devtools
// @namespace    https://github.com/adityatiwari1998w-bot/repro-mobile-debugging
// @version      1.1.0
// @description  Auto-inject on-page mobile DevTools on every page load. Persistent alternative to the bookmarklet — disable/enable per-site from your userscript manager.
// @author       Aditya Kumar Tiwari
// @match        *://*/*
// @exclude      *://*.google.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// Tip: replace the @match rule above with your own domain(s), e.g.
//   @match *://*.yourapp.com/*
// so the devtool only loads where you're debugging.

(function () {
  'use strict';
  if (window.__MOBILE_DEVTOOL__) return;
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/gh/adityatiwari1998w-bot/repro-mobile-debugging@main/mobile-devtool.min.js';
  (document.head || document.documentElement).appendChild(s);
})();
