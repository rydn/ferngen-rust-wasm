use wasm_bindgen::prelude::*;

// Barnsley fern renderer with a (cx, cy, zoom) view transform.
//   Base mapping at zoom=1, center=(default_cx, default_cy):
//     xscale = w/x_div, yscale = h/y_div
//     xscr = w/2 + (x - cx) * xscale * zoom
//     yscr = h/2 - (y - cy) * yscale * zoom    (y inverted)
//   Per-plot intensity buildup: i' = (7*i)/8 + 33 (saturating at 255).
//   The intensity buffer is then mapped through a 256-entry RGBA palette
//   into the pixel buffer, so palette changes are O(pixels) instead of
//   restarting iteration.
// Each variant is an IFS with four affine transforms and cumulative
// probability thresholds.

const SEED: u64 = 0x9E3779B97F4A7C15;

#[wasm_bindgen]
#[derive(Copy, Clone)]
pub enum Variant {
    Classic = 0,
    Cyclosorus = 1,
    Culcita = 2,
    Modified = 3,
}

// One affine transform: x' = a*x + b*y + e, y' = c*x + d*y + f
#[derive(Copy, Clone)]
struct Affine {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
}

struct VariantConfig {
    transforms: [Affine; 4],
    // Cumulative probability thresholds for transforms 0..3; the 4th is implicit 1.0.
    thresholds: [f64; 3],
    default_cx: f64,
    default_cy: f64,
    x_div: f64,
    y_div: f64,
}

fn variant_config(v: Variant) -> VariantConfig {
    match v {
        // Classic Barnsley fern (Michael Barnsley, 1988).
        Variant::Classic => VariantConfig {
            transforms: [
                Affine { a: 0.0,   b: 0.0,   c: 0.0,   d: 0.16,  e: 0.0,  f: 0.0  },
                Affine { a: 0.85,  b: 0.04,  c: -0.04, d: 0.85,  e: 0.0,  f: 1.6  },
                Affine { a: 0.20,  b: -0.26, c: 0.23,  d: 0.22,  e: 0.0,  f: 1.6  },
                Affine { a: -0.15, b: 0.28,  c: 0.26,  d: 0.24,  e: 0.0,  f: 0.44 },
            ],
            thresholds: [0.01, 0.86, 0.93],
            default_cx: 0.0,
            default_cy: 5.5,
            x_div: 6.0,
            y_div: 11.0,
        },
        // Cyclosorus (a.k.a. "Thelypteridaceae"). Coefficients from
        // published IFS tables for this fern species.
        Variant::Cyclosorus => VariantConfig {
            transforms: [
                Affine { a: 0.0,   b: 0.0,   c: 0.0,    d: 0.25,  e: 0.0,    f: -0.4 },
                Affine { a: 0.95,  b: 0.005, c: -0.005, d: 0.93,  e: -0.002, f: 0.5  },
                Affine { a: 0.035, b: -0.2,  c: 0.16,   d: 0.04,  e: -0.09,  f: 0.02 },
                Affine { a: -0.04, b: 0.2,   c: 0.16,   d: 0.04,  e: 0.083,  f: 0.12 },
            ],
            thresholds: [0.02, 0.86, 0.93],
            default_cx: 0.0,
            default_cy: 4.5,
            x_div: 6.0,
            y_div: 9.5,
        },
        // Culcita fern.
        Variant::Culcita => VariantConfig {
            transforms: [
                Affine { a: 0.0,   b: 0.0,   c: 0.0,   d: 0.25,  e: 0.0,  f: -0.14 },
                Affine { a: 0.85,  b: 0.02,  c: -0.02, d: 0.83,  e: 0.0,  f: 1.0   },
                Affine { a: 0.09,  b: -0.28, c: 0.30,  d: 0.11,  e: 0.0,  f: 0.6   },
                Affine { a: -0.09, b: 0.28,  c: 0.30,  d: 0.09,  e: 0.0,  f: 0.7   },
            ],
            thresholds: [0.02, 0.84, 0.92],
            default_cx: 0.0,
            default_cy: 5.0,
            x_div: 6.0,
            y_div: 10.0,
        },
        // Modified Barnsley fern (alternate set with rounder leaflets and a
        // slightly heavier stem). Same overall envelope as Classic, so we
        // share its view defaults.
        Variant::Modified => VariantConfig {
            transforms: [
                Affine { a: 0.0,   b: 0.0,   c: 0.0,   d: 0.25,  e: 0.0,  f: -0.14 },
                Affine { a: 0.85,  b: 0.02,  c: -0.02, d: 0.83,  e: 0.0,  f: 1.0   },
                Affine { a: 0.09,  b: -0.28, c: 0.30,  d: 0.11,  e: 0.0,  f: 0.6   },
                Affine { a: -0.09, b: 0.28,  c: 0.30,  d: 0.09,  e: 0.0,  f: 0.7   },
            ],
            thresholds: [0.01, 0.86, 0.93],
            default_cx: 0.0,
            default_cy: 5.0,
            x_div: 6.0,
            y_div: 10.0,
        },
    }
}

