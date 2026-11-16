// ==UserScript==
// @name Twitch Volume Wheel
// @version 1.5
// @description Scroll over the volume slider or mute button to change volume.
// @match https://www.twitch.tv/*
// @match https://player.twitch.tv/*
// @grant none
// @run-at document-start
// ==/UserScript==

(() => {
    const DEBUG = false;
    const STEP = 0.01;
    const SLIDER = 'input[data-a-target="player-volume-slider"]';
    const SLIDER_BOX = '.volume-slider__slider-container';
    const MUTE = 'button[data-a-target="player-mute-unmute-button"]';
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

    const TAG = '[Twitch Volume Wheel]';
    const log = (...args) => { if (DEBUG) console.log(TAG, ...args); };
    const warn = (...args) => console.warn(TAG, ...args);

    function describe(el) {
        if (!el) return null;
        const target = el.getAttribute && el.getAttribute('data-a-target');
        const cls = typeof el.className === 'string' ? el.className.split(' ').slice(0, 3).join('.') : '';
        return `${el.tagName.toLowerCase()}${target ? `[${target}]` : ''}${cls ? `.${cls}` : ''}`;
    }

    function readStorage(key) {
        try { return localStorage.getItem(key); } catch (e) { return `<error: ${e.message}>`; }
    }

    // Everything that could disagree about the volume, in one place.
    function snapshot(player, scope) {
        const slider = scope.querySelector(SLIDER);
        const button = scope.querySelector(MUTE);
        const video = document.querySelector('video');
        const call = name => {
            try { return typeof player?.[name] === 'function' ? player[name]() : '<n/a>'; }
            catch (e) { return `<error: ${e.message}>`; }
        };
        return {
            playerVolume: call('getVolume'),
            playerMuted: call('isMuted'),
            sliderValue: slider ? slider.value : null,
            sliderAriaNow: slider ? slider.getAttribute('aria-valuenow') : null,
            muteButtonLabel: button ? button.getAttribute('aria-label') : null,
            videoVolume: video ? video.volume : null,
            videoMuted: video ? video.muted : null,
            storedVolume: readStorage('volume'),
            storedMuted: readStorage('video-muted'),
        };
    }

    function overVolumeControl(target) {
        return !!target.closest(`${SLIDER}, ${SLIDER_BOX}, ${MUTE}`);
    }

    // Twitch keeps volume state in its media player, not the <input>. Driving
    // the player directly keeps the % label and the saved volume in sync.
    function findPlayer(from) {
        const root = from.closest('.video-player, [data-a-target="video-player"]') ||
            document.querySelector('.video-player');
        if (!root) { warn('no .video-player element found'); return null; }
        const key = Object.keys(root).find(k => k.startsWith('__reactFiber$') ||
            k.startsWith('__reactInternalInstance$'));
        if (!key) { warn('no React fiber key on', describe(root)); return null; }
        let depth = 0;
        for (let node = root[key]; node; node = node.return, depth++) {
            const player = node.memoizedProps && node.memoizedProps.mediaPlayerInstance;
            if (player) {
                const resolved = player.core || player;
                log(`player found ${depth} fiber levels up`, player.core ? '(using .core)' : '(no .core)',
                    'methods:', ['getVolume', 'setVolume', 'isMuted', 'setMuted']
                        .filter(m => typeof resolved[m] === 'function').join(', '));
                return resolved;
            }
        }
        warn(`no mediaPlayerInstance in ${depth} fiber levels above`, describe(root));
        return null;
    }

    document.addEventListener('wheel', event => {
        if (!(event.target instanceof Element) || event.deltaY === 0) return;
        if (!overVolumeControl(event.target)) return;
        log('wheel on', describe(event.target), 'deltaY', event.deltaY);

        const player = findPlayer(event.target);
        if (!player || typeof player.setVolume !== 'function') {
            warn('no usable player, letting the event through');
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const scope = event.target.closest('.player-controls, .video-player') || document;
        log('before', snapshot(player, scope));

        const muted = typeof player.isMuted === 'function' && player.isMuted();
        const current = muted ? 0 : player.getVolume();
        const next = Math.round(Math.min(1, Math.max(0, current + (event.deltaY < 0 ? STEP : -STEP))) * 100) / 100;
        log(`volume ${current} -> ${next}`, muted ? '(was muted)' : '');

        // Toggle mute through Twitch's own button: player.setMuted() changes the
        // audio but not Twitch's UI state, so it would not stick.
        const muteButton = scope.querySelector(MUTE);
        if (muted !== (next === 0)) {
            if (muteButton) {
                log(`clicking mute button to ${next === 0 ? 'mute' : 'unmute'}`,
                    `(label: ${muteButton.getAttribute('aria-label')})`);
                muteButton.click();
                log('after click', snapshot(player, scope));
            } else {
                warn('mute state needs to change but no mute button found');
            }
        }

        player.setVolume(next);
        log('after setVolume', snapshot(player, scope));

        // Mirror the value onto the slider so Twitch shows its % tooltip; the
        // player already holds the same value, so the two stay in agreement.
        const slider = scope.querySelector(SLIDER);
        if (slider) {
            setValue.call(slider, String(next));
            slider.dispatchEvent(new Event('input', {bubbles: true}));
            slider.dispatchEvent(new Event('change', {bubbles: true}));
            log('after slider events', snapshot(player, scope));
        } else {
            warn('no slider found to mirror the value onto');
        }

        // Twitch may react asynchronously; see where things settle.
        setTimeout(() => log('settled (250ms)', snapshot(player, scope)), 250);
    }, {capture: true, passive: false});

    log('loaded', {url: location.href, readyState: document.readyState,
        storedVolume: readStorage('volume'), storedMuted: readStorage('video-muted')});
})();
