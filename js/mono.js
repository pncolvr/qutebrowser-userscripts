javascript: (() => {
    const els = [...document.querySelectorAll('video,audio')];
    if (!els.length) return;
    const ctx = new(window.AudioContext || window.webkitAudioContext)();
    els.forEach(m => {
        try {
            if (m.__monoApplied) return;
            const src = ctx.createMediaElementSource(m);
            const sp = ctx.createChannelSplitter(2);
            const mg = ctx.createChannelMerger(1);
            sp.connect(mg, 0, 0);
            sp.connect(mg, 1, 0);
            mg.connect(ctx.destination);
            src.connect(sp);
            m.__monoApplied = true;
        } catch {}
    });
    ctx.resume(); 
})();
'mono applied'