fn default_palette_green() -> [u8; 1024] {
    let mut p = [0u8; 1024];
    for i in 0..256usize {
        let o = i * 4;
        p[o] = 0;
        p[o + 1] = i as u8;
        p[o + 2] = 0;
        p[o + 3] = 255;
    }
    p
}

#[wasm_bindgen]
pub struct FernRenderer {
    width: u32,
    height: u32,
    xscale: f64,
    yscale: f64,
    cx: f64,
    cy: f64,
    zoom: f64,
    x: f64,
    y: f64,
    rng_state: u64,
    pixels: Vec<u8>,    // RGBA, palette-mapped from intensity
    intensity: Vec<u8>, // single-channel accumulation buffer
    palette: [u8; 1024],
    iterations: u64,
    plotted: u64,
    variant: Variant,
}

#[inline(always)]
fn xorshift64(state: &mut u64) -> u64 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *state = x;
    x
}

#[inline(always)]
fn next_f64(state: &mut u64) -> f64 {
    (xorshift64(state) >> 11) as f64 * (1.0 / ((1u64 << 53) as f64))
}

#[wasm_bindgen]
impl FernRenderer {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> FernRenderer {
        let cfg = variant_config(Variant::Classic);
        let n = (width * height) as usize;
        let mut r = FernRenderer {
            width,
            height,
            xscale: width as f64 / cfg.x_div,
            yscale: height as f64 / cfg.y_div,
            cx: cfg.default_cx,
            cy: cfg.default_cy,
            zoom: 1.0,
            x: 0.0,
            y: 0.0,
            rng_state: SEED,
            pixels: vec![0u8; n * 4],
            intensity: vec![0u8; n],
            palette: default_palette_green(),
            iterations: 0,
            plotted: 0,
            variant: Variant::Classic,
        };
        r.clear_pixels();
        r
    }

    fn clear_pixels(&mut self) {
        for i in self.intensity.iter_mut() {
            *i = 0;
        }
        // Background = palette entry 0.
        let r0 = self.palette[0];
        let g0 = self.palette[1];
        let b0 = self.palette[2];
        for px in self.pixels.chunks_exact_mut(4) {
            px[0] = r0;
            px[1] = g0;
            px[2] = b0;
            px[3] = 255;
        }
    }

    /// Restart the chaos game without changing the view.
    pub fn restart(&mut self) {
        self.x = 0.0;
        self.y = 0.0;
        self.rng_state = SEED;
        self.iterations = 0;
        self.plotted = 0;
        self.clear_pixels();
    }

    /// Reset everything (view + state) to the current variant's defaults.
    pub fn reset(&mut self) {
        let cfg = variant_config(self.variant);
        self.cx = cfg.default_cx;
        self.cy = cfg.default_cy;
        self.zoom = 1.0;
        self.xscale = self.width as f64 / cfg.x_div;
        self.yscale = self.height as f64 / cfg.y_div;
        self.restart();
    }

