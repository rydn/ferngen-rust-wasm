use wasm_bindgen::prelude::*;

// Barnsley fern renderer with a (cx, cy, zoom) view transform.
//   Base mapping at zoom=1, center=(0, 5.5) matches the BASIC-256 reference:
//     xscale = w/6, yscale = h/11
//     xscr = w/2 + (x - cx) * xscale * zoom
//     yscr = h/2 - (y - cy) * yscale * zoom    (y inverted)
//   Per-plot color buildup: if g < 255 then g = (7*g)/8 + 33; pixel = (0,g,0)
// Four affine transforms with probabilities 1% / 85% / 7% / 7%.
//
// The fern is an IFS attractor, so zooming any leaflet reveals self-similar
// detail. We just keep iterating the chaos game; only points that land in
// the screen rect are plotted. As `zoom` increases, more iterations are
// needed to fill the view.

const DEFAULT_CX: f64 = 0.0;
const DEFAULT_CY: f64 = 5.5;
const SEED: u64 = 0x9E3779B97F4A7C15;

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
    pixels: Vec<u8>, // RGBA
    iterations: u64,
    plotted: u64,
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
        let mut r = FernRenderer {
            width,
            height,
            xscale: width as f64 / 6.0,
            yscale: height as f64 / 11.0,
            cx: DEFAULT_CX,
            cy: DEFAULT_CY,
            zoom: 1.0,
            x: 0.0,
            y: 0.0,
            rng_state: SEED,
            pixels: vec![0u8; (width * height * 4) as usize],
            iterations: 0,
            plotted: 0,
        };
        r.clear_pixels();
        r
    }

    fn clear_pixels(&mut self) {
        for px in self.pixels.chunks_exact_mut(4) {
            px[0] = 0;
            px[1] = 0;
            px[2] = 0;
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

    /// Reset everything (view + state) to defaults.
    pub fn reset(&mut self) {
        self.cx = DEFAULT_CX;
        self.cy = DEFAULT_CY;
        self.zoom = 1.0;
        self.restart();
    }

    /// Resize the pixel buffer and recompute base scales. Preserves the
    /// current view (cx, cy, zoom) and restarts iteration.
    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.width = width;
        self.height = height;
        self.xscale = width as f64 / 6.0;
        self.yscale = height as f64 / 11.0;
        self.pixels = vec![0u8; (width * height * 4) as usize];
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

        let mut x = self.x;
        let mut y = self.y;
        let mut state = self.rng_state;
        let mut plotted = 0u64;

        for _ in 0..iters {
            let r = next_f64(&mut state);
            let (xn, yn);
            if r < 0.01 {
                xn = 0.0;
                yn = 0.16 * y;
            } else if r < 0.86 {
                xn = 0.85 * x + 0.04 * y;
                yn = -0.04 * x + 0.85 * y + 1.6;
            } else if r < 0.93 {
                xn = 0.20 * x - 0.26 * y;
                yn = 0.23 * x + 0.22 * y + 1.6;
            } else {
                xn = -0.15 * x + 0.28 * y;
                yn = 0.26 * x + 0.24 * y + 0.44;
            }
            x = xn;
            y = yn;

            let xscr = (half_w + (x - cx) * sx) as i32;
            let yscr = (half_h - (y - cy) * sy) as i32;

            if xscr >= 0 && xscr < w && yscr >= 0 && yscr < h {
                let idx = ((yscr as u32 * self.width + xscr as u32) * 4) as usize;
                let g = self.pixels[idx + 1];
                if g < 255 {
                    let ng = ((7u32 * g as u32) / 8 + 33).min(255) as u8;
                    self.pixels[idx + 1] = ng;
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
