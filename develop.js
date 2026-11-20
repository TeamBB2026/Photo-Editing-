/* ===================== Develop engine: global color LUT, local maps, geometry, analysis ===================== */
const Dev = (() => {
  const LC = window.LookCore, N = 33;
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  const lin = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const gam = c => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  const HSL_KEYS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];
  const HSL_CENTERS = [0, 30, 60, 120, 180, 225, 270, 315];
  function defaults() {
    const hsl = {}; for (const k of HSL_KEYS) hsl[k] = [0, 0, 0];
    return { v: 1, look: null, lookAmt: 100, pick: 'auto', ev: 0, temp: 0, tint: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
      vibrance: 0, saturation: 0, hsl, skyExp: 0, skySat: 0, skyTemp: 0, clarity: 0, dehaze: 0, vignette: 0, grain: 0, sharpen: 0,
      crop: null, angle: 0, rot: 0, flipH: false, aspect: 'orig', creative: null, creativeAmt: 70, subjLight: 0, dodgeBurn: 0, skinMatch: 0, bgEdit: 100, skinSmooth: 0, beautify: 0, heal: 0, shine: 0, rescue: 0, glow: 0, flare: 0, flareX: 850, flareY: 120, flareWarm: 60, aiStrokes: [], curve: null, bgBlur: 0, bokeh: 0, pop: 0, faceLight: 0, studioLight: 0, studioDir: 'top', studioTarget: 'person', noise: 0, people: null };
  }

  /* ---------- tone curve (1D, on luminance) ---------- */
  function toneTable(s) {
    const T = new Float32Array(1025), c = s.contrast / 100 + s.dehaze / 100 * 0.25, h = s.highlights / 100, sh = s.shadows / 100, w = s.whites / 100, b = s.blacks / 100 - s.dehaze / 100 * 0.35;
    for (let i = 0; i <= 1024; i++) {
      const L = i / 1024; let f = L;
      f += c * 0.32 * (L - 0.5) * (1 - (2 * L - 1) * (2 * L - 1));
      f += sh * 0.2 * Math.exp(-(((L - 0.22) / 0.17) ** 2)) * (sh > 0 ? 1 : 0.8);
      f += h * 0.2 * Math.exp(-(((L - 0.78) / 0.17) ** 2));
      f += w * 0.12 * Math.pow(L, 3);
      f += b * 0.1 * Math.pow(1 - L, 3);
      T[i] = f;
    }
    for (let i = 1; i <= 1024; i++) T[i] = Math.max(T[i], T[i - 1] + 1e-5);
    for (let i = 0; i <= 1024; i++) T[i] = clamp01(T[i]);
    return T;
  }
  const tone = (T, L) => { const t = clamp01(L) * 1024, i = Math.min(t | 0, 1023), f = t - i; return T[i] + (T[i + 1] - T[i]) * f; };

  function rgb2hsv(r, g, b, o) { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0; if (d > 1e-6) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; } o[0] = h; o[1] = mx > 0 ? d / mx : 0; o[2] = mx; }
  function hsv2rgb(h, s, v, o) { const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c; let r, g, b; const k = (h / 60) | 0; [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.min(5, Math.max(0, k))]; o[0] = r + m; o[1] = g + m; o[2] = b + m; }
  function hslWeights(h, out) {
    let tot = 0;
    for (let i = 0; i < 8; i++) {
      const c = HSL_CENTERS[i], nxt = HSL_CENTERS[(i + 1) % 8] + (i === 7 ? 360 : 0), prv = HSL_CENTERS[(i + 7) % 8] - (i === 0 ? 360 : 0);
      let d = h - c; if (d > 180) d -= 360; if (d < -180) d += 360;
      const span = d >= 0 ? (nxt - c) : (c - prv);
      const w = Math.max(0, 1 - Math.abs(d) / span); out[i] = w; tot += w;
    }
    if (tot > 0) for (let i = 0; i < 8; i++) out[i] /= tot;
  }

  /* ---------- the global LUT: WB -> exposure -> look -> tone -> color -> HSL ---------- */
  function bake(s, look) {
    const T = toneTable(s), lut = new Float32Array(N * N * N * 3), sN = N - 1;
    const t = s.temp / 100, tn = s.tint / 100;
    let gr = Math.exp(0.28 * t), gg = Math.exp(-0.16 * tn), gb = Math.exp(-0.28 * t); const gl = luma(gr, gg, gb); gr /= gl; gg /= gl; gb /= gl;
    const ex = Math.pow(2, s.ev || 0), amt = (s.lookAmt ?? 100) / 100;
    const sat = 1 + s.saturation / 100 + s.dehaze / 100 * 0.15, vib = s.vibrance / 100;
    const hsl = HSL_KEYS.map(k => s.hsl[k]), anyHsl = hsl.some(a => a[0] || a[1] || a[2]);
    const lk = look ? look.lut : null, tw = look ? LCtweak(look) : null;
    const tmp = [0, 0, 0], hsv = [0, 0, 0], w8 = new Float32Array(8);
    for (let idx = 0; idx < N * N * N; idx++) {
      let r = (idx % N) / sN, g = (((idx / N) | 0) % N) / sN, b = ((idx / (N * N)) | 0) / sN;
      // white balance + exposure in linear light
      r = lin(r) * gr * ex; g = lin(g) * gg * ex; b = lin(b) * gb * ex;
      // soft highlight knee so brightening rolls off instead of clipping hard
      const knee = v => v <= 0.8 ? v : 0.8 + 0.2 * (1 - Math.exp(-(v - 0.8) / 0.2));
      r = gam(knee(r)); g = gam(knee(g)); b = gam(knee(b));
      if (lk) { LC.lutAt(lk, r, g, b, tmp, 0); r += (tmp[0] - r) * amt; g += (tmp[1] - g) * amt; b += (tmp[2] - b) * amt; if (tw) { tmp[0] = r; tmp[1] = g; tmp[2] = b; tw(tmp, 0); r = tmp[0]; g = tmp[1]; b = tmp[2]; } }
      // tone curve on luminance, colour kept
      let L = luma(r, g, b), L2 = tone(T, L);
      if (L > 0.04) { const k = L2 / L; r *= k; g *= k; b *= k; } else { r += L2 - L; g += L2 - L; b += L2 - L; }
      // saturation + vibrance (vibrance favours muted colours and spares skin)
      L = luma(r, g, b);
      if (sat !== 1 || vib) {
        rgb2hsv(clamp01(r), clamp01(g), clamp01(b), hsv);
        const skin = hsv[0] > 10 && hsv[0] < 50 ? 0.5 : 1;
        const k = sat * (1 + vib * (1 - Math.min(1, hsv[1] * 1.4)) * skin * 0.9);
        r = L + (r - L) * k; g = L + (g - L) * k; b = L + (b - L) * k;
      }
      if (anyHsl) {
        rgb2hsv(clamp01(r), clamp01(g), clamp01(b), hsv); hslWeights(hsv[0], w8);
        let dh = 0, ds = 0, dl = 0; for (let i = 0; i < 8; i++) { dh += w8[i] * hsl[i][0]; ds += w8[i] * hsl[i][1]; dl += w8[i] * hsl[i][2]; }
        const cw = Math.min(1, hsv[1] * 3);
        let h2 = hsv[0] + dh / 100 * 30 * cw; if (h2 < 0) h2 += 360; if (h2 >= 360) h2 -= 360;
        const s2 = clamp01(hsv[1] * (1 + ds / 100 * cw));
        hsv2rgb(h2, s2, hsv[2], tmp);
        const Lb = luma(tmp[0], tmp[1], tmp[2]), Lt = Lb * (1 + dl / 100 * 0.45 * cw);
        const k = Lb > 0.01 ? Lt / Lb : 1; r = tmp[0] * k; g = tmp[1] * k; b = tmp[2] * k;
      }
      lut[3 * idx] = clamp01(r); lut[3 * idx + 1] = clamp01(g); lut[3 * idx + 2] = clamp01(b);
    }
    return lut;
  }
  function LCtweak(look) { if (!look.tweaks) return null; const b = LC.bakedLUT({ lut: new Float32Array(3), tweaks: null }); return tweakFnLocal(look.tweaks); }
  function tweakFnLocal(tw) {
    const bk = Math.pow(2, (tw.bright || 0) / 100 * 0.8), cc = (tw.contrast || 0) / 100 * 0.45, sk = 1 + (tw.sat || 0) / 100 * 0.6,
      wr = 1 + (tw.warmth || 0) / 100 * 0.09, wb = 1 - (tw.warmth || 0) / 100 * 0.09, tg = 1 - (tw.tint || 0) / 100 * 0.07;
    if (bk === 1 && cc === 0 && sk === 1 && wr === 1 && tg === 1) return null;
    return (o, i) => { let r = o[i] * bk * wr, g = o[i + 1] * bk * tg, b = o[i + 2] * bk * wb; const L = luma(r, g, b), Lc = clamp01(L); const d = cc * (Lc - 0.5) * (1 - Math.abs(2 * Lc - 1)) * 2; o[i] = L + (r - L) * sk + d; o[i + 1] = L + (g - L) * sk + d; o[i + 2] = L + (b - L) * sk + d; };
  }

  /* ---------- sky mask on a small image ---------- */
  function skyMask(small) {
    const { w, h, rgb } = small, n = w * h, cand = new Uint8Array(n), hsv = [0, 0, 0], V = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      rgb2hsv(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2], hsv); V[i] = hsv[2];
      const y = (i / w) | 0;
      const blue = hsv[0] > 175 && hsv[0] < 265 && hsv[1] > 0.1 && hsv[2] > 0.3;
      const overcast = hsv[2] > 0.8 && hsv[1] < 0.16;
      const warm = hsv[2] > 0.55 && hsv[1] > 0.15 && (hsv[0] < 50 || hsv[0] > 330) && y < h * 0.4; // sunset sky
      cand[i] = (blue || overcast || warm) && y < h * 0.8 ? 1 : 0;
    }
    // grow from the top edge through smooth candidate pixels
    const m = new Uint8Array(n), stack = [];
    for (let x = 0; x < w; x++) if (cand[x]) { m[x] = 1; stack.push(x); }
    while (stack.length) {
      const i = stack.pop(), x = i % w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
      for (const j of nb) if (j >= 0 && j < n && !m[j] && cand[j] && Math.abs(V[j] - V[i]) < 0.07) { m[j] = 1; stack.push(j); }
    }
    let cnt = 0; for (let i = 0; i < n; i++) cnt += m[i];
    const f = new Float32Array(n); if (cnt < n * 0.02) return { mask: f, frac: 0 };
    for (let i = 0; i < n; i++) f[i] = m[i];
    const bl = LC.blur(f, w, h, 0.012 * Math.max(w, h));
    for (let i = 0; i < n; i++) bl[i] = clamp01((bl[i] - 0.15) / 0.7);
    return { mask: bl, frac: cnt / n };
  }

  /* ---------- geometry ---------- */
  function oriented(SW, SH, s) { return (s.rot % 180 === 90) ? [SH, SW] : [SW, SH]; }
  function cropRect(s, OW, OH) {
    if (s.crop) return s.crop;
    return { x: 0, y: 0, w: 1, h: 1 };
  }
  function outSize(SW, SH, s, maxLong) {
    const [OW, OH] = oriented(SW, SH, s), c = cropRect(s, OW, OH);
    let w = c.w * OW, h = c.h * OH; const k = maxLong ? Math.min(1, maxLong / Math.max(w, h)) : 1;
    return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)), k];
  }
  /* draw src through rotate/flip -> straighten -> crop into ctx of size cw x ch */
  function drawGeom(ctx, src, SW, SH, s, cw, ch) {
    const [OW, OH] = oriented(SW, SH, s), c = cropRect(s, OW, OH);
    const sc = cw / (c.w * OW);
    const th = (s.angle || 0) * Math.PI / 180, ar = cw / ch;
    const z = th ? Math.abs(Math.cos(th)) + Math.abs(Math.sin(th)) * Math.max(ar, 1 / ar) : 1;
    ctx.save(); ctx.imageSmoothingQuality = 'high';
    ctx.translate(cw / 2, ch / 2); if (th) { ctx.rotate(th); ctx.scale(z, z); }
    ctx.translate(-(c.x + c.w / 2) * OW * sc, -(c.y + c.h / 2) * OH * sc);
    ctx.scale(sc, sc);
    // orientation (in oriented pixel units)
    if (s.flipH) { ctx.translate(OW, 0); ctx.scale(-1, 1); }
    if (s.rot === 90) { ctx.translate(OW, 0); ctx.rotate(Math.PI / 2); }
    else if (s.rot === 180) { ctx.translate(OW, OH); ctx.rotate(Math.PI); }
    else if (s.rot === 270) { ctx.translate(0, OH); ctx.rotate(-Math.PI / 2); }
    ctx.drawImage(src, 0, 0, SW, SH);
    ctx.restore();
  }

  /* ---------- per-photo "prepared" low-res info (maps) ---------- */
  function smallFrom(data, W, H, long) {
    const k = Math.min(1, long / Math.max(W, H)), w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k)), rgb = new Float32Array(w * h * 3);
    // box-average downscale
    const sx = W / w, sy = H / h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = (x * sx) | 0, x1 = Math.max(x0 + 1, ((x + 1) * sx) | 0), y0 = (y * sy) | 0, y1 = Math.max(y0 + 1, ((y + 1) * sy) | 0);
      let r = 0, g = 0, b = 0, c = 0; const stp = Math.max(1, ((x1 - x0) / 3) | 0);
      for (let yy = y0; yy < y1; yy += stp) for (let xx = x0; xx < x1; xx += stp) { const p = 4 * (yy * W + xx); r += data[p]; g += data[p + 1]; b += data[p + 2]; c++; }
      const o = 3 * (y * w + x); rgb[o] = r / c / 255; rgb[o + 1] = g / c / 255; rgb[o + 2] = b / c / 255;
    }
    return { w, h, rgb };
  }
  function buildMaps(s, look, small, prep, brush, sky, cr) {
    const { w, h } = small, n = w * h, logG = new Float32Array(n), amt = (s.lookAmt ?? 100) / 100, k = Math.pow(2, s.ev || 0);
    const vigU = s.vignette / 100 * 1.1 * Math.LN2;   // like Lightroom: negative darkens the corners, positive brightens
    for (let i = 0; i < n; i++) {
      const d = prep.d[i];
      let g = vigU * Math.pow(Math.max(0, d - 0.3) / 0.7, 1.7);
      if (look) g += amt * (interp(look.vig, d) + interp(look.ctx, Math.min(1, prep.ctxKey[i] * k)));
      if (brush) g += brush[i];
      if (sky && s.skyExp) g += sky.mask[i] * s.skyExp / 100 * 1.2 * Math.LN2;
      if (cr) g += (1 - cr.mask[i]) * cr.P.bg.ev * cr.amt * Math.LN2;
      logG[i] = g;
    }
    return { w, h, logG, sky: sky && (s.skySat || s.skyTemp) ? sky.mask : null };
  }
  function interpMask(M, a00, a10, a01, a11, w00, w10, w01, w11) { return M[a00] * w00 + M[a10] * w10 + M[a01] * w01 + M[a11] * w11; }
  function interp(tab, v) { const n = tab.length, t = clamp01(v) * (n - 1), i = Math.min(t | 0, n - 2), f = t - i; return tab[i] + (tab[i + 1] - tab[i]) * f; }
  /* clarity bases are computed from the rendered (pre-local) result at low res */
  function clarityBase(lut, mp, small) {
    const { w, h } = small, n = w * h, L = new Float32Array(n), t = [0, 0, 0];
    for (let i = 0; i < n; i++) { LC.lutAt(lut, small.rgb[3 * i], small.rgb[3 * i + 1], small.rgb[3 * i + 2], t, 0); L[i] = luma(t[0], t[1], t[2]) * Math.exp(mp.logG[i]); }
    return { b1: LC.blur(L, w, h, 0.012 * Math.max(w, h)), b2: LC.blur(L, w, h, 0.05 * Math.max(w, h)) };
  }


  /* ---------- creative looks: subject stays natural, background is restyled ---------- */
  const CREATIVE = {
    winter: { name: 'Winter Wonderland', bg: { temp: -1, sat: 0.28, lift: 0.12, ev: 0.3, tintHi: [0.93, 0.98, 1.06], tintLo: [0.82, 0.92, 1.08] }, subj: { warm: 0.02 }, bloom: 0.35, bloomTint: [0.9, 0.96, 1.05], particles: 'snow' },
    fairy: { name: 'Fairy Tale', bg: { temp: 0.35, sat: 0.7, lift: 0.1, ev: 0.2, tintHi: [1.07, 0.98, 0.92], tintLo: [1.04, 0.88, 1.04] }, subj: { warm: 0.03 }, bloom: 0.45, bloomTint: [1.08, 0.96, 0.85], particles: 'sparkle' },
    golden: { name: 'Golden Hour', bg: { temp: 1, sat: 1.1, lift: 0.03, ev: 0.1, tintHi: [1.1, 1.0, 0.78], tintLo: [1.02, 0.92, 0.82] }, subj: { warm: 0.05 }, bloom: 0.35, bloomTint: [1.1, 0.93, 0.7], particles: 'sun' },
    autumn: { name: 'Autumn', bg: { temp: 0.55, sat: 1.12, lift: 0.04, ev: 0.05, tintHi: [1.07, 0.99, 0.84], tintLo: [1.0, 0.9, 0.82], greens: 0.85 }, subj: { warm: 0.03 }, bloom: 0.3, bloomTint: [1.1, 0.92, 0.7], particles: 'leaves' },
    pop: { name: 'Color Pop', bg: { temp: 0, sat: 0.2, lift: 0, ev: -0.45, tintHi: [1, 1, 1], tintLo: [1, 1, 1] }, subj: { sat: 1.18 }, bloom: 0, particles: null },
    moody: { name: 'Moody', bg: { temp: -0.2, sat: 0.7, lift: 0.02, ev: -0.75, tintHi: [1, 1, 1], tintLo: [0.9, 0.96, 1.05] }, subj: {}, bloom: 0.15, bloomTint: [1, 1, 1], particles: null },
  };
  function creativeLUTs(key, amt) {
    const P = CREATIVE[key]; if (!P || !amt) return null;
    const mk = (fn) => { const lut = new Float32Array(N * N * N * 3), sN = N - 1, o = [0, 0, 0]; for (let idx = 0; idx < N * N * N; idx++) { const r = (idx % N) / sN, g = (((idx / N) | 0) % N) / sN, b = ((idx / (N * N)) | 0) / sN; fn(r, g, b, o); lut[3 * idx] = clamp01(r + (o[0] - r) * amt); lut[3 * idx + 1] = clamp01(g + (o[1] - g) * amt); lut[3 * idx + 2] = clamp01(b + (o[2] - b) * amt); } return lut; };
    const B = P.bg, S = P.subj;
    const hsv = [0, 0, 0], t3 = [0, 0, 0];
    const bg = mk((r, g, b, o) => {
      if (B.greens) {
        // foliage: pull greens and yellow-greens toward amber and rust
        rgb2hsv(r, g, b, hsv);
        if (hsv[0] > 45 && hsv[0] < 175 && hsv[1] > 0.08) { const w = Math.min(1, Math.min(hsv[0] - 45, 175 - hsv[0]) / 25) * B.greens, target = hsv[0] < 95 ? 38 : 26; const h2 = hsv[0] + (target - hsv[0]) * w; hsv2rgb(h2, Math.min(1, hsv[1] * (1 + 0.25 * w)), hsv[2] * (1 - 0.06 * w), t3); r = t3[0]; g = t3[1]; b = t3[2]; }
      }
      const L = luma(r, g, b);
      r = L + (r - L) * B.sat; g = L + (g - L) * B.sat; b = L + (b - L) * B.sat;
      r *= 1 + 0.16 * B.temp; b *= 1 - 0.16 * B.temp;
      const hi = L * L, lo = 1 - hi;
      r *= B.tintHi[0] * hi + B.tintLo[0] * lo; g *= B.tintHi[1] * hi + B.tintLo[1] * lo; b *= B.tintHi[2] * hi + B.tintLo[2] * lo;
      r = B.lift + r * (1 - B.lift); g = B.lift + g * (1 - B.lift); b = B.lift + b * (1 - B.lift);
      o[0] = r; o[1] = g; o[2] = b;
    });
    const sj = mk((r, g, b, o) => { const L = luma(r, g, b), k = S.sat || 1; r = L + (r - L) * k; g = L + (g - L) * k; b = L + (b - L) * k; if (S.warm) { r *= 1 + S.warm; b *= 1 - S.warm; } o[0] = r; o[1] = g; o[2] = b; });
    return { bg, sj, P };
  }
  /* subject mask from focus: shallow depth of field keeps the couple sharp and the background soft */
  function subjectMask(small, paint) {
    const { w, h, rgb } = small, n = w * h, L = new Float32Array(n), E = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = luma(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]);
    const bl = LC.blur(L, w, h, 1);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; E[i] = Math.abs(4 * bl[i] - bl[i - 1] - bl[i + 1] - bl[i - w] - bl[i + w]); }
    const D = LC.blur(E, w, h, 0.018 * Math.max(w, h));
    const sorted = Float32Array.from(D).sort(), lo = sorted[(n * 0.35) | 0], hi = sorted[(n * 0.9) | 0];
    const M = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, f = clamp01((D[i] - lo) / Math.max(1e-6, hi - lo));
      const dx = (x / w - 0.5) / 0.5, dy = (y / h - 0.55) / 0.55, center = clamp01(1.15 - 0.55 * (dx * dx + dy * dy));
      M[i] = clamp01(f * 1.25 * (0.55 + 0.45 * center));
    }
    // fill and soften so the subject reads as one shape
    let S = LC.blur(M, w, h, 0.03 * Math.max(w, h));
    for (let i = 0; i < n; i++) S[i] = clamp01((S[i] - 0.28) / 0.3);
    S = LC.blur(S, w, h, 0.008 * Math.max(w, h));
    if (paint) for (let i = 0; i < n; i++) S[i] = clamp01(S[i] + paint[i]);
    let tot = 0; for (let i = 0; i < n; i++) tot += S[i];
    return { mask: S, frac: tot / n };
  }
  function bloomMap(lut, small, mp, tint) {
    const { w, h, rgb } = small, n = w * h, B = new Float32Array(n * 3), t = [0, 0, 0];
    for (let i = 0; i < n; i++) { LC.lutAt(lut, rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2], t, 0); const e = Math.exp(mp.logG[i]), L = luma(t[0], t[1], t[2]) * e, k = clamp01((L - 0.55) / 0.45); for (let c = 0; c < 3; c++) B[3 * i + c] = t[c] * e * k * tint[c]; }
    const out = new Float32Array(n * 3), ch = new Float32Array(n);
    for (let c = 0; c < 3; c++) { for (let i = 0; i < n; i++) ch[i] = B[3 * i + c]; const a = LC.blur(ch, w, h, 0.02 * Math.max(w, h)), b = LC.blur(ch, w, h, 0.07 * Math.max(w, h)); for (let i = 0; i < n; i++) out[3 * i + c] = a[i] * 0.5 + b[i] * 0.7; }
    return out;
  }
  /* falling snow / sparkle / sun, drawn on its own layer at output size */
  function particles(kind, W, H, seed, amt) {
    if (!kind || !amt) return null;
    const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
    let sd = seed | 0; const R = () => { sd = sd + 0x6D2B79F5 | 0; let t = Math.imul(sd ^ sd >>> 15, 1 | sd); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const S = Math.max(W, H);
    const dot = (px, py, r, col, a, soft) => { const g = x.createRadialGradient(px, py, 0, px, py, r); g.addColorStop(0, `rgba(${col},${a})`); g.addColorStop(soft, `rgba(${col},${a * 0.55})`); g.addColorStop(1, `rgba(${col},0)`); x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill(); };
    if (kind === 'snow') {
      const n = Math.round(520 * amt);
      for (let i = 0; i < n; i++) { const depth = Math.pow(R(), 2.4); const r = S * (0.0018 + depth * 0.016); dot(R() * W, R() * H, r, '255,255,255', 0.35 + 0.5 * (1 - depth) * R(), depth > 0.6 ? 0.2 : 0.55); }
    } else if (kind === 'sparkle') {
      const n = Math.round(150 * amt);
      for (let i = 0; i < n; i++) { const r = S * (0.002 + Math.pow(R(), 3) * 0.02); dot(R() * W, R() * H * 0.85, r, R() < 0.5 ? '255,236,190' : '255,214,235', 0.25 + 0.45 * R(), 0.3); }
    } else if (kind === 'leaves') {
      const cols = ['196,82,28', '224,138,44', '163,52,31', '217,164,65', '140,70,30'], n = Math.round(70 * amt);
      for (let i = 0; i < n; i++) {
        const depth = Math.pow(R(), 1.8), L = S * (0.008 + depth * 0.03), px = R() * W, py = R() * H, rot = R() * Math.PI;
        x.save(); x.translate(px, py); x.rotate(rot); x.globalAlpha = 0.45 + 0.45 * (1 - depth);
        x.filter = depth > 0.55 ? `blur(${Math.round(L * 0.18)}px)` : 'none';
        x.fillStyle = `rgb(${cols[(R() * cols.length) | 0]})`;
        x.beginPath(); x.moveTo(-L, 0); x.quadraticCurveTo(0, -L * 0.55, L, 0); x.quadraticCurveTo(0, L * 0.55, -L, 0); x.fill();
        x.strokeStyle = 'rgba(90,40,15,.5)'; x.lineWidth = Math.max(1, L * 0.06); x.beginPath(); x.moveTo(-L * 0.9, 0); x.lineTo(L * 0.9, 0); x.stroke();
        x.restore();
      }
      x.globalAlpha = 1; x.filter = 'none';
    } else if (kind === 'sun') {
      const g = x.createRadialGradient(W * 0.92, H * 0.06, 0, W * 0.92, H * 0.06, S * 0.75); g.addColorStop(0, `rgba(255,214,150,${0.55 * amt})`); g.addColorStop(0.35, `rgba(255,170,90,${0.22 * amt})`); g.addColorStop(1, 'rgba(255,150,80,0)'); x.fillStyle = g; x.fillRect(0, 0, W, H);
    }
    const d = x.getImageData(0, 0, W, H).data; c.width = c.height = 0; return d;
  }

  /* ---------- pixel render (in place on RGBA) ---------- */
  function render(s, look, lut, mp, cb, data, W, H, y0, y1, grainScale, cr) {
    const t2 = [0, 0, 0], t3 = [0, 0, 0], cm = cr ? cr.mask : null, cbl = cr ? cr.bloom : null, cpart = cr ? cr.part : null, camt = cr ? cr.amt : 0, cbAmt = cr ? cr.P.bloom * camt : 0;
    const tile = noise(), T = 512, tmp = [0, 0, 0];
    const amt = (s.lookAmt ?? 100) / 100;
    const cl = (look ? look.clarity * amt : 0) + s.clarity / 100 * 0.9, dz = s.dehaze / 100 * 0.6;
    const gAmt = ((look ? Math.min(0.0012, look.grain * 0.2) * amt / NOISE_FINE : 0) + s.grain / 100 * 0.025) * grainScale;
    const mw = mp.w, mh = mp.h, sx = mw / W, sy = mh / H, lg = mp.logG, sky = mp.sky, B1 = cb.b1, B2 = cb.b2, sp = mp.sp || null, sls = mp.slList || (mp.sl ? [mp.sl] : []), skns = mp.skList || (mp.sk ? [mp.sk] : []), pp = mp.pp || null, wh = mp.wh || null;
    const ssat = s.skySat / 100 * 0.7, stemp = s.skyTemp / 100 * 0.1;
    for (let y = y0; y < y1; y++) {
      let v = (y + 0.5) * sy - 0.5; v = v < 0 ? 0 : v > mh - 1 ? mh - 1 : v;
      const v0 = Math.min(v | 0, Math.max(0, mh - 2)), fv = v - v0, r0 = v0 * mw, r1 = Math.min(v0 + 1, mh - 1) * mw, trow = ((y + 211) % T) * T;
      for (let x = 0; x < W; x++) {
        let u = (x + 0.5) * sx - 0.5; u = u < 0 ? 0 : u > mw - 1 ? mw - 1 : u;
        const u0 = Math.min(u | 0, Math.max(0, mw - 2)), fu = u - u0, u1 = Math.min(u0 + 1, mw - 1);
        const a00 = r0 + u0, a10 = r0 + u1, a01 = r1 + u0, a11 = r1 + u1, w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
        const G = lg[a00] * w00 + lg[a10] * w10 + lg[a01] * w01 + lg[a11] * w11;
        const p = 4 * (y * W + x);
        LC.lutAt(lut, data[p] / 255, data[p + 1] / 255, data[p + 2] / 255, tmp, 0);
        let r = tmp[0], g = tmp[1], b = tmp[2];
        if (sp) { const m = sp.mask[a00] * w00 + sp.mask[a10] * w10 + sp.mask[a01] * w01 + sp.mask[a11] * w11; if (m > 0.01) { LC.lutAt(sp.lut, data[p] / 255, data[p + 1] / 255, data[p + 2] / 255, t2, 0); r += (t2[0] - r) * m; g += (t2[1] - g) * m; b += (t2[2] - b) * m; } }
        for (const skn of skns) { const m = skn.mask[a00] * w00 + skn.mask[a10] * w10 + skn.mask[a01] * w01 + skn.mask[a11] * w11; if (m > 0.01) { LC.lutAt(skn.lut, data[p] / 255, data[p + 1] / 255, data[p + 2] / 255, t2, 0); r += (t2[0] - r) * m; g += (t2[1] - g) * m; b += (t2[2] - b) * m; } }
        let bgw = 0;
        if (cm) {
          const m = cm[a00] * w00 + cm[a10] * w10 + cm[a01] * w01 + cm[a11] * w11; bgw = 1 - m;
          LC.lutAt(cr.bg, r, g, b, t2, 0); LC.lutAt(cr.sj, r, g, b, t3, 0);
          r = t2[0] * bgw + t3[0] * m; g = t2[1] * bgw + t3[1] * m; b = t2[2] * bgw + t3[2] * m;
        }
        const e = Math.exp(G); r *= e; g *= e; b *= e;
        for (const sl of sls) { const m = sl.mask[a00] * w00 + sl.mask[a10] * w10 + sl.mask[a01] * w01 + sl.mask[a11] * w11, a = m * sl.a;
          if (a > 0.005 || a < -0.005) { const L = Math.max(1e-4, luma(r, g, b)), Lc = Math.min(1, L), L2 = Lc * (1 + a) / (1 + a * Lc), k = L2 / L; r *= k; g *= k; b *= k; const mx = Math.max(r, g, b); if (mx > 1) { const L3 = luma(r, g, b), t = Math.min(1, (mx - 1) / Math.max(1e-4, mx - L3)); r -= (r - L3) * t; g -= (g - L3) * t; b -= (b - L3) * t; } } }
        if (pp) { const m = pp.mask ? pp.mask[a00] * w00 + pp.mask[a10] * w10 + pp.mask[a01] * w01 + pp.mask[a11] * w11 : 1, P = pp.a;
          // pop: the person gets depth (brighter lights, firmer shadows) and richer colour; the background steps back a little so they stand off it
          if (m > 0.01) { const L = Math.max(1e-4, luma(r, g, b)), Lc = Math.min(1, L), pv = 0.3, kx = 1 + 0.6 * P * m, L2 = Lc < pv ? pv * Math.pow(Lc / pv, 1 + 0.35 * P * m) : 1 - (1 - pv) * Math.pow((1 - Lc) / (1 - pv), kx), sc = L2 / L, st = 1 + 0.32 * P * m;
            r = L2 + (r * sc - L2) * st; g = L2 + (g * sc - L2) * st; b = L2 + (b * sc - L2) * st;
            const mx = Math.max(r, g, b); if (mx > 1) { const t = Math.min(1, (mx - 1) / Math.max(1e-4, mx - L2)); r -= (r - L2) * t; g -= (g - L2) * t; b -= (b - L2) * t; } if (r < 0) r = 0; if (g < 0) g = 0; if (b < 0) b = 0; }
          if (pp.mask && m < 0.99) { const e = Math.pow(2, -0.5 * P * (1 - m)); r *= e; g *= e; b *= e; } }
        // skin never goes orange: colour above a natural level is eased back on the person's skin (lifting dark skin a lot would otherwise multiply its colour)
        for (const skn of skns) if (skn.cap) { const m = skn.mask[a00] * w00 + skn.mask[a10] * w10 + skn.mask[a01] * w01 + skn.mask[a11] * w11;
          if (m > 0.02) { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), st = mx > 1e-4 ? (mx - mn) / mx : 0, cap = skn.cap;
            if (st > cap) { const f = 1 - m * (1 - (cap + (st - cap) * 0.3) / st), L = luma(r, g, b); r = L + (r - L) * f; g = L + (g - L) * f; b = L + (b - L) * f; }
            // and never ashy: skin that lost its colour (lifted from deep shadow, cooled by the white balance) gets it back, in its own warm hue
            // skin that has gone cool (lavender, gray-blue from the ambient light) is warmed back toward its own brown
            if (b > g * 0.9 && r > g) { const nb = g * 0.9 + (b - g * 0.9) * (1 - 0.75 * m); b = nb; }
            if (skn.floor && st < skn.floor && st > 0.04 && r >= g && g >= b * 0.95) { const want = skn.floor - (skn.floor - st) * 0.25, f = 1 + m * Math.min(0.9, want / st - 1), L = luma(r, g, b);
              r = L + (r - L) * f; g = L + (g - L) * f; b = L + (b - L) * f; const mx2 = Math.max(r, g, b); if (mx2 > 1) { r /= mx2; g /= mx2; b /= mx2; } if (b < 0) b = 0; } } }
        // clean whites last, on the finished colour of the people
        if (wh) { const m = wh.mask[a00] * w00 + wh.mask[a10] * w10 + wh.mask[a01] * w01 + wh.mask[a11] * w11; if (m > 0.01) { LC.lutAt(wh.lut, Math.min(1, Math.max(0, r)), Math.min(1, Math.max(0, g)), Math.min(1, Math.max(0, b)), t2, 0); r += (t2[0] - r) * m; g += (t2[1] - g) * m; b += (t2[2] - b) * m; } }
        if (cbl && cbAmt) { const q = 3 * a00, q1 = 3 * a10, q2 = 3 * a01, q3 = 3 * a11, k = cbAmt * (0.12 + 0.88 * bgw) * (1 - 0.75 * Math.min(1, luma(r, g, b)));
          const br = cbl[q] * w00 + cbl[q1] * w10 + cbl[q2] * w01 + cbl[q3] * w11, bg2 = cbl[q + 1] * w00 + cbl[q1 + 1] * w10 + cbl[q2 + 1] * w01 + cbl[q3 + 1] * w11, bb = cbl[q + 2] * w00 + cbl[q1 + 2] * w10 + cbl[q2 + 2] * w01 + cbl[q3 + 2] * w11;
          r = 1 - (1 - r) * (1 - Math.min(1, br * k)); g = 1 - (1 - g) * (1 - Math.min(1, bg2 * k)); b = 1 - (1 - b) * (1 - Math.min(1, bb * k)); }
        if (cpart) { const a = cpart[p + 3] / 255 * (0.08 + 0.92 * bgw); if (a > 0.003) { r += (cpart[p] / 255 - r) * a; g += (cpart[p + 1] / 255 - g) * a; b += (cpart[p + 2] / 255 - b) * a; } }
        if (sky) {
          const m = sky[a00] * w00 + sky[a10] * w10 + sky[a01] * w01 + sky[a11] * w11;
          if (m > 0.001) { const L = luma(r, g, b), k = 1 + ssat * m; r = L + (r - L) * k; g = L + (g - L) * k; b = L + (b - L) * k; r *= 1 + stemp * m; b *= 1 - stemp * m; }
        }
        const L = luma(r, g, b); let add = 0;
        if (cl) { const bb = B1[a00] * w00 + B1[a10] * w10 + B1[a01] * w01 + B1[a11] * w11; const mid = Math.max(0, Math.min(1, 4 * L * (1 - L))); add += (L - bb) * cl * (0.35 + 0.65 * mid); }
        if (dz) { const bb = B2[a00] * w00 + B2[a10] * w10 + B2[a01] * w01 + B2[a11] * w11; add += (L - bb) * dz; }
        if (gAmt > 0) add += tile[trow + ((x + 97) % T)] * gAmt * (1.15 - 0.5 * L);
        r += add; g += add; b += add;
        data[p] = r * 255 + 0.5; data[p + 1] = g * 255 + 0.5; data[p + 2] = b * 255 + 0.5;
      }
    }
  }
  /* light unsharp mask on luminance (3x3), rows [y0,y1) using a copy of the source rows */
  function sharpen(data, W, H, amount, thr) {
    if (amount <= 0) return; const k = amount / 100 * 0.9, src = new Uint8ClampedArray(data), T = thr || 1.2;   // below the grain level nothing is sharpened
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const p = 4 * (y * W + x);
      const Lc = luma(src[p], src[p + 1], src[p + 2]);
      let s = 0; for (const o of [-4, 4, -4 * W, 4 * W, -4 * W - 4, -4 * W + 4, 4 * W - 4, 4 * W + 4]) s += luma(src[p + o], src[p + o + 1], src[p + o + 2]);
      let d0 = Lc - s / 8; if (Math.abs(d0) < T) continue; let d = (d0 - Math.sign(d0) * T * 0.6) * k; d = Math.max(-40, Math.min(40, d));
      data[p] += d; data[p + 1] += d; data[p + 2] += d;
    }
  }
  let NOISE = null, NOISE_FINE = 1;
  function noise() {
    if (NOISE) return NOISE; const T = 512; let seed = 1234567; const R = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const a = new Float32Array(T * T); for (let i = 0; i < a.length; i++) { const u = Math.max(R(), 1e-9), v = R(); a[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
    const b = LC.blur(a, T, T, 0.7); let m = 0, q = 0; for (const x of b) { m += x; q += x * x; } m /= b.length; const sd = Math.sqrt(q / b.length - m * m);
    for (let i = 0; i < b.length; i++) b[i] = (b[i] - m) / sd;
    const bl = LC.blur(b, T, T, 1.2); let qq = 0; for (let i = 0; i < b.length; i++) qq += (b[i] - bl[i]) ** 2; NOISE_FINE = Math.sqrt(qq / b.length);
    NOISE = b; return b;
  }

  /* ---------- auto: exposure + white balance suggestion ---------- */
  function auto(small) {
    const { rgb } = small, n = rgb.length / 3; const Ls = new Float32Array(n);
    let sr = 0, sg = 0, sb = 0, c = 0;
    for (let i = 0; i < n; i++) {
      const r = rgb[3 * i], g = rgb[3 * i + 1], b = rgb[3 * i + 2], L = luma(r, g, b); Ls[i] = L;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (L > 0.2 && L < 0.92 && (mx - mn) / mx < 0.25) { sr += lin(r); sg += lin(g); sb += lin(b); c++; }
    }
    Ls.sort(); const med = Ls[(n / 2) | 0], p98 = Ls[(n * 0.98) | 0];
    let ev = Math.log2(0.42 / Math.max(0.02, med)) * 0.75; ev = Math.max(-1.5, Math.min(1.5, Math.min(ev, Math.log2(0.97 / Math.max(0.05, p98)) + 0.4)));
    let temp = 0, tint = 0;
    if (c > n * 0.01) { const rr = sr / c, gg = sg / c, bb = sb / c; temp = Math.max(-60, Math.min(60, -Math.log(rr / bb) / 0.56 * 100 * 0.7)); tint = Math.max(-12, Math.min(12, Math.log(gg / ((rr + bb) / 2)) / 0.16 * 100 * 0.3));   /* gentle: a green shift to fix a pinkish dress grays the skin, and the dress is cleaned on its own */ }
    return { ev: +ev.toFixed(2), temp: Math.round(temp), tint: Math.round(tint) };
  }

  /* where people are: skin-coloured pixels, weighted toward the in-focus subject */
  function skinMap(small, sm) {
    const { w, h, rgb } = small, n = w * h, S = new Float32Array(n), hsv = [0, 0, 0], Ls = [];
    for (let i = 0; i < n; i++) {
      const r = rgb[3 * i], g = rgb[3 * i + 1], b = rgb[3 * i + 2]; rgb2hsv(r, g, b, hsv);
      const sk = hsv[0] >= 4 && hsv[0] <= 50 && hsv[1] > 0.18 && hsv[1] < 0.92 && hsv[2] > 0.04 && hsv[2] < 0.9 && r > g && g >= b * 0.85 ? 1 : 0;
      const m = sm ? sm.mask[i] : 1; S[i] = sk * clamp01((m - 0.15) / 0.45);
      if (S[i] > 0.6) Ls.push(luma(r, g, b));
    }
    return { S, Ls };
  }
  /* face pixels: in-focus skin in the upper part of where skin appears (faces sit above shoulders, arms and hands) */
  function faceSkin(small, sm) {
    const { S } = skinMap(small, sm), w = small.w, ys = [], px = [];
    for (let i = 0; i < S.length; i++) if (S[i] > 0.6) { px.push(i); ys.push((i / w) | 0); }
    if (px.length < 50) return px;
    const so = ys.slice().sort((a, b) => a - b), y0 = so[(so.length * 0.03) | 0], y1 = so[(so.length * 0.97) | 0], cut = y0 + (y1 - y0) * 0.45;
    const top = px.filter((_, k) => ys[k] <= cut); return top.length > px.length * 0.12 ? top : px;
  }
  function skinSat(small, sm) { const { S } = skinMap(small, sm), hsv = [0, 0, 0], a = [], h2 = []; for (let i = 0; i < S.length; i++) if (S[i] > 0.6) { rgb2hsv(small.rgb[3 * i], small.rgb[3 * i + 1], small.rgb[3 * i + 2], hsv); a.push(hsv[1]); h2.push(hsv[0]); } a.sort((x, y) => x - y); h2.sort((x, y) => x - y); return [a[(a.length / 2) | 0], h2[(h2.length / 2) | 0]]; }
  function refine(M, small, r, eps) {
    const { w, h, rgb } = small, n = w * h, I = new Float32Array(n), IP = new Float32Array(n), II = new Float32Array(n);
    for (let i = 0; i < n; i++) { I[i] = luma(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]); IP[i] = I[i] * M[i]; II[i] = I[i] * I[i]; }
    const mI = LC.blur(I, w, h, r), mP = LC.blur(M, w, h, r), mIP = LC.blur(IP, w, h, r), mII = LC.blur(II, w, h, r), A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) { A[i] = (mIP[i] - mI[i] * mP[i]) / (mII[i] - mI[i] * mI[i] + eps); B[i] = mP[i] - A[i] * mI[i]; }
    const mA = LC.blur(A, w, h, r), mB = LC.blur(B, w, h, r), O = new Float32Array(n); for (let i = 0; i < n; i++) O[i] = clamp01(mA[i] * I[i] + mB[i]);
    return O;
  }
  /* soft region to brighten: the people (skin, spread to faces and arms) plus the in-focus subject */
  function liftMask(small, sm) {
    const { w, h } = small, n = w * h, big = Math.max(w, h), { S } = skinMap(small, sm);
    // tight skin shape: a blurred yes/no map cut at the halfway point keeps the true edge, fills small holes (eyes, lips), drops specks
    const B = LC.blur(S, w, h, 0.012 * big), M = new Float32Array(n);
    for (let i = 0; i < n; i++) M[i] = clamp01((B[i] - 0.38) / 0.24);
    // snap to real edges in the photo so nothing spills onto hair or background
    return { mask: refine(M, small, 0.008 * big, 0.0008) };
  }
  /* People found by Claude (boxes) -> exact masks. bm = { box, core, face } maps at small size (1 inside).
     Skin is learned from the person's own face, so it works for any skin tone and any lighting;
     the person is separated from the background by colour (what's inside the body box vs what's outside every box). */
  /* a smooth curve through the points (monotone, so it never overshoots), as a 256-step table */
  function curveFn(pts) {
    const P = (pts || [[0, 0], [1, 1]]).slice().sort((a, b) => a[0] - b[0]), n = P.length, out = new Float32Array(256);
    if (n < 2) { for (let i = 0; i < 256; i++) out[i] = i / 255; return out; }
    const dx = [], dy = [], m = []; for (let i = 0; i < n - 1; i++) { dx.push(Math.max(1e-6, P[i + 1][0] - P[i][0])); dy.push((P[i + 1][1] - P[i][1]) / dx[i]); }
    m.push(dy[0]); for (let i = 1; i < n - 1; i++) m.push(dy[i - 1] * dy[i] <= 0 ? 0 : 3 * (dx[i - 1] + dx[i]) / ((2 * dx[i] + dx[i - 1]) / dy[i - 1] + (dx[i] + 2 * dx[i - 1]) / dy[i])); m.push(dy[n - 2]);
    for (let k = 0; k < 256; k++) { const x = k / 255; let i = 0; while (i < n - 2 && x > P[i + 1][0]) i++;
      if (x <= P[0][0]) { out[k] = P[0][1]; continue; } if (x >= P[n - 1][0]) { out[k] = P[n - 1][1]; continue; }
      const h = dx[i], t = (x - P[i][0]) / h, t2 = t * t, t3 = t2 * t; out[k] = Math.max(0, Math.min(1, (2 * t3 - 3 * t2 + 1) * P[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * P[i + 1][1] + (t3 - t2) * h * m[i + 1])); }
    return out;
  }
  /* how deep a person's skin is (0 light .. 1 deep), from the colour of their own face: deeper skin is more saturated */
  function skinDepthOf(small, facePx) { const { rgb } = small, hv = [0, 0, 0]; if (!facePx || facePx.length < 20) return 0.5;
    const a = facePx.map(i => { rgb2hsv(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2], hv); return hv[1]; }).sort((x, y) => x - y); return clamp01((a[(a.length / 2) | 0] - 0.44) / 0.14); }
  function peopleMasks(small, bm, paint) {
    const { w, h, rgb } = small, n = w * h, big = Math.max(w, h), t = [0, 0, 0];
    const La = new Float32Array(n), Aa = new Float32Array(n), Ba = new Float32Array(n);
    for (let i = 0; i < n; i++) { LC.rgb2lab(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2], t); La[i] = t[0]; Aa[i] = t[1]; Ba[i] = t[2]; }
    let skin = new Float32Array(n), facePx = [], away = false;
    const fi = []; for (let i = 0; i < n; i++) if (bm.face[i] > 0.5) fi.push(i);
    if (fi.length > 30) {
      // skin is smooth; hair (even copper or blonde hair the colour of skin) is full of fine texture. Texture = local brightness variation.
      const Lm = new Float32Array(n), L2 = new Float32Array(n); for (let i = 0; i < n; i++) { Lm[i] = La[i] / 100; L2[i] = Lm[i] * Lm[i]; }
      const rT = Math.max(1.5, 0.006 * big), bm1 = LC.blur(Lm, w, h, rT), bm2 = LC.blur(L2, w, h, rT), Tx = new Float32Array(n);
      for (let i = 0; i < n; i++) Tx[i] = Math.sqrt(Math.max(0, bm2[i] - bm1[i] * bm1[i])) / (bm1[i] + 0.06);
      const smooth = i => Tx[i] < 0.11;
      const warm = i => { const C = Math.hypot(Aa[i], Ba[i]), hu = Math.atan2(Ba[i], Aa[i]) * 57.3; return C > 5 && hu > 5 && hu < 90 && La[i] > 6 && La[i] < 92; };
      let cand = fi.filter(i => warm(i) && smooth(i));
      // a face turned away (only hair shows): learn the skin from the shoulders, back and arms below the head instead
      if (cand.length < fi.length * 0.25) { let fb = -1; for (const i of fi) fb = Math.max(fb, (i / w) | 0);
        const body = []; for (let i = 0; i < n; i += 2) if (bm.core[i] > 0.5 && ((i / w) | 0) > fb && warm(i) && smooth(i) && La[i] < 75) body.push(i);
        if (body.length > Math.max(200, fi.length * 0.06)) { away = true; cand = cand.concat(body); facePx.length = 0; for (const i of body) facePx.push(i); } }
      if (cand.length < fi.length * 0.15) cand = fi.filter(warm).length > fi.length * 0.15 ? fi.filter(warm) : fi;
      const md = a => { a.sort((x, y) => x - y); return a[(a.length / 2) | 0]; };
      const ma = md(cand.map(i => Aa[i])), mb = md(cand.map(i => Ba[i])), mL = md(cand.map(i => La[i]));
      const sd = Math.max(6, (away ? 2.4 : 1.7) * md(cand.map(i => Math.hypot(Aa[i] - ma, Ba[i] - mb)))), C0 = Math.hypot(ma, mb), h0 = Math.atan2(mb, ma);
      for (let i = 0; i < n; i++) {
        if (bm.box[i] < 0.5) continue; const d = Math.hypot(Aa[i] - ma, Ba[i] - mb) / sd, C = Math.hypot(Aa[i], Ba[i]);
        const lw = clamp01((La[i] - (mL - 55)) / 8) * clamp01(((mL + 24) - La[i]) / 6) * clamp01((C - 0.35 * C0) / (0.2 * C0 + 1));
        let dh = Math.atan2(Ba[i], Aa[i]) - h0; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI;
        skin[i] = clamp01((Math.exp(-0.7 * d * d) * lw * Math.exp(-(dh / (away ? 0.6 : 0.4)) * (dh / (away ? 0.6 : 0.4))) - 0.3) / 0.3) * clamp01((0.22 - Tx[i]) / 0.08);   /* textured = hair, not skin */
      }
      // keep skin that belongs to the person: joined to a face, or sharp (hands, arms). Skin-coloured blurry background is dropped.
      const fm = subjectMask(small, null).mask, lab = new Int32Array(n).fill(-1), st = [];
      for (let s0 = 0; s0 < n; s0++) { if (skin[s0] < 0.5 || lab[s0] >= 0) continue; const comp = [s0]; lab[s0] = s0; st.push(s0); let touch = false, fsum = 0, csum = 0;
        while (st.length) { const j = st.pop(), x = j % w, y = (j / w) | 0; if (bm.face[j] > 0.5) touch = true; fsum += fm[j]; csum += bm.box[j];
          for (const q of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) if (q >= 0 && lab[q] < 0 && skin[q] >= 0.5) { lab[q] = s0; comp.push(q); st.push(q); } }
        if (!touch && !(csum / comp.length > 0.9 && comp.length > n * 0.004) && (fsum / comp.length < 0.45 || comp.length < n * 0.0006)) for (const j of comp) skin[j] = 0; }
      for (let i = 0; i < n; i++) if (skin[i] < 0.5 && lab[i] < 0) skin[i] = 0;
      if (!facePx.length) for (const i of fi) if (skin[i] > 0.6 && smooth(i)) facePx.push(i);
      if (facePx.length < 20) for (const i of fi) if (skin[i] > 0.6) facePx.push(i);
    } else { const g = skinMap(small, { mask: bm.box }).S; for (let i = 0; i < n; i++) skin[i] = g[i] * bm.box[i]; }
    { // solid skin shape: close small gaps everywhere, and fill the whole face (eyes, lips, shine) so edits cover it evenly
      // the whole face counts as skin, shadows included (a hand's shadow on the cheek is still cheek), with a soft edge
      const B = LC.blur(skin, w, h, 0.006 * big), faceSoft = LC.blur(bm.face, w, h, 0.012 * big);
      for (let i = 0; i < n; i++) skin[i] = Math.max(clamp01((B[i] - 0.25) / 0.25), away ? 0 : faceSoft[i] * (La[i] > 4 && La[i] < 92 ? 1 : 0));   /* a face turned away is hair, not skin */
      const r = refine(skin, small, 0.006 * big, 0.002); for (let i = 0; i < n; i++) skin[i] = clamp01((r[i] - 0.15) / 0.6); }
    // person vs background by colour
    const NL = 8, NA = 10, NB = 10, fg = new Float32Array(NL * NA * NB), bg = new Float32Array(NL * NA * NB), bin = new Uint16Array(n); let ft = 0, bt = 0;
    for (let i = 0; i < n; i++) { const b = Math.min(NL - 1, (La[i] / 100 * NL) | 0) * NA * NB + Math.min(NA - 1, Math.max(0, ((Aa[i] + 50) / 100 * NA) | 0)) * NB + Math.min(NB - 1, Math.max(0, ((Ba[i] + 50) / 100 * NB) | 0)); bin[i] = b;
      if (bm.core[i] > 0.5) { fg[b]++; ft++; } else if (bm.box[i] < 0.5) { bg[b]++; bt++; } }
    let P = new Float32Array(n);
    if (bt > n * 0.03 && ft > 50) { for (let i = 0; i < n; i++) { if (bm.box[i] < 0.5) continue; const f = fg[bin[i]] / ft, b = bg[bin[i]] / bt; P[i] = Math.max((f + 1e-5) / (f + b + 2e-5) * (0.75 + 0.25 * bm.core[i]), skin[i]); } }
    else for (let i = 0; i < n; i++) P[i] = bm.box[i];
    P = LC.blur(P, w, h, 0.012 * big); let person = new Float32Array(n);
    for (let i = 0; i < n; i++) person[i] = clamp01(Math.max((P[i] - 0.42) / 0.2, skin[i], bm.lower ? bm.lower[i] : 0) + (paint ? paint[i] : 0));
    // close holes inside the body (dress folds, shadows the colour test missed) so no patch of the person is treated as background
    { // true holes: background-looking pixels that the real background (reached from the frame edge) can't get to
      const seen = new Uint8Array(n), st = [];
      for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const i = y * w + x; if (y === h - 1 && bm.box[(h - 4) * w + x] > 0.5) continue; /* a person cut off by the bottom of the frame: the bottom edge there is them, not background */ if (person[i] < 0.5 && !seen[i]) { seen[i] = 1; st.push(i); } }
      for (let y = 0; y < h; y++) for (const x of [0, w - 1]) { const i = y * w + x; if (y > h * 0.8 && bm.box[i] > 0.5 && bm.box[(h - 4) * w + x] > 0.5) continue; /* the body running out of the frame low on the sides */ if (person[i] < 0.5 && !seen[i]) { seen[i] = 1; st.push(i); } }
      while (st.length) { const j = st.pop(), x = j % w, y = (j / w) | 0; for (const q of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) if (q >= 0 && !seen[q] && person[q] < 0.5) { seen[q] = 1; st.push(q); } }
      const hole = new Float32Array(n); for (let i = 0; i < n; i++) hole[i] = person[i] < 0.5 && !seen[i] && bm.box[i] > 0.5 ? 1 : 0;
      const hb = LC.blur(hole, w, h, 0.004 * big); for (let i = 0; i < n; i++) person[i] = Math.max(person[i], clamp01(hb[i] * 2.5));
      // and narrow gaps the flood can slip through
      const C = LC.blur(person, w, h, 0.05 * big); for (let i = 0; i < n; i++) if (bm.box[i] > 0.5) person[i] = Math.max(person[i], clamp01((C[i] - 0.62) / 0.15)); }
    const r = refine(person, small, 0.01 * big, 0.001), tight = new Float32Array(n), inner = LC.blur(person, w, h, 0.02 * big); for (let i = 0; i < n; i++) tight[i] = Math.max(clamp01((r[i] - 0.4) / 0.35), clamp01((inner[i] - 0.9) / 0.08)); /* edge refinement only shapes the outline: deep inside the person (dark dress folds) stays person */
    let tot = 0; for (let i = 0; i < n; i++) tot += tight[i];
    // light and colour go on as one smooth wash over the person's skin areas (face, neck, shoulders, arms), fading out gently,
    // and are held inside the person so nothing reaches the background. A pixel-exact skin map here would leave blotches.
    const pe = LC.blur(tight, w, h, 0.0025 * big), wide = LC.blur(skin, w, h, 0.035 * big), soft = new Float32Array(n);
    for (let i = 0; i < n; i++) soft[i] = Math.min(pe[i], clamp01(wide[i] * 2.2));
    // the faces: soft ovals from the face boxes, kept inside the person
    const fo = LC.blur(bm.face, w, h, 0.02 * big), face = new Float32Array(n); for (let i = 0; i < n; i++) face[i] = Math.min(clamp01(fo[i] * 1.6), clamp01(pe[i] * 1.5));
    // hair: textured, not skin, on the person, around a head. Light meant for the skin stays off it, so hair keeps its own colour and depth
    const hair = new Float32Array(n); { const Lm = new Float32Array(n), L2 = new Float32Array(n); for (let i = 0; i < n; i++) { Lm[i] = La[i] / 100; L2[i] = Lm[i] * Lm[i]; }
      const rT = Math.max(1.5, 0.006 * big), m1 = LC.blur(Lm, w, h, rT), m2 = LC.blur(L2, w, h, rT), near = LC.blur(bm.face, w, h, 0.05 * big);
      for (let i = 0; i < n; i++) { const tx = Math.sqrt(Math.max(0, m2[i] - m1[i] * m1[i])) / (m1[i] + 0.06); hair[i] = pe[i] * clamp01((tx - 0.13) / 0.1) * (1 - Math.min(1, skin[i] * 1.5)) * clamp01((near[i] - 0.03) / 0.08); }
      const hb = LC.blur(hair, w, h, 0.006 * big); for (let i = 0; i < n; i++) hair[i] = Math.min(1, hb[i] * 1.6) * pe[i]; }
    return { person: pe, skin: LC.blur(soft, w, h, 0.004 * big), skinTight: skin, face, facePx, hair, frac: tot / n };
  }
  /* automatic dodge & burn, as log-gain maps at map resolution:
     dodge = sculpt light on the people (lift their local highlights, deepen their contours),
     burn  = darken the background, more toward the frame edges and on bright distractions, so the eye goes to the subject */
  /* the people in the frame: in-focus skin spread to faces/arms, the focus subject, carried down to bodies */
  function personMask(small, sm) {
    const { w, h } = small, n = w * h, big = Math.max(w, h), people = liftMask(small, sm).mask;
    const seed = new Float32Array(n); for (let i = 0; i < n; i++) seed[i] = Math.max(sm.mask[i], people[i]);
    let R = LC.blur(seed, w, h, 0.05 * big); let rmx = 0; for (let i = 0; i < n; i++) rmx = Math.max(rmx, R[i]);
    for (let i = 0; i < n; i++) R[i] = clamp01((R[i] / Math.max(1e-4, rmx) - 0.2) / 0.3);
    const dec = Math.pow(0.15, 1 / h);
    for (let x = 0; x < w; x++) { let carry = 0; for (let y = 0; y < h; y++) { const i = y * w + x; carry = Math.max(R[i], carry * dec); R[i] = carry; } }
    R = LC.blur(R, w, h, 0.03 * big);
    const person = new Float32Array(n); for (let i = 0; i < n; i++) person[i] = Math.max(sm.mask[i], people[i], R[i] * 0.9);
    return { people, R, person };
  }
  function dodgeBurnMaps(small, sm, pmk, fs) {
    const { w, h, rgb } = small, n = w * h, L = new Float32Array(n), big = Math.max(w, h);
    for (let i = 0; i < n; i++) L[i] = luma(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]);
    const pk = pmk || personMask(small, sm), people = pk.people, body = pk.person || sm.mask;
    // where the light already falls on the person, at the scale of forms (a cheek, an arm), not skin detail
    const lb = new Float32Array(n); for (let i = 0; i < n; i++) lb[i] = Math.log(L[i] + 0.03);
    const m1 = LC.blur(lb, w, h, 0.012 * big), m2 = LC.blur(lb, w, h, 0.06 * big);
    let cx = 0, cy = 0, ct = 0; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const m = Math.max(sm.mask[y * w + x], people[y * w + x]); cx += x * m; cy += y * m; ct += m; }
    cx = ct ? cx / ct : w / 2; cy = ct ? cy / ct : h / 2;
    const rMax = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
    // which side of the face is lit: dodge that side more, burn the shadow side more (exaggerate the light that's there)
    let wl = 0.5, wr = 0.5;
    if (fs) { let sl = 0, cl = 0, sr = 0, cr = 0; for (let i = 0; i < n; i++) { const sk = people[i]; if (sk < 0.4) continue; sl += lb[i] * fs.dL[i] * sk; cl += fs.dL[i] * sk; sr += lb[i] * fs.dR[i] * sk; cr += fs.dR[i] * sk; }
      if (cl > 1 && cr > 1) { const t = Math.max(-1, Math.min(1, (sl / cl - sr / cr) / 0.35)); wl = 0.5 + 0.3 * t; wr = 0.5 - 0.3 * t; } }
    const dodge = new Float32Array(n), burn = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, pm = people[i];
      // body and any skin without a face map: deepen the existing light and shade on its forms
      const form = Math.max(-0.22, Math.min(0.22, (m1[i] - m2[i]) * 0.9));
      let f = 0, b = 0;
      if (fs) { const face = Math.min(1, fs.dL[i] + fs.dR[i] + fs.bL[i] + fs.bR[i]); f = 2 * (fs.dL[i] * wl + fs.dR[i] * wr); b = 2 * (fs.bL[i] * (1 - wl) + fs.bR[i] * (1 - wr)); const fb = body[i]; const room = clamp01((0.92 - L[i]) / 0.45); dodge[i] = fb * 1.0 * f * room + pm * form * (1 - 0.6 * face); burn[i] = -fb * 1.0 * b; }
      else dodge[i] = pm * form;
      const r = Math.hypot(x - cx, y - cy) / rMax, e = r < 0.3 ? 0 : Math.min(1, (r - 0.3) / 0.7);
      burn[i] += -0.12 * e * e;   // soft edge burn that pulls the eye in
    }
    return { dodge: LC.blur(dodge, w, h, 0.005 * big), burn: LC.blur(burn, w, h, 0.006 * big) };
  }
  /* Auto with pop: expose for the faces (like a photographer would), hold the bright lights, add depth, then skin match + dodge & burn */
  function autoPop(small, sm, facePx) {
    const a = auto(small), { rgb } = small, n = rgb.length / 3;
    const enc = v => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    const fpx = facePx && facePx.length > 40 ? facePx : faceSkin(small, sm);
    const sk = fpx.map(i => luma(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2])).sort((x, y) => x - y);
    let ev = a.ev, depth = 0.5, missing = 0, soft = false;
    if (sk.length > n * 0.004) {
      const sMed = sk[(sk.length * 0.45) | 0], sat = (() => { const hv = [0, 0, 0], a = fpx.map(i => { rgb2hsv(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2], hv); return hv[1]; }).sort((x, y) => x - y); return a[(a.length / 2) | 0]; })();
      // deeper skin is more saturated and its highlights stay well under the whites in the frame
      depth = clamp01((sat - 0.44) / 0.14);
      const Tg = 0.52 - 0.13 * depth;               // where the skin midtone should sit
      // never push the bright side of the face past a clean highlight
      const hi = sk[(sk.length * 0.92) | 0];
      const want = Math.max(-1, Math.min(1.9, Math.log2(lin(Tg * 0.9) / Math.max(0.004, lin(sMed)))));
      const exact = !!(facePx && facePx.length > 40);   // people located exactly: keep the global move modest, the rest goes on their skin only
      ev = Math.min(want, exact ? 0.7 : 1.9, Math.max(-1, Math.log2(lin(0.64) / Math.max(0.004, lin(hi)))));
      if (exact) soft = true;
      missing = Math.max(0, want - ev);   // exposure the highlights wouldn't allow: open the shadows instead (no masks, so no glow)
    }
    // white balance from the whites the person is wearing (dress, shirt): those should come out clean white
    let temp = a.temp * 0.35, tint = a.tint * 0.5;
    { let sr = 0, sg = 0, sb = 0, c = 0;
      for (let i = 0; i < n; i++) { if (sm && sm.mask[i] < 0.5) continue; const r = rgb[3 * i], g = rgb[3 * i + 1], b = rgb[3 * i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx > 0.5 && mx < 0.97 && (mx - mn) / mx < 0.3) { sr += lin(r); sg += lin(g); sb += lin(b); c++; } }
      if (c > n * 0.01) { const rr = sr / c, gg = sg / c, bb = sb / c; temp = Math.max(-25, Math.min(30, -Math.log(rr / bb) / 0.56 * 100 * 0.35));   /* only part of the way: the dress is cleaned on its own, and cooling the whole photo turns deep skin ashy */ tint = Math.max(-12, Math.min(12, Math.log(gg / ((rr + bb) / 2)) / 0.16 * 100 * 0.3));   /* gentle: a green shift to fix a pinkish dress grays the skin, and the dress is cleaned on its own */ } }
    const k = Math.pow(2, ev), all = new Float32Array(n);
    for (let i = 0; i < n; i++) all[i] = enc(Math.min(1, lin(luma(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2])) * k));
    all.sort(); const p98 = all[(n * 0.98) | 0], p02 = all[(n * 0.02) | 0], bright = p98 > 0.9;
    return { ev: +ev.toFixed(2), temp: Math.round(temp), tint: Math.round(tint), subjLight: 0, skinDepth: +depth.toFixed(2), skinMatch: 100,
      highlights: bright ? -55 : -25, shadows: Math.round(Math.min(55, 6 + (soft ? 14 : 34) * missing)), whites: bright ? 0 : 14, blacks: p02 > 0.06 ? -30 : -18,
      contrast: 26, clarity: 18, vibrance: 18, dehaze: 4, dodgeBurn: 60, skinSmooth: 60, pop: 60,
      // with the people found, the edit goes on them; the background stays close to how it was shot
      bgEdit: soft ? 15 : 100 };
  }
  /* ---------- culling analysis ---------- */
  function analyze(data, W, H) {
    const n = W * H, L = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = luma(data[4 * i], data[4 * i + 1], data[4 * i + 2]) / 255;
    // sharpness: tile-wise Laplacian energy relative to tile contrast; best tiles = subject in focus
    const TX = 8, TY = 8, tiles = [];
    for (let ty = 0; ty < TY; ty++) for (let tx = 0; tx < TX; tx++) {
      const x0 = Math.max(1, (tx * W / TX) | 0), x1 = Math.min(W - 1, ((tx + 1) * W / TX) | 0), y0 = Math.max(1, (ty * H / TY) | 0), y1 = Math.min(H - 1, ((ty + 1) * H / TY) | 0);
      let e = 0, s = 0, q = 0, c = 0;
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { const i = y * W + x; const lap = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - W] - L[i + W]; e += Math.abs(lap); s += L[i]; q += L[i] * L[i]; c++; }
      if (!c) continue; const m = s / c, sd = Math.sqrt(Math.max(0, q / c - m * m));
      tiles.push({ e: e / c, sd, score: (e / c) / (sd + 0.035) });
    }
    tiles.sort((a, b) => b.score - a.score);
    const sharp = (tiles[0].score + tiles[1].score + tiles[2].score) / 3, detail = (tiles[0].e + tiles[1].e + tiles[2].e) / 3;
    // exposure
    let blown = 0, crushed = 0; const hist = new Uint32Array(64);
    for (let i = 0; i < n; i++) { const v = L[i]; if (v > 0.985) blown++; if (v < 0.015) crushed++; }
    // colour signature 4x4x4
    const sig = new Float32Array(64); for (let i = 0; i < n; i += 3) { const p = 4 * i; sig[((data[p] >> 6) << 4) | ((data[p + 1] >> 6) << 2) | (data[p + 2] >> 6)]++; }
    let st = 0; for (const v of sig) st += v; for (let i = 0; i < 64; i++) sig[i] /= st;
    // dHash 9x8
    const gw = 9, gh = 8, g = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { let s = 0, c = 0; const xa = (x * W / gw) | 0, xb = ((x + 1) * W / gw) | 0, ya = (y * H / gh) | 0, yb = ((y + 1) * H / gh) | 0; for (let yy = ya; yy < yb; yy += 2) for (let xx = xa; xx < xb; xx += 2) { s += L[yy * W + xx]; c++; } g[y * gw + x] = s / Math.max(1, c); }
    let h0 = 0, h1 = 0; for (let y = 0; y < gh; y++) for (let x = 0; x < 8; x++) { const bit = g[y * gw + x] > g[y * gw + x + 1] ? 1 : 0, k = y * 8 + x; if (k < 32) h0 |= bit << k; else h1 |= bit << (k - 32); }
    const Ls = Float32Array.from(L).sort();
    return { sharp: +sharp.toFixed(4), detail: +detail.toFixed(5), blown: +(blown / n).toFixed(4), crushed: +(crushed / n).toFixed(4), med: +Ls[(n / 2) | 0].toFixed(3), sig: Array.from(sig, v => +v.toFixed(4)), hash: [h0 >>> 0, h1 >>> 0] };
  }
  const popcnt = x => { x = x - ((x >>> 1) & 0x55555555); x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; };
  const hamming = (a, b) => popcnt((a[0] ^ b[0]) >>> 0) + popcnt((a[1] ^ b[1]) >>> 0);
  const histSim = (a, b) => { let s = 0; for (let i = 0; i < 64; i++) s += Math.min(a[i], b[i]); return s; };

  /* group near-identical frames, flag soft frames and exposure problems */
  function cull(photos) {
    const list = photos.filter(p => p.an).slice().sort((a, b) => (a.time ?? a.order) - (b.time ?? b.order) || a.order - b.order);
    let gid = 0; for (const p of list) { p.group = null; p.best = false; p.flags = Object.assign(p.flags || {}, { dup: false, soft: false, softer: false, dark: false, blown: false }); }
    let cur = null;
    for (let i = 0; i < list.length; i++) {
      const p = list[i], q = list[i - 1];
      const near = q && (p.time != null && q.time != null ? Math.abs(p.time - q.time) <= 4000 : true);
      const same = q && near && hamming(p.an.hash, q.an.hash) <= 13 && histSim(p.an.sig, q.an.sig) >= 0.72;
      if (same) { if (!cur) { cur = [q]; q.group = ++gid; } cur.push(p); p.group = gid; }
      else cur = null;
    }
    const groups = {}; for (const p of list) if (p.group) (groups[p.group] = groups[p.group] || []).push(p);
    const score = p => p.an.sharp * (p.eyes && p.eyes.closed > 0 ? 0.55 : 1) * (p.eyes && p.eyes.keeper ? 0.85 + 0.06 * p.eyes.keeper : 1);
    for (const g of Object.values(groups)) {
      g.sort((a, b) => score(b) - score(a)); g[0].best = true;
      for (let k = 1; k < g.length; k++) { g[k].flags.dup = true; if (g[k].an.sharp < g[0].an.sharp * 0.6) g[k].flags.softer = true; }
    }
    const sh = list.map(p => p.an.sharp).sort((a, b) => a - b), med = sh[(sh.length / 2) | 0] || 0, p12 = sh[(sh.length * 0.12) | 0] || 0;
    for (const p of list) {
      if (list.length >= 8 && p.an.sharp <= p12 && p.an.sharp < med * 0.55) p.flags.soft = true;
      if (p.flags.softer) p.flags.soft = true;
      if (p.an.blown > 0.06) p.flags.blown = true;
      if (p.an.med < 0.06 && p.an.crushed > 0.35) p.flags.dark = true;
    }
    return Object.keys(groups).length;
  }

  /* ---------- EXIF capture time (JPEG, TIFF raws, CR3) ---------- */
  function exifTime(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const parseTiff = base => {
      try {
        const le = dv.getUint16(base) === 0x4949, g16 = o => dv.getUint16(base + o, le), g32 = o => dv.getUint32(base + o, le);
        const readIfd = (off, want) => { const n = g16(off); if (n > 500) return {}; const out = {}; for (let i = 0; i < n; i++) { const e = off + 2 + i * 12, tag = g16(e); if (want.includes(tag)) out[tag] = { type: g16(e + 2), cnt: g32(e + 4), val: e + 8 }; } return out; };
        const str = (ent) => { const off = ent.cnt > 4 ? g32(ent.val - base + base - base) : ent.val - base; let s = ''; const p = base + (ent.cnt > 4 ? g32(ent.val) : ent.val - base); for (let i = 0; i < ent.cnt - 1; i++) s += String.fromCharCode(dv.getUint8(p + i)); return s; };
        const i0 = readIfd(g32(4), [0x8769, 0x9003, 0x0132]);
        let dt = null, sub = null;
        if (i0[0x8769]) { const ex = readIfd(g32(i0[0x8769].val - base), [0x9003, 0x9291]); if (ex[0x9003]) dt = str(ex[0x9003]); if (ex[0x9291]) sub = str(ex[0x9291]); }
        if (!dt && i0[0x9003]) dt = str(i0[0x9003]);
        if (!dt && i0[0x0132]) dt = str(i0[0x0132]);
        return dt ? { dt, sub } : null;
      } catch (e) { return null; }
    };
    let r = null;
    if (u8[0] === 0xFF && u8[1] === 0xD8) {
      let i = 2; while (i + 10 < u8.length && u8[i] === 0xFF) { const m = u8[i + 1], len = dv.getUint16(i + 2); if (m === 0xE1 && u8[i + 4] === 0x45 && u8[i + 5] === 0x78) { r = parseTiff(i + 10); break; } if (m === 0xDA) break; i += 2 + len; }
    } else if ((u8[0] === 0x49 && u8[1] === 0x49) || (u8[0] === 0x4D && u8[1] === 0x4D)) r = parseTiff(0);
    else { // CR3: CMT2 box holds the Exif IFD as its own TIFF
      for (let i = 0; i < Math.min(u8.length - 8, 400000); i++) if (u8[i] === 0x43 && u8[i + 1] === 0x4D && u8[i + 2] === 0x54 && (u8[i + 3] === 0x32 || u8[i + 3] === 0x31)) {
        const t = parseTiff(i + 4); if (t) { r = t; if (u8[i + 3] === 0x32) break; } }
    }
    if (!r || !/^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d/.test(r.dt)) return null;
    const [d, t] = r.dt.split(' '), [Y, M, D] = d.split(':').map(Number), [hh, mm, ss] = t.split(':').map(Number);
    return new Date(Y, M - 1, D, hh, mm, ss).getTime() + (r.sub ? Number('0.' + r.sub.replace(/\D/g, '')) * 1000 : 0);
  }

  return { CREATIVE, creativeLUTs, peopleMasks, skinDepthOf, curveFn, autoPop, refine, liftMask, faceSkin, skinMap, dodgeBurnMaps, personMask, subjectMask, bloomMap, particles, defaults, bake, buildMaps, clarityBase, render, sharpen, skyMask, smallFrom, drawGeom, outSize, oriented, auto, analyze, cull, exifTime, HSL_KEYS, noise };
})();
window.Dev = Dev;
