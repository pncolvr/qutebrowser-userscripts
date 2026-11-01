// ==UserScript==
// @name Twitch Auto Channel Points Claimer
// @version 1.6
// @author PartMent
// @description Automatically claim channel points.
// @match https://www.twitch.tv/*
// @match https://dashboard.twitch.tv/*
// @license MIT
// @grant none
// @namespace https://greasyfork.org/users/310437
// ==/UserScript==

let MutationObserver = window.MutationObserver || window.WebKitMutationObserver || window.MozMutationObserver;
let claiming = false;
if (MutationObserver) console.info('[Twitch Channel Points] Enabled — watching for claimable bonuses.');
let observer = new MutationObserver(e => {
    let bonus = document.querySelector('.claimable-bonus__icon');
    if (bonus && !claiming) {
        bonus.click();
        let date = new Date();
        claiming = true;
        setTimeout(() => {
            console.log('Claimed at '+date);
            claiming = false;
        }, Math.random() * 1000 + 2000);
    }
    updateTwitchChatToggle();
});
observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'data-a-target']
});

let twitchChatPointer = null;
const twitchChatToggleSelector = '[data-a-target*="right-column__toggle"], button[aria-label="Collapse Chat"], button[aria-label="Expand Chat"]';

function updateTwitchChatToggle() {
    document.querySelectorAll(twitchChatToggleSelector).forEach(toggle => {
        const rect = toggle.getBoundingClientRect();
        const margin = 32;
        const near = twitchChatPointer && rect.width > 0 && rect.height > 0 &&
            twitchChatPointer.x >= rect.left - margin && twitchChatPointer.x <= rect.right + margin &&
            twitchChatPointer.y >= rect.top - margin && twitchChatPointer.y <= rect.bottom + margin;
        toggle.dataset.visible = String(!!near);
    });
}

const syncPointer = event => {
    twitchChatPointer = {x: event.clientX, y: event.clientY};
    updateTwitchChatToggle();
};

document.addEventListener('pointermove', syncPointer, {capture: true, passive: true});
document.addEventListener('pointerdown', syncPointer, {capture: true, passive: true});

const clearTwitchChatPointer = () => {
    twitchChatPointer = null;
    updateTwitchChatToggle();
};

document.addEventListener('pointerout', event => {
    if (!event.relatedTarget) clearTwitchChatPointer();
}, true);

window.addEventListener('blur', clearTwitchChatPointer);
document.addEventListener('mouseleave', clearTwitchChatPointer, {capture: true});
document.addEventListener('focusin', updateTwitchChatToggle, true);
document.addEventListener('focusout', updateTwitchChatToggle, true);
updateTwitchChatToggle();

Object.defineProperty(document, "hidden", {value: false});
