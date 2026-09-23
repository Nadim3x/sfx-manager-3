'use strict';

/* ---------------------------------------------------------------------------
 * SFX engine — lazily synthesizes each library sound into an AudioBuffer
 * (cached), so the player, waveforms, scrubbing and speed controls all work
 * without shipping binary audio assets.
 * ------------------------------------------------------------------------- */

const SFX = (() => {
  let ctx = null;
  const cache = new Map();

  function ensure() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  }

  /* deterministic PRNG so every sound is stable across reloads */
  function mulberry(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function smooth(a, b, x) {
    x = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return x * x * (3 - 2 * x);
  }

  /* per-sample smoothing coefficient for a one-pole low-pass at f hz */
  const kFor = (f, sr) => 1 - Math.exp((-2 * Math.PI * f) / sr);

  const recipes = {
    /* short UI ticks, blips and selections */
    ui(d, n, sr, rnd) {
      const f0 = 1500 + rnd() * 1900;
      const double = rnd() < 0.5;
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const f = f0 * (1 - 0.3 * t);
        ph += (2 * Math.PI * f) / sr;
        let s = Math.sin(ph) * Math.exp(-t * 34) * 0.85;
        s += (rnd() * 2 - 1) * Math.exp(-t * 380) * 0.5; // click transient
        if (double) {
          const t2 = t - 0.45;
          if (t2 > 0) s += Math.sin(ph * 1.34) * Math.exp(-t2 * 40) * 0.5;
        }
        d[i] = s;
      }
    },

    /* filtered-noise sweeps — wind swishes, fabric, zooms */
    whoosh(d, n, sr, rnd) {
      const down = rnd() < 0.3;
      const fA = 250 + rnd() * 200;
      const fB = 2200 + rnd() * 1600;
      let y = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const p = down ? 1 - smooth(0, 1, t) : smooth(0, 1, t);
        const f = fA + (fB - fA) * p;
        y += (rnd() * 2 - 1 - y) * kFor(f, sr);
        const env = smooth(0, 0.14, t) * (1 - smooth(0.72, 1, t));
        d[i] = y * env * 1.9;
      }
    },

    /* sub drop + transient crack */
    impact(d, n, sr, rnd) {
      const f0 = 80 + rnd() * 90;
      let ph = 0;
      let y = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const f = f0 * Math.exp(-t * 5) + 36;
        ph += (2 * Math.PI * f) / sr;
        let s = Math.sin(ph) * Math.exp(-t * 6.5) * 0.9;
        y += (rnd() * 2 - 1 - y) * kFor(2200, sr);
        s += y * Math.exp(-t * 70) * 0.9;
        d[i] = s;
      }
    },

    /* rising tension: saw + brightening noise, hard release */
    riser(d, n, sr, rnd) {
      const fEnd = 700 + rnd() * 500;
      const fNoiseEnd = 2800 + rnd() * 1800;
      let ph = 0;
      let y = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const rise = Math.pow(t, 1.6);
        ph += (2 * Math.PI * (70 + (fEnd - 70) * rise)) / sr;
        const saw = (2 * ((ph / (2 * Math.PI)) % 1) - 1) * 0.16;
        y += (rnd() * 2 - 1 - y) * kFor(200 + (fNoiseEnd - 200) * rise, sr);
        const env = Math.pow(smooth(0, 0.92, t), 1.4) * (1 - smooth(0.93, 1, t));
        d[i] = (y * 0.75 + saw) * env;
      }
    },

    /* descending filtered noise + falling sub — tape stops, glitch cuts */
    transition(d, n, sr, rnd) {
      const fA = 3200 + rnd() * 1200;
      const fB = 220 + rnd() * 140;
      const f0 = 70 + rnd() * 40;
      let y = 0;
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const p = smooth(0, 1, t);
        y += (rnd() * 2 - 1 - y) * kFor(fA + (fB - fA) * p, sr);
        ph += (2 * Math.PI * (f0 + 30 * (1 - t))) / sr;
        const env = smooth(0, 0.1, t) * (1 - smooth(0.8, 1, t));
        d[i] = y * env * 1.6 + Math.sin(ph) * Math.exp(-t * 8) * 0.5 * env;
      }
    },

    /* muffled brown-ish noise with slow amplitude LFO + sparse crackle */
    nature(d, n, sr, rnd) {
      const f = 380 + rnd() * 420;
      const lfoF = 1.8 + rnd() * 4.5;
      const lfoPh = rnd() * Math.PI * 2;
      const k = kFor(f, sr);
      const crackEnv = new Float32Array(n);
      const nCracks = Math.max(3, Math.floor(n * 0.0012));
      for (let c = 0; c < nCracks; c++) {
        const s0 = Math.floor(rnd() * n);
        const amp = 0.3 + rnd() * 0.5;
        for (let i = s0; i < Math.min(n, s0 + 90); i++) {
          crackEnv[i] += (rnd() * 2 - 1) * amp * Math.exp(-((i - s0) / 90) * 9);
        }
      }
      let y = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        y += (rnd() * 2 - 1 - y) * k;
        const lfo = 0.55 + 0.45 * Math.sin(2 * Math.PI * lfoF * t + lfoPh);
        const edge = smooth(0, 0.08, t) * (1 - smooth(0.9, 1, t));
        d[i] = y * lfo * edge * 2.2 + crackEnv[i];
      }
    },
  };

  function render(item) {
    if (item._buffer) return item._buffer;
    if (cache.has(item.id)) return cache.get(item.id);
    const c = ensure();
    const sr = c.sampleRate;
    const n = Math.max(64, Math.floor(item.dur * sr));
    const buf = c.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    (recipes[item.cat] || recipes.ui)(d, n, sr, mulberry(item.seed));
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(d[i]));
    if (max > 0.0001) {
      const g = 0.85 / max;
      for (let i = 0; i < n; i++) d[i] *= g;
    }
    cache.set(item.id, buf);
    return buf;
  }

  /* peak envelope for waveform rendering, normalized to 0..1 */
  function peaks(buffer, bins) {
    const d = buffer.getChannelData(0);
    const out = new Float32Array(bins);
    const size = d.length / bins;
    let gmax = 0;
    for (let b = 0; b < bins; b++) {
      let m = 0;
      const s0 = Math.floor(b * size);
      const s1 = Math.min(d.length, Math.max(s0 + 1, Math.floor((b + 1) * size)));
      for (let i = s0; i < s1; i++) m = Math.max(m, Math.abs(d[i]));
      out[b] = m;
      gmax = Math.max(gmax, m);
    }
    if (gmax > 0) {
      for (let b = 0; b < bins; b++) out[b] = Math.pow(out[b] / gmax, 0.85);
    }
    return out;
  }

  return { ensure, render, peaks };
})();
