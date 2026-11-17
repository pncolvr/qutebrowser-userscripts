// ==UserScript==
// @name Soft Paywall Unlock
// @version 1.0
// @description Remove client-side paywall overlays, restore scrolling and keep stripped article text.
// @match https://www.theverge.com/*
// @match https://theverge.com/*
// @match https://www.theguardian.com/*
// @grant none
// @run-at document-start
// ==/UserScript==

// Soft paywalls ship the full article and then hide it in the browser: they
// lock scrolling on <html>/<body>, cover the page with a fixed overlay, and
// sometimes blur, clip or remove the text. This script undoes each of those.
//
// It runs automatically on the @match sites above. On any other page, run it
// with the `unpaywall` page action (`:spawn --userscript unpaywall`), which
// loads this same file through `jseval`. Without a site entry, only the generic
// rules apply.
//
// Approach adapted from arg0WAK/theverge-paywall-remover (Zephr selectors,
// article-body restore), TurbulentGoat/universalPaywallBlocker and the
// FMCorz overlay gist (generic overlay and scroll-lock removal).

(() => {
    'use strict';

    const TAG = '[Soft Paywall Unlock]';
    const SWEEP_EVENT = 'soft-paywall-unlock:sweep';
    const RESULT_ATTR = 'data-soft-paywall-result';
    const HIDDEN_ATTR = 'data-soft-paywall-hidden';

    // A copy is already active (e.g. Greasemonkey in the page world while
    // `jseval` runs in its own world). DOM events cross worlds, so ask that
    // copy to sweep now and report what it did.
    const root = document.documentElement;
    if (root) {
        root.removeAttribute(RESULT_ATTR);
        document.dispatchEvent(new CustomEvent(SWEEP_EVENT));
        const answer = root.getAttribute(RESULT_ATTR);
        if (answer !== null) return answer;
    }

    const DEBUG = false;
    const log = (...args) => { if (DEBUG) console.log(TAG, ...args); };

    // Paywall vendor containers seen across publishers. Hidden with CSS so they
    // stay hidden however often the vendor script re-inserts them.
    const VENDOR_OVERLAYS = [
        // Zephr (The Verge and other Vox Media sites)
        '#zephr-overlay', '.zephr-overlay',
        '#zephr-footer-container', '.zephr-footer-container',
        '#zephr-zone-footer', '.zephr-zone-footer',
        '#zephr-inline-container',
        // Piano / Tinypass
        '.tp-modal', '.tp-backdrop', 'body > .tp-iframe-wrapper',
        // Poool
        '#poool-widget',
        // Google Funding Choices ad-block wall
        '.fc-ab-root',
        // Sourcepoint consent / pay-or-consent wall (The Guardian and others)
        'div[id^="sp_message_container_"]',
    ];

    const SITES = [{
        host: /(^|\.)theverge\.com$/,
        article: '.duet--article--article-body-component-container',
        // Zephr removes the article body paragraphs once the meter runs out.
        protect: {root: '#zephr-anchor', nodes: '.duet--article--article-body-component'},
        cleanup() {
            // Empty fade-out and click-blocking layers drawn over the article.
            let removed = 0;
            for (const el of document.querySelectorAll('#zephr-anchor div[style]')) {
                if (el.children.length || el.textContent.trim()) continue;
                const style = el.getAttribute('style') || '';
                const fullCover = /position:\s*absolute/.test(style) &&
                    /width:\s*100%/.test(style) && /height:\s*100%/.test(style);
                if (style.includes('linear-gradient') || fullCover) {
                    el.remove();
                    removed++;
                }
            }
            return removed;
        },
    }, {
        host: /(^|\.)theguardian\.com$/,
        article: '[data-gu-name="body"]',
        // The sign-in gate renders into #sign-in-gate (after the second
        // paragraph) and hides every article block that follows it.
        overlays: ['#sign-in-gate'],
        css: `
            [data-gu-name="body"] #sign-in-gate ~ :is(p, h2, h3, h4, ul, ol, blockquote, figure) {
                display: revert !important;
            }
        `,
    }];

    const site = SITES.find(s => s.host.test(location.hostname)) || {};
    const ARTICLE = [site.article, '[itemprop="articleBody"]', 'article', 'main'].filter(Boolean);
    const PAYWALL_TEXT = new RegExp([
        'subscri', 'sign[ -]?in', 'log[ -]?in', 'create (a |an )?(free )?account', 'register',
        'paywall', 'free (articles?|stor(y|ies))', 'already (a|an) (member|subscriber)',
        'unlock', 'continue reading', 'keep reading', 'membership',
    ].join('|'), 'i');

    const stats = {locks: 0, overlays: 0, unclipped: 0, restored: 0, removed: 0};

    // --- Scroll locks -------------------------------------------------------

    // Class-based locks (`body.modal-open { overflow: hidden }`) lose to this
    // rule's specificity; inline locks are undone in unlockRoot(). Body gets
    // `overflow-x: clip` rather than `hidden`: any value besides visible/clip
    // turns a `height: 100%` body into its own scroller and the window would
    // still not scroll.
    const CSS = `
        :is(html, body):not(#_):not(#_):not(#_) { overflow-y: visible !important; }
        body:not(#_):not(#_):not(#_) { overflow-x: clip !important; }
        ${[...VENDOR_OVERLAYS, ...(site.overlays || [])].join(',\n')} { display: none !important; }
        ${site.css || ''}
    `;
    const style = document.createElement('style');
    style.textContent = CSS;
    function ensureStyle() {
        if (style.isConnected) return;
        const parent = document.head || document.documentElement;
        if (parent) parent.appendChild(style);
    }

    function unlockRoot(el) {
        if (!el) return false;
        const s = el.style;
        let changed = false;
        for (const prop of ['overflow', 'overflow-y']) {
            if (/hidden|clip/.test(s.getPropertyValue(prop))) {
                s.removeProperty(prop);
                changed = true;
            }
        }
        // The `position: fixed; top: -<scroll>px` lock: put the page back where
        // the reader was.
        if (getComputedStyle(el).position === 'fixed') {
            const top = parseFloat(s.top) || 0;
            for (const prop of ['top', 'left', 'right', 'width']) s.removeProperty(prop);
            s.removeProperty('position');
            if (getComputedStyle(el).position === 'fixed') s.setProperty('position', 'static', 'important');
            if (top < 0) window.scrollTo(0, -top);
            changed = true;
        }
        if (s.getPropertyValue('touch-action') === 'none') {
            s.removeProperty('touch-action');
            changed = true;
        }
        if (el.hasAttribute('inert')) {
            el.removeAttribute('inert');
            changed = true;
        }
        if (changed) log('unlocked', el.tagName.toLowerCase());
        return changed;
    }

    // --- Article ------------------------------------------------------------

    function findArticle() {
        for (const selector of ARTICLE) {
            const el = document.querySelector(selector);
            if (el) return el;
        }
        return null;
    }

    // Undo clipping, blur and fade masks on the article and its ancestors (and
    // blur on its direct children, a common per-paragraph treatment).
    function unclip(article) {
        let changed = 0;
        const fix = (el, prop, value) => { el.style.setProperty(prop, value, 'important'); };
        for (let el = article; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
            const cs = getComputedStyle(el);
            if (/hidden|clip/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 50) {
                fix(el, 'overflow-y', 'visible');
                fix(el, 'max-height', 'none');
                fix(el, 'height', 'auto');
                changed++;
            }
            const mask = cs.maskImage || cs.webkitMaskImage;
            if (mask && mask !== 'none') {
                fix(el, 'mask-image', 'none');
                fix(el, '-webkit-mask-image', 'none');
                changed++;
            }
            if (cs.filter.includes('blur')) { fix(el, 'filter', 'none'); changed++; }
            if (el.inert) { el.inert = false; changed++; }
        }
        for (const child of article.children) {
            const cs = getComputedStyle(child);
            if (cs.filter.includes('blur')) { fix(child, 'filter', 'none'); changed++; }
            if (cs.userSelect === 'none') { fix(child, 'user-select', 'text'); changed++; }
        }
        return changed;
    }

    // Put back protected article nodes that a paywall script removed. A batch
    // that also adds protected nodes is treated as the site swapping content
    // (client-side navigation) and left alone.
    const restoreCounts = new WeakMap();
    function restoreProtected(records) {
        const p = site.protect;
        if (!p) return;
        const holds = n => n instanceof Element && (n.matches(p.nodes) || !!n.querySelector(p.nodes));
        const swapped = records.some(r => [...r.addedNodes].some(n =>
            holds(n) && n.isConnected && n.closest(p.root)));
        if (swapped) return;
        for (const r of records) {
            if (!r.removedNodes.length || !r.target.isConnected) continue;
            if (!(r.target instanceof Element) || !r.target.closest(p.root)) continue;
            const before = r.nextSibling && r.nextSibling.parentNode === r.target ? r.nextSibling : null;
            for (const node of r.removedNodes) {
                if (node.isConnected || !holds(node)) continue;
                const count = restoreCounts.get(node) || 0;
                if (count >= 3) continue; // stop fighting a script that keeps removing it
                restoreCounts.set(node, count + 1);
                r.target.insertBefore(node, before);
                stats.restored++;
                log('restored', node);
            }
        }
    }

    // --- Overlays -----------------------------------------------------------

    // Overlays found by shape are skipped right after the reader clicks or
    // types, so menus, lightboxes and dialogs they open stay usable.
    let lastInput = -Infinity;
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
        window.addEventListener(type, () => { lastInput = performance.now(); }, {capture: true, passive: true});
    }

    function isOverlay(el, article) {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed') return false;
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        if (article ? el.contains(article) : el.textContent.length > 3000) return false;
        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        if (rect.width < vw * 0.6) return false;
        const text = (el.innerText || '').trim();
        const gated = PAYWALL_TEXT.test(text);
        // A full-screen layer: either a paywall prompt or an empty backdrop.
        if (rect.height >= vh * 0.85) return gated || text.length < 20;
        // A paywall sheet pinned to the bottom of the screen.
        return gated && rect.bottom >= vh - 4 && rect.height >= vh * 0.2;
    }

    function hideOverlays(article) {
        const vw = window.innerWidth, vh = window.innerHeight;
        const points = [[vw / 2, vh / 2], [vw / 2, vh * 0.9], [vw * 0.15, vh / 2]];
        const seen = new Set();
        let hidden = 0;
        for (const [x, y] of points) {
            for (const hit of document.elementsFromPoint(x, y)) {
                for (let el = hit; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
                    if (seen.has(el)) break;
                    seen.add(el);
                    if (getComputedStyle(el).position !== 'fixed') continue;
                    if (isOverlay(el, article)) {
                        if (el instanceof HTMLDialogElement && el.open) el.close();
                        el.style.setProperty('display', 'none', 'important');
                        el.setAttribute(HIDDEN_ATTR, '');
                        hidden++;
                        log('hid overlay', el);
                    }
                    break; // only the outermost fixed layer around each hit matters
                }
            }
        }
        return hidden;
    }

    // --- Sweep --------------------------------------------------------------

    function sweep(force) {
        ensureStyle();
        if (unlockRoot(document.documentElement)) stats.locks++;
        if (unlockRoot(document.body)) stats.locks++;
        if (!document.body) return summary();
        if (site.cleanup) stats.removed += site.cleanup();
        const article = findArticle();
        if (force || performance.now() - lastInput > 1500) stats.overlays += hideOverlays(article);
        if (article) stats.unclipped += unclip(article);
        return summary();
    }

    function summary() {
        const parts = [
            stats.overlays && `${stats.overlays} overlay(s) hidden`,
            stats.locks && `${stats.locks} scroll lock(s) undone`,
            stats.unclipped && `${stats.unclipped} clip/blur style(s) undone`,
            stats.restored && `${stats.restored} article block(s) restored`,
            stats.removed && `${stats.removed} fade layer(s) removed`,
        ].filter(Boolean);
        return `Soft paywall: ${parts.length ? parts.join(', ') : 'nothing to undo yet'}`;
    }

    // Coalesce DOM churn into at most one sweep per 200 ms.
    let timer = 0, lastSweep = 0;
    function schedule() {
        if (timer) return;
        const wait = Math.max(0, 200 - (performance.now() - lastSweep));
        timer = setTimeout(() => {
            timer = 0;
            lastSweep = performance.now();
            sweep(false);
        }, wait);
    }

    // Locks applied to <html>/<body> are undone before the next paint.
    const rootObserver = new MutationObserver(() => {
        unlockRoot(document.documentElement) && stats.locks++;
        unlockRoot(document.body) && stats.locks++;
        schedule();
    });
    const watched = new Set();
    function watchRoots() {
        for (const el of [document.documentElement, document.body]) {
            if (!el || watched.has(el)) continue;
            watched.add(el);
            rootObserver.observe(el, {attributes: true, attributeFilter: ['style', 'class', 'inert']});
        }
    }

    new MutationObserver(records => {
        watchRoots();
        restoreProtected(records);
        schedule();
    }).observe(document, {childList: true, subtree: true});

    document.addEventListener(SWEEP_EVENT, () => {
        document.documentElement.setAttribute(RESULT_ATTR, sweep(true));
    });

    // Overlays shown by toggling a class trigger no DOM insertion; recheck a
    // few times while the paywall script settles.
    window.addEventListener('load', schedule);
    for (const delay of [1000, 3000, 8000]) setTimeout(schedule, delay);

    watchRoots();
    log('active', site.host ? `site rules for ${site.host}` : 'generic rules only');
    return sweep(true);
})();
