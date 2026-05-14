import init, { FernRenderer } from "./pkg/fern_wasm.js";

const canvas = document.getElementById("fern");
const ctx = canvas.getContext("2d");
const toggleBtn = document.getElementById("toggle");
const resetBtn = document.getElementById("reset");
const savePngBtn = document.getElementById("savePng");
const zoomInBtn = document.getElementById("zoomIn");
const zoomOutBtn = document.getElementById("zoomOut");
const resetViewBtn = document.getElementById("resetView");
const zoomVal = document.getElementById("zoomVal");
const centerVal = document.getElementById("centerVal");
const variantSel = document.getElementById("variant");
const paletteSel = document.getElementById("palette");
const batchInput = document.getElementById("batch");
const batchVal = document.getElementById("batchVal");
const delayInput = document.getElementById("delay");
const delayVal = document.getElementById("delayVal");
const maxItersInput = document.getElementById("maxIters");
const maxItersVal = document.getElementById("maxItersVal");
const itersEl = document.getElementById("iters");
const plottedEl = document.getElementById("plotted");
const ipsEl = document.getElementById("ips");
const ppsEl = document.getElementById("pps");
const renderTimeEl = document.getElementById("renderTime");

const fmt = new Intl.NumberFormat("en-US");

function fmtDuration(seconds) {
    if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
    if (seconds < 60) return `${seconds.toFixed(2)} s`;
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return `${m}m ${s.toFixed(1)}s`;
}

function fmtZoom(z) {
    if (z >= 1000) return z.toExponential(2) + "×";
    if (z >= 10) return z.toFixed(1) + "×";
    return z.toFixed(2) + "×";
}

// ---- Palettes ------------------------------------------------------------
// Each builder returns a 1024-byte RGBA LUT (256 entries). Intensity 0 is
// always opaque black so the background stays black on reset.

function rampPalette(rTo, gTo, bTo) {
    const p = new Uint8Array(1024);
    for (let i = 0; i < 256; i++) {
        const o = i * 4;
        p[o]     = Math.round(rTo * i / 255);
        p[o + 1] = Math.round(gTo * i / 255);
        p[o + 2] = Math.round(bTo * i / 255);
        p[o + 3] = 255;
    }
    return p;
}

// Hand-picked Inferno-ish stops (black → purple → red → orange → yellow → white).
function infernoPalette() {
    const stops = [
        [0,   0,   0,   0  ],
        [51,  20,  80,  3  ],
        [115, 30,  120, 30 ],
        [180, 50,  90,  80 ],
        [220, 140, 30,  150],
        [240, 220, 60,  220],
        [255, 255, 255, 255],
    ];
    // sort by stop value
    stops.sort((a, b) => a[3] - b[3]);
    const p = new Uint8Array(1024);
    for (let i = 0; i < 256; i++) {
        let s = 0;
        while (s < stops.length - 1 && stops[s + 1][3] < i) s++;
        const a = stops[s];
        const b = stops[Math.min(s + 1, stops.length - 1)];
        const span = Math.max(1, b[3] - a[3]);
        const t = Math.min(1, Math.max(0, (i - a[3]) / span));
        const o = i * 4;
        p[o]     = Math.round(a[0] + (b[0] - a[0]) * t);
        p[o + 1] = Math.round(a[1] + (b[1] - a[1]) * t);
        p[o + 2] = Math.round(a[2] + (b[2] - a[2]) * t);
        p[o + 3] = 255;
    }
    return p;
}

// Rainbow palette: smooth gradient through hand-picked stops
// (deep indigo → blue → teal → green → yellow → orange → pink),
// with a black anchor at i=0 so empty pixels stay dark.
function rainbowPalette() {
    const stops = [
        [  0,   0,   0,   0],
        [ 40,  20,  90,  20],
        [ 30,  90, 180,  70],
        [ 40, 200, 200, 120],
        [120, 220,  90, 165],
        [240, 210,  70, 200],
        [240, 130,  90, 230],
        [255, 200, 220, 255],
    ];
    const p = new Uint8Array(1024);
    for (let i = 0; i < 256; i++) {
        let s = 0;
        while (s < stops.length - 1 && stops[s + 1][3] < i) s++;
        const a = stops[s];
        const b = stops[Math.min(s + 1, stops.length - 1)];
        const span = Math.max(1, b[3] - a[3]);
        const t = Math.min(1, Math.max(0, (i - a[3]) / span));
        const o = i * 4;
        p[o]     = Math.round(a[0] + (b[0] - a[0]) * t);
        p[o + 1] = Math.round(a[1] + (b[1] - a[1]) * t);
        p[o + 2] = Math.round(a[2] + (b[2] - a[2]) * t);
        p[o + 3] = 255;
    }
    return p;
}

