// ==UserScript==
// @name         Scrollbars visible while scrolling
// @description  Show themed scrollbar thumbs, then hide them after 800 ms idle.
// @match        *://*/*
// @match        file:///*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const idleDelay = 800;
    const timers = new WeakMap();

    document.addEventListener('scroll', (event) => {
        // The viewport takes its scrollbar styling from the root element.
        const scroller = event.target === document ||
            event.target === document.scrollingElement
            ? document.documentElement
            : event.target;

        if (!(scroller instanceof Element)) {
            return;
        }

        scroller.setAttribute('data-qute-scrolling', '');
        clearTimeout(timers.get(scroller));
        timers.set(scroller, setTimeout(() => {
            scroller.removeAttribute('data-qute-scrolling');
            timers.delete(scroller);
        }, idleDelay));
    }, {capture: true, passive: true});
})();
