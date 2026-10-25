// ==UserScript==
// @name         Quickshell scrollbars
// @description  Native page scrolling with themed thumbs and delayed fading.
// @match        *://*/*
// @match        file:///*
// @run-at       document-end
// @qute-js-world application
// @grant        none
// ==/UserScript==

(() => {
    'use strict';
    // Keep aligned with Quickshell's Theme.qml and the browser's scrollbars.css.
    const GUTTER = 20, MINIMUM = 24, HOLD = 450;
    const managed = 'data-qute-scrollbar-managed';
    const rootAttribute = 'data-qute-scrollbar-root';
    const hostAttribute = 'data-qute-scrollbar-host';
    if (!document.documentElement || document.querySelector(`[${hostAttribute}]`)) return;

    const host = document.createElement('div');
    host.setAttribute(hostAttribute, '');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;'
        + 'pointer-events:none!important;z-index:2147483647!important;';
    const shadow = host.attachShadow({mode: 'open'});
    const style = document.createElement('style');
    style.textContent = `
        :host { color-scheme: normal; }
        .track { position:fixed; pointer-events:auto; touch-action:none; user-select:none; }
        .track[hidden] { display:none; }
        .thumb { position:absolute; background:#6b8fb3; border-radius:3px; opacity:0;
            cursor:grab; transition:opacity 200ms linear; }
        .track[data-visible] .thumb { opacity:1; transition-duration:0ms; }
        .vertical .thumb { width:6px; left:50%; top:0; transform:translateX(-50%);
            transition:opacity 200ms linear,width 120ms cubic-bezier(.215,.61,.355,1); }
        .horizontal .thumb { height:6px; top:50%; left:0; transform:translateY(-50%);
            transition:opacity 200ms linear,height 120ms cubic-bezier(.215,.61,.355,1); }
        .track[data-visible].vertical .thumb { transition-duration:0ms,120ms; }
        .track[data-visible].horizontal .thumb { transition-duration:0ms,120ms; }
        .vertical:has(.thumb:hover) .thumb, .vertical[data-dragging] .thumb { width:10px; }
        .horizontal:has(.thumb:hover) .thumb, .horizontal[data-dragging] .thumb { height:10px; }
        .track[data-dragging], .track[data-dragging] .thumb { cursor:grabbing; }
        @media (prefers-reduced-motion:reduce) { .track .thumb { transition:none!important; } }
        @media print { .track { display:none; } }
    `;
    shadow.append(style);
    document.documentElement.append(host);

    const controllers = new Map(), tracks = new WeakMap();
    let pending = false, hovered = new Set(), hoverTarget;
    const discoveries = new Set();
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const parentOf = node => node.parentElement || node.getRootNode()?.host;
    const isRoot = element => element === document.scrollingElement;

    // Geometry reads for every visible controller happen before any style
    // writes. Ordinary page wheel events remain on Chromium's native path.
    function schedule() {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            if (!host.isConnected) document.documentElement.append(host);
            if (componentsDirty) refreshSiteOwners();
            for (const [element, observer] of authorObservers) if (!element.isConnected) {
                observer.disconnect(); authorObservers.delete(element);
            }
            discover(document.scrollingElement);
            for (const element of discoveries) discover(element);
            discoveries.clear();
            if (hoverTarget !== undefined) { applyHover(hoverTarget); hoverTarget = undefined; }
            const measurements = [];
            for (const controller of controllers.values()) {
                if (!controller.element.isConnected || siteProvidesScrollbar(controller.element)) controller.destroy();
                else measurements.push([controller, controller.measure()]);
            }
            for (const [controller, measurement] of measurements) controller.render(measurement);
            pending = false;
        });
    }

    function styles(element, values) {
        for (const [property, value] of Object.entries(values))
            if (element.style[property] !== value) element.style[property] = value;
    }

    const intersection = new IntersectionObserver(entries => {
        for (const entry of entries) {
            const controller = controllers.get(entry.target);
            if (controller && controller.inView !== entry.isIntersecting) {
                controller.inView = entry.isIntersecting;
                schedule();
            }
        }
    });

    // Author-owned scrollbars take precedence. Check computed native styling
    // before adding our markers; cross-origin stylesheets need no CSSOM access.
    const componentHosts = '[data-simplebar],[data-overlayscrollbars],[data-overlayscrollbars-viewport],'
        + '[data-scrollbar],.os-host,.os-viewport,.ps,.mCustomScrollbar,.mCustomScrollBox,.ss-container,.jspScrollable';
    const componentBars = '[role="scrollbar"],.simplebar-track,.os-scrollbar,.ps__rail-x,.ps__rail-y,'
        + '.scrollbar-track,.scrollbar__track,.scrollbar,#scrollbar,.nicescroll-rails,.c-scrollbar,.ss-scroll,.mCSB_scrollTools,.jspVerticalBar,.jspHorizontalBar';
    const siteBars = new Set(), siteOwners = new Set(), nativeCache = new WeakMap();
    const barObservers = new WeakMap(), authorObservers = new Map();
    let styleVersion = 0, componentsDirty = true;

    function authorSignature(element) {
        // Ignore unrelated inline animation/progress updates. Stylesheet and
        // class changes cover pseudo-element rules; these are the native
        // scrollbar properties an author can set directly on the viewport.
        return element.className + '|' + ['scrollbar-color', 'scrollbar-width']
            .map(property => `${property}:${element.style.getPropertyValue(property)}:${element.style.getPropertyPriority(property)}`).join(';');
    }
    function watchAuthorStyle(element) {
        if (!element || authorObservers.has(element)) return;
        let signature = authorSignature(element);
        const observer = new MutationObserver(() => {
            const next = authorSignature(element);
            if (next === signature) return;
            signature = next;
            styleVersion++;
            componentsDirty = true;
            schedule();
        });
        observer.observe(element, {attributes: true, attributeFilter: ['class', 'style']});
        authorObservers.set(element, observer);
    }
    function stylesheetChanged() {
        styleVersion++;
        componentsDirty = true;
        schedule();
    }
    function registerSiteBars(node) {
        if (!(node instanceof Element) || node === host) return;
        const matches = [...(node.matches(componentBars) ? [node] : []), ...node.querySelectorAll(componentBars)];
        for (const bar of matches) {
            if (siteBars.has(bar)) continue;
            siteBars.add(bar);
            const observer = new MutationObserver(() => { componentsDirty = true; schedule(); });
            observer.observe(bar, {attributes: true, attributeFilter: ['class', 'hidden', 'aria-controls']});
            barObservers.set(bar, observer);
            componentsDirty = true;
        }
    }
    function refreshSiteOwners() {
        componentsDirty = false;
        siteOwners.clear();
        const root = document.scrollingElement;
        for (const bar of siteBars) {
            if (!bar.isConnected || !bar.matches(componentBars)) {
                siteBars.delete(bar);
                barObservers.get(bar)?.disconnect();
                continue;
            }
            const controlled = (bar.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
            if (controlled.length) {
                for (const id of controlled) {
                    const owner = document.getElementById(id);
                    if (owner) siteOwners.add(owner === document.body ? root : owner);
                }
                continue;
            }
            const component = bar.closest(componentHosts);
            if (component) {
                if (component === document.body || component === document.documentElement) siteOwners.add(root);
                // Nested component ownership is checked through closest() below.
                continue;
            }
            const rect = bar.getBoundingClientRect();
            const thin = (rect.width > 0 && rect.width <= 48 && rect.height >= 80)
                || (rect.height > 0 && rect.height <= 48 && rect.width >= 80);
            if (!thin) continue; // A carousel or a container named "scrollbar" is not a page scrollbar.
            let owner;
            for (let parent = bar.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
                const css = getComputedStyle(parent);
                if (/auto|scroll/.test(`${css.overflowX} ${css.overflowY}`)) { owner = parent; break; }
            }
            if (owner) siteOwners.add(owner);
            else {
                const css = getComputedStyle(bar);
                const viewportSized = (rect.height >= innerHeight / 2 && rect.width <= 48)
                    || (rect.width >= innerWidth / 2 && rect.height <= 48);
                if (viewportSized && ['fixed', 'absolute'].includes(css.position)
                    && (bar.parentElement === document.body || bar.parentElement === document.documentElement || css.position === 'fixed')) siteOwners.add(root);
            }
        }
    }
    function painted(css) {
        return (css.backgroundColor && !['transparent', 'rgba(0, 0, 0, 0)'].includes(css.backgroundColor))
            || (css.backgroundImage && css.backgroundImage !== 'none') || (css.boxShadow && css.boxShadow !== 'none')
            || parseFloat(css.borderTopWidth) > 0 || parseFloat(css.borderTopLeftRadius) > 0;
    }
    function styledNativeScrollbar(element) {
        const cached = nativeCache.get(element);
        if (cached?.version === styleVersion) return cached.owned;
        // Temporarily remove only our selectors when rechecking a managed box.
        // This runs on author-style changes, never on each scroll frame.
        const markers = [managed, rootAttribute].filter(attribute => element.hasAttribute(attribute));
        for (const attribute of markers) element.removeAttribute(attribute);
        let owned;
        try {
            const css = getComputedStyle(element);
            owned = (css.scrollbarColor && css.scrollbarColor !== 'auto') || (css.scrollbarWidth && css.scrollbarWidth !== 'auto');
            if (!owned) {
                const bar = getComputedStyle(element, '::-webkit-scrollbar');
                owned = bar.display === 'none' || (bar.width && bar.width !== 'auto') || (bar.height && bar.height !== 'auto') || painted(bar)
                    || painted(getComputedStyle(element, '::-webkit-scrollbar-thumb'))
                    || painted(getComputedStyle(element, '::-webkit-scrollbar-track'));
            }
        } finally {
            for (const attribute of markers) element.setAttribute(attribute, '');
        }
        nativeCache.set(element, {version: styleVersion, owned});
        return owned;
    }
    function siteProvidesScrollbar(element) {
        return siteOwners.has(element) || element.closest(componentHosts) !== null
            || (isRoot(element) && document.body?.matches(componentHosts))
            || styledNativeScrollbar(element)
            || (isRoot(element) && document.body && styledNativeScrollbar(document.body));
    }

    class Axis {
        constructor(controller, vertical) {
            Object.assign(this, {controller, vertical, hover: false, drag: null, timer: null});
            this.track = document.createElement('div');
            this.track.className = `track ${vertical ? 'vertical' : 'horizontal'}`;
            this.track.hidden = true;
            this.thumb = document.createElement('div');
            this.thumb.className = 'thumb';
            this.track.append(this.thumb);
            shadow.append(this.track);
            tracks.set(this.track, controller);
            this.lastPosition = NaN;
            this.track.addEventListener('pointerenter', () => { this.hover = true; this.reveal(); });
            this.track.addEventListener('pointerleave', () => { this.hover = false; this.hold(); });
            this.track.addEventListener('pointerdown', event => this.press(event));
            this.track.addEventListener('pointermove', event => this.move(event));
            for (const name of ['pointerup', 'lostpointercapture', 'pointercancel'])
                this.track.addEventListener(name, () => this.release());
            this.track.addEventListener('wheel', event => wheelOnTrack(event, controller.element), {passive: false});
        }
        get position() {
            return this.vertical ? this.controller.element.scrollTop : this.controller.element.scrollLeft;
        }
        set position(value) {
            this.controller.element.scrollTo(this.vertical
                ? {top: value, behavior: 'instant'} : {left: value, behavior: 'instant'});
        }
        reveal() {
            clearTimeout(this.timer);
            this.track.setAttribute('data-visible', '');
        }
        hold() {
            this.reveal();
            this.timer = setTimeout(() => {
                if (!this.hover && !this.drag)
                    this.track.removeAttribute('data-visible');
            }, HOLD);
        }
        update(rect, clip, needed, extent, viewport, scale, rtl, current) {
            const hidden = !needed || viewport <= 0;
            if (this.track.hidden !== hidden) this.track.hidden = hidden;
            if (this.track.hidden) return;
            this.maximum = Math.max(0, extent - viewport);
            this.minimum = !this.vertical && rtl ? -this.maximum : 0;
            this.length = this.vertical ? rect.height : rect.width;
            this.thumbLength = Math.min(this.length, Math.max(MINIMUM * scale, this.length * viewport / extent));
            const position = clamp((current - this.minimum) / (this.maximum || 1), 0, 1);
            this.travel = this.length - this.thumbLength;
            styles(this.track, {
                left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
                clipPath: `inset(${Math.max(0, clip.top - rect.top)}px ${Math.max(0, rect.right - clip.right)}px ${Math.max(0, rect.bottom - clip.bottom)}px ${Math.max(0, clip.left - rect.left)}px)`,
            });
            styles(this.thumb, this.vertical ? {
                height: `${this.thumbLength}px`, transform: `translate3d(-50%,${position * this.travel}px,0)`,
            } : {
                width: `${this.thumbLength}px`, transform: `translate3d(${position * this.travel}px,-50%,0)`,
            });
            if (current !== this.lastPosition) this.hold();
            this.lastPosition = current;
        }

        press(event) {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            this.controller.update();
            const rect = this.track.getBoundingClientRect(), thumb = this.thumb.getBoundingClientRect();
            const onThumb = event.target === this.thumb;
            this.drag = {offset: onThumb ? (this.vertical ? event.clientY - thumb.top : event.clientX - thumb.left) : this.thumbLength / 2};
            this.track.setPointerCapture(event.pointerId);
            this.track.setAttribute('data-dragging', '');
            this.reveal();
            if (!onThumb) this.seek(this.vertical ? event.clientY - rect.top : event.clientX - rect.left);
        }
        seek(point) {
            const ratio = this.travel > 0 ? clamp((point - this.drag.offset) / this.travel, 0, 1) : 0;
            this.position = this.minimum + ratio * this.maximum;
            schedule();
        }
        move(event) {
            if (!this.drag) return;
            const rect = this.track.getBoundingClientRect();
            this.seek(this.vertical ? event.clientY - rect.top : event.clientX - rect.left);
        }
        release() {
            if (!this.drag) return;
            this.drag = null;
            this.track.removeAttribute('data-dragging');
            this.hold();
        }
        destroy() { clearTimeout(this.timer); this.track.remove(); }
    }

    class Controller {
        constructor(element) {
            this.element = element;
            this.hover = false;
            this.inView = true;
            if (!isRoot(element)) intersection.observe(element);
            if (isRoot(element)) {
                const original = getComputedStyle(element);
                for (const edge of ['left', 'right', 'bottom'])
                    element.style.setProperty(`--qute-scrollbar-padding-${edge}`, original.getPropertyValue(`padding-${edge}`));
                element.setAttribute(rootAttribute, '');
            }
            element.setAttribute(managed, '');
            watchAuthorStyle(element);
            this.vertical = new Axis(this, true);
            this.horizontal = new Axis(this, false);
            this.resize = new ResizeObserver(schedule);
            this.resize.observe(element);
            this.content = isRoot(element) ? document.body : element.firstElementChild;
            if (this.content) this.resize.observe(this.content);
        }
        setHover(value) {
            if (this.hover === value) return;
            this.hover = value;
            for (const axis of [this.vertical, this.horizontal]) {
                axis.hold();
            }
        }
        update() { this.render(this.measure()); }
        measure() {
            if (!this.inView) return null;
            const element = this.element, root = isRoot(element), css = getComputedStyle(element);
            const content = root ? document.body : element.firstElementChild;
            if (this.content !== content) {
                if (this.content) this.resize.unobserve(this.content);
                this.content = content;
                if (this.content) this.resize.observe(this.content);
            }
            const rect = root ? {left: 0, top: 0, width: innerWidth, height: innerHeight} : element.getBoundingClientRect();
            const sx = root ? 1 : rect.width / (element.offsetWidth || 1);
            const sy = root ? 1 : rect.height / (element.offsetHeight || 1);
            const width = element.clientWidth, height = element.clientHeight;
            const left = rect.left + (root ? 0 : element.clientLeft * sx);
            const top = rect.top + (root ? 0 : element.clientTop * sy);
            const clip = {left: 0, top: 0, right: innerWidth, bottom: innerHeight};
            // Respect clipping by enclosing scroll areas and hidden/clip boxes.
            if (!root) for (let parent = parentOf(element); parent && !isRoot(parent); parent = parentOf(parent)) {
                const pc = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
                if (pc.overflowX !== 'visible') {
                    clip.left = Math.max(clip.left, bounds.left + parent.clientLeft);
                    clip.right = Math.min(clip.right, bounds.left + parent.clientLeft + parent.clientWidth);
                }
                if (pc.overflowY !== 'visible') {
                    clip.top = Math.max(clip.top, bounds.top + parent.clientTop);
                    clip.bottom = Math.min(clip.bottom, bounds.top + parent.clientTop + parent.clientHeight);
                }
            }
            const rtl = css.direction === 'rtl';
            const vertical = element.scrollHeight > height + 1 && (root ? !['hidden', 'clip'].includes(css.overflowY) : /^(auto|scroll)$/.test(css.overflowY));
            const horizontal = element.scrollWidth > width + 1 && (root ? !['hidden', 'clip'].includes(css.overflowX) : /^(auto|scroll)$/.test(css.overflowX));
            const vx = rtl ? rect.left + (root ? 0 : parseFloat(css.borderLeftWidth) * sx)
                : left + (root ? width - GUTTER : width) * sx;
            const trackHeight = root ? height - (horizontal ? GUTTER : 0) : height;
            const trackWidth = root ? width - (vertical ? GUTTER : 0) : width;
            const hx = root && rtl && vertical ? left + GUTTER : left;
            return {
                root, rtl, vertical, horizontal, clip, height: trackHeight, width: trackWidth, sx, sy,
                vrect: new DOMRect(vx, top, GUTTER * sx, trackHeight * sy),
                hrect: new DOMRect(hx, top + (root ? height - GUTTER : height) * sy, trackWidth * sx, GUTTER * sy),
                extentY: element.scrollHeight - (root && horizontal ? GUTTER : 0),
                extentX: element.scrollWidth - (root && vertical ? GUTTER : 0),
                top: element.scrollTop, left: element.scrollLeft,
                drawn: rect.width > 0 && rect.height > 0,
            };
        }
        render(layout) {
            if (!layout) {
                if (!this.vertical.track.hidden) this.vertical.track.hidden = true;
                if (!this.horizontal.track.hidden) this.horizontal.track.hidden = true;
                return;
            }
            const {root, rtl, vertical, horizontal, clip, height, width, sx, sy} = layout;
            if (root) {
                for (const [edge, needed] of [['left', vertical && rtl], ['right', vertical && !rtl], ['bottom', horizontal]]) {
                    const property = `--qute-scrollbar-gutter-${edge}`, value = needed ? `${GUTTER}px` : '0px';
                    if (this.element.style.getPropertyValue(property) !== value) this.element.style.setProperty(property, value);
                }
            }
            this.vertical.update(layout.vrect, clip, vertical && layout.drawn,
                layout.extentY, height, sy, false, layout.top);
            this.horizontal.update(layout.hrect, clip, horizontal && layout.drawn,
                layout.extentX, width, sx, rtl, layout.left);
        }

        destroy() {
            this.resize.disconnect();
            intersection.unobserve(this.element);
            this.vertical.destroy(); this.horizontal.destroy();
            const root = this.element.hasAttribute(rootAttribute);
            this.element.removeAttribute(managed);
            this.element.removeAttribute(rootAttribute);
            if (root) for (const edge of ['left', 'right', 'bottom']) {
                this.element.style.removeProperty(`--qute-scrollbar-padding-${edge}`);
                this.element.style.removeProperty(`--qute-scrollbar-gutter-${edge}`);
            }
            if (!this.element.isConnected) {
                authorObservers.get(this.element)?.disconnect();
                authorObservers.delete(this.element);
            }
            controllers.delete(this.element);
            hovered.delete(this);
        }
    }

    function discover(element) {
        if (!(element instanceof HTMLElement) || element === host || host.contains(element)) return;
        if (controllers.has(element)) return controllers.get(element);
        // Shadow roots retain native controls: the global stylesheet cannot style them.
        if (element.getRootNode() !== document) return;
        const root = isRoot(element);
        if (!root && element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1) return;
        const css = getComputedStyle(element);
        if (!root && !/auto|scroll/.test(`${css.overflowX} ${css.overflowY}`)) return;
        watchAuthorStyle(element);
        if (siteProvidesScrollbar(element)) return;
        const controller = new Controller(element);
        controllers.set(element, controller);
        if (element.matches(':hover')) controller.setHover(true);
        schedule();
        return controller;
    }

    function updateHover(event) {
        let target = event.composedPath().find(node => tracks.has(node));
        hoverTarget = event.type === 'pointerout' && !event.relatedTarget ? null
            : target ? tracks.get(target).element : event.target;
        schedule();
    }

    function applyHover(target) {
        const next = new Set();
        for (let element = target; element instanceof Element; element = parentOf(element)) {
            const controller = discover(element);
            if (controller) next.add(controller);
        }
        for (const controller of hovered) if (!next.has(controller)) controller.setHover(false);
        for (const controller of next) controller.setHover(true);
        hovered = next;
    }

    function wheelOnTrack(event, start) {
        if (event.ctrlKey || event.defaultPrevented) return;
        let dx = event.deltaX, dy = event.deltaY;
        if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) { dx *= 40; dy *= 40; }
        if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) { dx *= innerWidth; dy *= innerHeight; }
        for (let element = start; element instanceof Element; element = parentOf(element)) {
            const controller = discover(element);
            if (!controller) continue;
            const x = controller.horizontal, y = controller.vertical;
            controller.update();
            let stepX = dx, stepY = dy;
            if (!x.track.hidden && (event.shiftKey || y.track.hidden)) { stepX ||= stepY; stepY = 0; }
            const beforeX = element.scrollLeft, beforeY = element.scrollTop;
            const targetX = !x.track.hidden && stepX ? clamp(beforeX + stepX, x.minimum, x.minimum + x.maximum) : beforeX;
            const targetY = !y.track.hidden && stepY ? clamp(beforeY + stepY, 0, y.maximum) : beforeY;
            if (targetX !== beforeX || targetY !== beforeY) {
                event.preventDefault();
                element.scrollBy({left: targetX - beforeX, top: targetY - beforeY, behavior: 'smooth'});
                return;
            }
            // Keep a site's explicit boundary (for example, a modal's scroll lock).
            const css = getComputedStyle(element);
            if ((stepY && css.overscrollBehaviorY !== 'auto') || (stepX && css.overscrollBehaviorX !== 'auto')) return;
        }
    }

    document.addEventListener('pointerover', updateHover, {passive: true});
    document.addEventListener('pointerout', event => { if (!event.relatedTarget) updateHover(event); }, {passive: true});
    document.addEventListener('scroll', event => {
        discoveries.add(event.target === document ? document.scrollingElement : event.target);
        schedule();
    }, {capture: true, passive: true});
    window.addEventListener('resize', schedule, {passive: true});
    document.addEventListener('load', event => {
        if (event.target instanceof HTMLLinkElement && event.target.relList.contains('stylesheet')) stylesheetChanged();
        else schedule();
    }, {capture: true, passive: true});
    document.addEventListener('fullscreenchange', () => {
        (document.fullscreenElement || document.documentElement).append(host);
        schedule();
    });

    // Discover nested viewports only when hovered or scrolled. Ignore frequent
    // progress/style/timestamp changes on video pages; ResizeObserver handles
    // managed viewport/content sizes. Structural changes can alter scroll extents.
    const mutations = new MutationObserver(records => {
        let structural = false, cssChanged = false;
        for (const record of records) {
            if (record.target instanceof HTMLStyleElement) cssChanged = true;
            for (const node of [...record.addedNodes, ...record.removedNodes]) {
                if (!(node instanceof Element) || node === host) continue;
                structural = true;
                if (node.matches('style,link[rel~="stylesheet"]') || node.querySelector('style,link[rel~="stylesheet"]')) cssChanged = true;
                if (node.isConnected) registerSiteBars(node);
            }
        }
        if (structural && siteBars.size) componentsDirty = true;
        if (cssChanged) stylesheetChanged();
        else if (structural) schedule();
    });
    mutations.observe(document.documentElement, {subtree: true, childList: true});
    registerSiteBars(document.documentElement);
    refreshSiteOwners();
    watchAuthorStyle(document.documentElement);
    watchAuthorStyle(document.body);
    discover(document.scrollingElement);
    schedule();
})();