const PALETTES = {
    green:   () => rampPalette(0,   255, 0  ),
    amber:   () => rampPalette(255, 176, 32 ),
    cyan:    () => rampPalette(64,  220, 240),
    magenta: () => rampPalette(240, 64,  200),
    inferno: () => infernoPalette(),
    rainbow: () => rainbowPalette(),
    gray:    () => rampPalette(255, 255, 255),
};
// --------------------------------------------------------------------------

async function main() {
    const wasm = await init();

    // Pick the initial canvas bitmap size from its current display rect so
    // the very first allocation matches the visible area.
    function measureCanvas() {
        const rect = canvas.getBoundingClientRect();
        // Cap to avoid huge buffers on 4K+ displays; subpixel-round.
        const dpr = 1; // ignore devicePixelRatio: we want logical pixels
        const w = Math.max(32, Math.min(2400, Math.round(rect.width * dpr)));
        const h = Math.max(32, Math.min(3000, Math.round(rect.height * dpr)));
        return { w, h };
    }
    let { w: initW, h: initH } = measureCanvas();
    canvas.width = initW;
    canvas.height = initH;
    let width = initW;
    let height = initH;

    const renderer = new FernRenderer(width, height);

    let pixelView = new Uint8ClampedArray(
        wasm.memory.buffer,
        renderer.pixels_ptr(),
        renderer.pixels_len(),
    );
    let imageData = new ImageData(pixelView, width, height);

    function refreshView() {
        pixelView = new Uint8ClampedArray(
            wasm.memory.buffer,
            renderer.pixels_ptr(),
            renderer.pixels_len(),
        );
        imageData = new ImageData(pixelView, width, height);
    }

    function applyResize() {
        const { w, h } = measureCanvas();
        if (w === width && h === height) return;
        width = w;
        height = h;
        canvas.width = w;
        canvas.height = h;
        ghost.width = w;
        ghost.height = h;
        renderer.resize(w, h);
        refreshView();
        ctx.putImageData(imageData, 0, 0);
        itersEl.textContent = "0";
        plottedEl.textContent = "0";
        ipsEl.textContent = "—";
        ppsEl.textContent = "—";
        renderTimeEl.textContent = "—";
        lastSampleTime = performance.now();
        lastSampleIters = 0n;
        lastSamplePlotted = 0n;
        runStartTime = performance.now();
        runComplete = false;
        updateViewLabels();
    }

    let running = true;
    let batch = parseInt(batchInput.value, 10);
    let delayMs = parseInt(delayInput.value, 10);
    let maxIters = BigInt(maxItersInput.value);
    let lastSampleTime = performance.now();
    let runStartTime = performance.now();
    let runComplete = false;
    let lastSampleIters = 0n;
    let lastSamplePlotted = 0n;
    let prevBufferByteLength = wasm.memory.buffer.byteLength;

    // ---- Drag-to-pan with ghost preview ------------------------------------
    // While dragging, we stop blitting live pixels and instead show a snapshot
    // of the canvas translated by the drag delta. This makes the panning
    // motion visible (otherwise the live re-render obliterates the preview).
    const ghost = document.createElement("canvas");
    ghost.width = width;
    ghost.height = height;
    const ghostCtx = ghost.getContext("2d");

    let dragging = false;
    let dragMoved = false;
    let dragStart = null;          // { x, y } in canvas pixels
    let dragDelta = { x: 0, y: 0 };

    function snapshotToGhost() {
        // Always draw via the live ImageData so we capture the latest frame
        // even if the buffer view was refreshed.
        ctx.putImageData(imageData, 0, 0);
        ghostCtx.clearRect(0, 0, width, height);
        ghostCtx.drawImage(canvas, 0, 0);
    }

    function drawGhost(dx, dy) {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, width, height);
        // Slightly dim the ghost so it's clearly a preview.
        ctx.globalAlpha = 0.7;
        ctx.drawImage(ghost, dx, dy);
        ctx.globalAlpha = 1.0;
        // Center crosshair to show the new center under the cursor.
        ctx.strokeStyle = "rgba(95, 210, 138, 0.6)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(width / 2 - 8, height / 2);
        ctx.lineTo(width / 2 + 8, height / 2);
        ctx.moveTo(width / 2, height / 2 - 8);
        ctx.lineTo(width / 2, height / 2 + 8);
        ctx.stroke();
    }
    // ------------------------------------------------------------------------

    function updateViewLabels() {
        zoomVal.textContent = fmtZoom(renderer.zoom());
        centerVal.textContent =
            `${renderer.center_x().toFixed(4)}, ${renderer.center_y().toFixed(4)}`;
    }
    updateViewLabels();

    function applyView(cx, cy, zoom) {
        renderer.set_view(cx, cy, zoom);
        refreshView();
        ctx.putImageData(imageData, 0, 0);
        itersEl.textContent = "0";
        plottedEl.textContent = "0";
        ipsEl.textContent = "—";
        ppsEl.textContent = "—";
        renderTimeEl.textContent = "—";
        lastSampleTime = performance.now();
        lastSampleIters = 0n;
        lastSamplePlotted = 0n;
        runStartTime = performance.now();
        runComplete = false;
        updateViewLabels();
    }

    function tick() {
        if (running && !dragging) {
            const remaining = maxIters - renderer.plotted();
            if (remaining > 0n) {
                runComplete = false;
                renderer.step(batch);
                if (wasm.memory.buffer.byteLength !== prevBufferByteLength) {
                    refreshView();
                    prevBufferByteLength = wasm.memory.buffer.byteLength;
                }
                ctx.putImageData(imageData, 0, 0);
                const totalIters = renderer.iterations();
                const totalPlotted = renderer.plotted();
                itersEl.textContent = fmt.format(Number(totalIters));
                plottedEl.textContent = fmt.format(Number(totalPlotted));

                const now = performance.now();
                const dt = now - lastSampleTime;
                if (dt >= 500) {
                    const di = Number(totalIters - lastSampleIters);
                    const dp = Number(totalPlotted - lastSamplePlotted);
                    ipsEl.textContent = fmt.format(Math.round(di * 1000 / dt));
                    ppsEl.textContent = fmt.format(Math.round(dp * 1000 / dt));
                    lastSampleTime = now;
                    lastSampleIters = totalIters;
                    lastSamplePlotted = totalPlotted;
                }
            } else if (!runComplete) {
                runComplete = true;
                const elapsed = (performance.now() - runStartTime) / 1000;
                const avgIps = Number(renderer.iterations()) / Math.max(elapsed, 1e-6);
                const avgPps = Number(renderer.plotted()) / Math.max(elapsed, 1e-6);
                ipsEl.textContent = `${fmt.format(Math.round(avgIps))} avg`;
                ppsEl.textContent = `${fmt.format(Math.round(avgPps))} avg`;
                renderTimeEl.textContent = fmtDuration(elapsed);
            }
        }

        if (delayMs > 0) {
            setTimeout(() => requestAnimationFrame(tick), delayMs);
        } else {
            requestAnimationFrame(tick);
        }
    }

    toggleBtn.addEventListener("click", () => {
        running = !running;
        toggleBtn.textContent = running ? "Pause" : "Resume";
    });

    function fullReset() {
        renderer.reset();
        refreshView();
        ctx.putImageData(imageData, 0, 0);
        itersEl.textContent = "0";
        plottedEl.textContent = "0";
        ipsEl.textContent = "—";
        ppsEl.textContent = "—";
        renderTimeEl.textContent = "—";
        lastSampleTime = performance.now();
        lastSampleIters = 0n;
        lastSamplePlotted = 0n;
        runStartTime = performance.now();
        runComplete = false;
        updateViewLabels();
    }
    resetBtn.addEventListener("click", fullReset);
    resetViewBtn.addEventListener("click", fullReset);

    function canvasCoords(ev) {
        // Canvas internal bitmap is kept in sync with its CSS size by the
        // ResizeObserver, but a frame may pass between resize and event. Use
        // the current ratio to be safe.
        const rect = canvas.getBoundingClientRect();
        const x = (ev.clientX - rect.left) * (canvas.width / rect.width);
        const y = (ev.clientY - rect.top) * (canvas.height / rect.height);
        return { x, y };
    }

    canvas.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        dragging = true;
        dragMoved = false;
        dragStart = canvasCoords(ev);
        dragDelta = { x: 0, y: 0 };
        snapshotToGhost();
        drawGhost(0, 0);
        canvas.style.cursor = "grabbing";
    });

    window.addEventListener("mousemove", (ev) => {
        if (!dragging) return;
        const cur = canvasCoords(ev);
        dragDelta = { x: cur.x - dragStart.x, y: cur.y - dragStart.y };
        if (Math.hypot(dragDelta.x, dragDelta.y) > 2) dragMoved = true;
        drawGhost(dragDelta.x, dragDelta.y);
    });

    window.addEventListener("mouseup", (ev) => {
        if (!dragging) return;
        dragging = false;
        canvas.style.cursor = "crosshair";

        if (!dragMoved) {
            // Treat as a click: recenter on the clicked point.
            const { x, y } = canvasCoords(ev);
            const fx = renderer.screen_to_fern_x(x);
            const fy = renderer.screen_to_fern_y(y);
            applyView(fx, fy, renderer.zoom());
            return;
        }

        // Drag pan: shift center by the inverse of the drag delta in fern space.
        const z = renderer.zoom();
        const xscaleZ = (width / 6) * z;
        const yscaleZ = (height / 11) * z;
        const cx = renderer.center_x() - dragDelta.x / xscaleZ;
        const cy = renderer.center_y() + dragDelta.y / yscaleZ;
        applyView(cx, cy, z);
    });
    canvas.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        const { x, y } = canvasCoords(ev);
        // Pin the fern point under the cursor while zooming.
        const fx = renderer.screen_to_fern_x(x);
        const fy = renderer.screen_to_fern_y(y);
        const factor = ev.deltaY < 0 ? 1.08 : 1 / 1.08;
        const newZoom = renderer.zoom() * factor;
        const cx0 = renderer.center_x();
        const cy0 = renderer.center_y();
        const cx = fx - (fx - cx0) / factor;
        const cy = fy - (fy - cy0) / factor;
        applyView(cx, cy, newZoom);
    }, { passive: false });

    zoomInBtn.addEventListener("click", () => {
        applyView(renderer.center_x(), renderer.center_y(), renderer.zoom() * 2);
    });
    zoomOutBtn.addEventListener("click", () => {
        applyView(renderer.center_x(), renderer.center_y(), renderer.zoom() / 2);
    });

    variantSel.addEventListener("change", () => {
        const v = parseInt(variantSel.value, 10);
        renderer.set_variant(v);
        refreshView();
        ctx.putImageData(imageData, 0, 0);
        itersEl.textContent = "0";
        plottedEl.textContent = "0";
        ipsEl.textContent = "—";
        ppsEl.textContent = "—";
        lastSampleTime = performance.now();
        lastSampleIters = 0n;
        lastSamplePlotted = 0n;
        runStartTime = performance.now();
        runComplete = false;
        updateViewLabels();
    });

    function applyPalette(name) {
        const builder = PALETTES[name] || PALETTES.green;
        renderer.set_palette(builder());
        // set_palette rewrote the pixel buffer in place; just blit it.
        ctx.putImageData(imageData, 0, 0);
    }
    paletteSel.addEventListener("change", () => applyPalette(paletteSel.value));
    // Apply initial palette explicitly so the default green LUT is owned by JS.
    applyPalette(paletteSel.value);

    savePngBtn.addEventListener("click", () => {
        // Ensure we capture the live fern, not a transient drag-ghost frame.
        ctx.putImageData(imageData, 0, 0);
        canvas.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            const now = new Date();
            const pad = (n) => String(n).padStart(2, "0");
            const ts =
                `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
                `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
            const cx = renderer.center_x().toFixed(4);
            const cy = renderer.center_y().toFixed(4);
            const z = renderer.zoom().toPrecision(4);
            a.href = url;
            a.download = `fern-${ts}-cx${cx}-cy${cy}-z${z}.png`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }, "image/png");
    });

    batchInput.addEventListener("input", () => {
        batch = parseInt(batchInput.value, 10);
        batchVal.textContent = fmt.format(batch);
    });
    batchVal.textContent = fmt.format(batch);

    delayInput.addEventListener("input", () => {
        delayMs = parseInt(delayInput.value, 10);
        delayVal.textContent = `${delayMs} ms`;
    });
    delayVal.textContent = `${delayMs} ms`;

    maxItersInput.addEventListener("input", () => {
        maxIters = BigInt(maxItersInput.value);
        maxItersVal.textContent = fmt.format(Number(maxIters));
    });
    maxItersVal.textContent = fmt.format(Number(maxIters));

    // Observe the canvas size; reallocate the wasm pixel buffer to match
    // so the fern is rendered at the display's true pixel aspect ratio.
    let resizeRaf = 0;
    const ro = new ResizeObserver(() => {
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        // Debounce: coalesce rapid resize events into one allocation.
        resizeRaf = requestAnimationFrame(() => {
            resizeRaf = 0;
            applyResize();
        });
    });
    ro.observe(canvas);

    requestAnimationFrame(tick);
}

main().catch((err) => {
    console.error(err);
    document.body.insertAdjacentHTML(
        "beforeend",
        `<pre style="color:#f88;padding:1rem">${String(err)}</pre>`,
    );
});