    /// Resize the pixel buffer and recompute base scales. Preserves the
    /// current view (cx, cy, zoom) and restarts iteration.
    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        let cfg = variant_config(self.variant);
        self.width = width;
        self.height = height;
        self.xscale = width as f64 / cfg.x_div;
        self.yscale = height as f64 / cfg.y_div;
        let n = (width * height) as usize;
        self.pixels = vec![0u8; n * 4];
        self.intensity = vec![0u8; n];
        self.restart();
    }

    /// Set the view; (cx, cy) is the fern-space point that lands at the
    /// center of the canvas. Clears the canvas and restarts iteration.
    pub fn set_view(&mut self, cx: f64, cy: f64, zoom: f64) {
        self.cx = cx;
        self.cy = cy;
        self.zoom = zoom.max(1e-9);
        self.restart();
    }

    /// Switch to a different IFS variant. Resets the view to the variant's
    /// default and restarts iteration. Canvas size is preserved.
    pub fn set_variant(&mut self, v: Variant) {
        self.variant = v;
        let cfg = variant_config(v);
        self.cx = cfg.default_cx;
        self.cy = cfg.default_cy;
        self.zoom = 1.0;
        self.xscale = self.width as f64 / cfg.x_div;
        self.yscale = self.height as f64 / cfg.y_div;
        self.restart();
    }

    /// Replace the 256-entry RGBA palette and re-map the existing intensity
    /// buffer into the pixel buffer in place — no iteration reset.
    /// `rgba` must be exactly 1024 bytes (256 * 4).
    pub fn set_palette(&mut self, rgba: &[u8]) {
        if rgba.len() != 1024 {
            return;
        }
        self.palette.copy_from_slice(rgba);
        for (i, &ity) in self.intensity.iter().enumerate() {
            let po = (ity as usize) * 4;
            let qo = i * 4;
            self.pixels[qo] = self.palette[po];
            self.pixels[qo + 1] = self.palette[po + 1];
            self.pixels[qo + 2] = self.palette[po + 2];
            self.pixels[qo + 3] = 255;
        }
    }

    /// Map a screen pixel x-coordinate to fern-space x.
    pub fn screen_to_fern_x(&self, sx: f64) -> f64 {
        self.cx + (sx - self.width as f64 * 0.5) / (self.xscale * self.zoom)
    }

    /// Map a screen pixel y-coordinate to fern-space y.
    pub fn screen_to_fern_y(&self, sy: f64) -> f64 {
        self.cy - (sy - self.height as f64 * 0.5) / (self.yscale * self.zoom)
    }

    pub fn step(&mut self, iters: u32) {
        let w = self.width as i32;
        let h = self.height as i32;
        let half_w = self.width as f64 * 0.5;
        let half_h = self.height as f64 * 0.5;
        let sx = self.xscale * self.zoom;
        let sy = self.yscale * self.zoom;
        let cx = self.cx;
        let cy = self.cy;

        // Hoist variant config into locals so the hot loop avoids enum
        // dispatch overhead per iteration.
        let cfg = variant_config(self.variant);
        let t = cfg.transforms;
        let th0 = cfg.thresholds[0];
        let th1 = cfg.thresholds[1];
        let th2 = cfg.thresholds[2];

        let mut x = self.x;
        let mut y = self.y;
        let mut state = self.rng_state;
        let mut plotted = 0u64;

        for _ in 0..iters {
            let r = next_f64(&mut state);
            let tr = if r < th0 {
                &t[0]
            } else if r < th1 {
                &t[1]
            } else if r < th2 {
                &t[2]
            } else {
                &t[3]
            };
            let xn = tr.a * x + tr.b * y + tr.e;
            let yn = tr.c * x + tr.d * y + tr.f;
            x = xn;
            y = yn;

            let xscr = (half_w + (x - cx) * sx) as i32;
            let yscr = (half_h - (y - cy) * sy) as i32;

            if xscr >= 0 && xscr < w && yscr >= 0 && yscr < h {
                let idx = (yscr as u32 * self.width + xscr as u32) as usize;
                let cur = self.intensity[idx];
                if cur < 255 {
                    let ni = ((7u32 * cur as u32) / 8 + 33).min(255) as u8;
                    self.intensity[idx] = ni;
                    let po = (ni as usize) * 4;
                    let qo = idx * 4;
                    self.pixels[qo] = self.palette[po];
                    self.pixels[qo + 1] = self.palette[po + 1];
                    self.pixels[qo + 2] = self.palette[po + 2];
                    self.pixels[qo + 3] = 255;
                }
                plotted += 1;
            }
        }

        self.x = x;
        self.y = y;
        self.rng_state = state;
        self.iterations += iters as u64;
        self.plotted += plotted;
    }

    pub fn pixels_ptr(&self) -> *const u8 {
        self.pixels.as_ptr()
    }

    pub fn pixels_len(&self) -> usize {
        self.pixels.len()
    }

    pub fn iterations(&self) -> u64 {
        self.iterations
    }

    pub fn plotted(&self) -> u64 {
        self.plotted
    }

    pub fn zoom(&self) -> f64 {
        self.zoom
    }

    pub fn center_x(&self) -> f64 {
        self.cx
    }

    pub fn center_y(&self) -> f64 {
        self.cy
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }
}
