# ferngen

A real-time **Barnsley fern** generator written in Rust, compiled to
WebAssembly, and rendered in the browser via an HTML5 canvas.

**Live demo:** https://rydn.github.io/ferngen-rust-wasm/

## Features

- **Rust → WASM core**: a tight iteration loop with an inline xorshift64
  PRNG and a (cx, cy, zoom) view transform — no `rand`/`rayon`
  dependencies, so the wasm binary stays small.
- **Real-time rendering**: pixels are written directly to a `Vec<u8>` in
  WASM linear memory; JS wraps that memory in a `Uint8ClampedArray` and
  blits it via `ImageData` each `requestAnimationFrame` (zero-copy).
- **Pan & zoom**:
  - Drag to pan, with a dimmed "ghost" preview of the previous render
    translated by the drag delta so the motion is visible.
  - Mouse-wheel to zoom, anchored on the cursor.
  - `+` / `−` buttons for 2× zoom steps; `⤺` resets the view.

## The math

The chaos game samples one of four affine transforms with fixed
probabilities:

| Transform | p    | x'                | y'                          | Role                |
| --------- | ---- | ----------------- | --------------------------- | ------------------- |
| 1         | 0.01 | `0`               | `0.16·y`                    | Stem                |
| 2         | 0.85 | `0.85·x + 0.04·y` | `-0.04·x + 0.85·y + 1.6`    | Successive leaflets |
| 3         | 0.07 | `0.20·x − 0.26·y` | `0.23·x + 0.22·y + 1.6`     | Left leaflet        |
| 4         | 0.07 | `−0.15·x + 0.28·y`| `0.26·x + 0.24·y + 0.44`    | Right leaflet       |

Screen mapping (with view transform):

```
xscr = w/2 + (x − cx) · (w/6)  · zoom
yscr = h/2 − (y − cy) · (h/11) · zoom    # y inverted
```

Per-plot color buildup

```
if g < 255: g = (7·g)/8 + 33; pixel = (0, g, 0)
```

Because the fern is the attractor of an IFS, zooming any leaflet reveals
the same self-similar structure. At high zoom most iterations miss the
screen, so capping by **plotted points** (rather than total iterations)
keeps image density consistent across zoom levels.

## Project layout

```
ferngen/
├── fern-wasm/          Rust crate (cdylib, wasm-bindgen)
│   ├── Cargo.toml
│   └── src/lib.rs      FernRenderer: state, transforms, plot, RNG, view
├── web/                Static frontend (no bundler)
│   ├── index.html      Canvas + controls
│   ├── main.js         WASM bootstrap, RAF loop, pan/zoom, ghost preview
│   ├── style.css
│   └── pkg/            wasm-pack output (gitignored)
├── build.sh            wasm-pack build → web/pkg/
└── .gitignore
```

## Requirements

- macOS or Linux (Windows works with WSL or Git Bash)
- [Rust](https://rustup.rs) (stable; `wasm32-unknown-unknown` target)
- [`wasm-pack`](https://rustwasm.github.io/wasm-pack/)

### One-time toolchain setup

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"
rustup target add wasm32-unknown-unknown

# wasm-pack: pick one
brew install wasm-pack          # macOS, fastest
cargo install wasm-pack         # any platform
```

## Build & run

```bash
./build.sh                              # compiles wasm into web/pkg/
python3 -m http.server 8000 --directory web
# open http://localhost:8000
```

`build.sh` is a one-liner around `wasm-pack build --target web --release`
that places the output where `index.html` expects it.

## Controls

| Control                | Action                                                |
| ---------------------- | ----------------------------------------------------- |
| Drag canvas            | Pan view (ghost preview shown during drag)            |
| Mouse wheel            | Zoom in/out, anchored on cursor                       |
| Click canvas           | Recenter on the clicked fern-space point              |
| `+` / `−`              | Zoom 2× in/out                                        |
| `⤺`                    | Reset view + iteration                                |
| Pause / Resume         | Toggle iteration                                      |
| Reset                  | Reset view + iteration (same as ⤺)                    |
| Iterations / step      | Work done per frame (10² – 10⁷)                       |
| Delay between steps    | Pause between batches; helps visualize early growth   |
| Max plotted points     | Cap on on-screen points; controls final image density |

## Implementation notes

- **PRNG**: inline xorshift64 with a deterministic non-zero seed
  (`0x9E3779B9_7F4A7C15`). Reset/restart re-seeds with the same value, so
  the initial chain is reproducible 
- **Pixel buffer ownership**: kept in Rust as `Vec<u8>` RGBA. JS reads
  via `renderer.pixels_ptr()` + `renderer.pixels_len()`. The JS view is
  re-created if WASM memory grows (only happens on `resize`).
- **Drag preview**: while dragging, the live tick loop pauses blitting.
  An offscreen canvas (`ghost`) holds a snapshot of the last frame; on
  each `mousemove` it's redrawn at `α = 0.7` translated by the drag
  delta, plus a small green crosshair marking the new center.
- **Letterbox-free resize**: a debounced `ResizeObserver` calls
  `renderer.resize(w, h)`, which reallocates the pixel buffer and
  recomputes `xscale`/`yscale`. Pointer math uses the canvas's current
  display rect, so click/drag/wheel hit the right fern-space points at
  any size.
- **No bundler**: `wasm-pack --target web` emits an ES module; the
  frontend loads it with `<script type="module">`. The dev server is any
  static HTTP server.

## License

MIT 
