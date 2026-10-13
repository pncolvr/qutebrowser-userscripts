// ==UserScript==
// @name         nexusmods auto slow download
// @namespace    https://www.nexusmods.com/
// @version      1.5
// @description  Auto-click "Slow download" (and follow-up confirmations) on Nexus Mods, then close the tab after a cancelable countdown
// @author       pncolvr
// @match        https://www.nexusmods.com/*/mods/*
// @grant        none
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const TAG = '[nexus-slow-download]';
    const log = (...args) => console.log(TAG, ...args);

    // Close the tab after a download is triggered. Requires
    // `content.javascript.can_close_tabs` to be enabled for nexusmods.com
    // (set in config.py); otherwise window.close() is ignored. On the last tab,
    // qutebrowser's `tabs.last_close` decides what happens (default `ignore`
    // means the tab simply stays open).
    const CLOSE_AFTER_DOWNLOAD = true;
    // Countdown length (ms) shown before the tab closes, giving the download
    // request time to fire. Bump this up if downloads get cut off.
    const CLOSE_DELAY_MS = 5000;

    // Buttons we've already clicked, so re-checks don't click the same one
    // twice while still allowing a fresh click on each new dialog.
    const clickedButtons = new WeakSet();

    // Visible labels of buttons to auto-click, matched case-insensitively.
    // These are Nexus `nxm-button`s (see selector in findAutoClickButtons).
    //
    //   'slow download' -> the free download button in the Fast/Slow modal.
    //   'standard download' -> confirm button on the ">500MB, download this
    //                          large file" dialog. The other option there,
    //                          "Resumable download (Beta)", is left alone on
    //                          purpose so we get the same plain download as
    //                          smaller files.
    const AUTO_CLICK_LABELS = new Set([
        'slow download',
        'standard download',
    ]);

    log('loaded on', location.href);

    // The download modal (#upsell-cards) is rendered inside a web component's
    // open shadow DOM, which document.querySelectorAll does NOT cross. Walk the
    // light DOM and recurse into every open shadowRoot we find.
    function deepQueryAll(selector, root = document, out = []) {
        for (const el of root.querySelectorAll('*')) {
            if (el.matches(selector)) out.push(el);
            if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, out);
        }
        return out;
    }

    function labelOf(el) {
        return el.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
    }

    // Several buttons share the `nxm-button` class (e.g. the premium "Fast
    // download"), so we match on the exact visible label, not the class alone.
    function findAutoClickButtons() {
        return deepQueryAll('button.nxm-button, a.nxm-button')
            .filter((el) => AUTO_CLICK_LABELS.has(labelOf(el)));
    }

    // After the final download click, show a countdown overlay and close the
    // tab when it hits zero. A genuine click anywhere aborts it. Debounced:
    // each new auto-click resets the countdown, so the large-file "Standard
    // download" step pushes it back instead of firing between the two dialogs.
    let closeInterval = null;
    let closeOverlay = null;

    function cancelClose() {
        if (closeInterval) { clearInterval(closeInterval); closeInterval = null; }
        if (closeOverlay) { closeOverlay.remove(); closeOverlay = null; }
    }

    function scheduleClose() {
        if (!CLOSE_AFTER_DOWNLOAD) return;
        cancelClose();

        let remaining = Math.ceil(CLOSE_DELAY_MS / 1000);

        const overlay = document.createElement('div');
        // pointer-events:none so the overlay never blocks the page; the
        // document-level click handler below is what cancels.
        overlay.style.cssText = [
            'position:fixed', 'bottom:16px', 'right:16px', 'z-index:2147483647',
            'padding:12px 16px', 'border-radius:8px',
            'background:#1e1e1e', 'color:#fff', 'font:14px/1.4 sans-serif',
            'box-shadow:0 4px 16px rgba(0,0,0,.5)', 'pointer-events:none',
        ].join(';');
        (document.body || document.documentElement).appendChild(overlay);
        closeOverlay = overlay;

        const render = () => {
            overlay.textContent =
                `Closing tab in ${remaining}s - click to cancel`;
        };
        render();

        closeInterval = setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
                cancelClose();
                log('closing tab (download should have started)');
                window.close();
                return;
            }
            render();
        }, 1000);
    }

    // A genuine click anywhere cancels the pending close. isTrusted filters out
    // our own programmatic download-button clicks (and any other synthetic
    // clicks), so starting the download doesn't immediately cancel the close.
    document.addEventListener('click', (e) => {
        if (e.isTrusted && closeOverlay) {
            log('tab close cancelled (click)');
            cancelClose();
        }
    }, true);

    function tryClick() {
        let clicked = false;
        for (const btn of findAutoClickButtons()) {
            if (clickedButtons.has(btn)) continue;
            clickedButtons.add(btn);
            log('clicking button:', labelOf(btn));
            btn.click();
            clicked = true;
        }
        if (clicked) scheduleClose();
    }

    // Try right away in case a dialog is already open.
    tryClick();

    // Light-DOM changes (a dialog's host element being inserted) fire here.
    // Debounce so a busy page doesn't trigger a deep walk on every mutation.
    let scheduled = false;
    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => { scheduled = false; tryClick(); }, 200);
    };
    new MutationObserver(schedule).observe(document.documentElement, {
        childList: true,
        subtree: true,
    });

    // Renders that happen *inside* a shadow root don't reach the observer above,
    // and dialogs open on demand, so poll as a reliable fallback.
    setInterval(tryClick, 1000);
})();
