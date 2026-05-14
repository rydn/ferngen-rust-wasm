import init, { FernRenderer } from "./pkg/fern_wasm.js";

const canvas = document.getElementById("fern");
const ctx = canvas.getContext("2d");
const toggleBtn = document.getElementById("toggle");
const resetBtn = document.getElementById("reset");
const zoomInBtn = document.getElementById("zoomIn");
const zoomOutBtn = document.getElementById("zoomOut");
const resetViewBtn = document.getElementById("resetView");
const zoomVal = document.getElementById("zoomVal");
const centerVal = document.getElementById("centerVal");
const batchInput = document.getElementById("batch");
const batchVal = document.getElementById("batchVal");
const delayInput = document.getElementById("delay");
const delayVal = document.getElementById("delayVal");
const maxItersInput = document.getElementById("maxIters");
const maxItersVal = document.getElementById("maxItersVal");
const itersEl = document.getElementById("iters");
const plottedEl = document.getElementById("plotted");
const ipsEl = document.getElementById("ips");

const fmt = new Intl.NumberFormat("en-US");

function fmtZoom(z) {
    if (z >= 1000) return z.toExponential(2) + "×";
    if (z >= 10) return z.toFixed(1) + "×";
    return z.toFixed(2) + "×";
}

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
        lastSampleTime = performance.now();
        lastSampleIters = 0n;
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
        lastSampleTime = performance.now();
        lastSampleIters = 0n;
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
                    const ips = di * 1000 / dt;
                    ipsEl.textContent = fmt.format(Math.round(ips));
                    lastSampleTime = now;
                    lastSampleIters = totalIters;
                }
            } else if (!runComplete) {
                runComplete = true;
                const elapsed = (performance.now() - runStartTime) / 1000;
                ipsEl.textContent =
                    `${fmt.format(Number(renderer.plotted()))} plotted in ${elapsed.toFixed(2)} s`;
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
        lastSampleTime = performance.now();
        lastSampleIters = 0n;
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
