/* ===================== Look engine ===================== */
const LookCore = (() => {
  const N = 33, NV = 16, NC = 12, WORK = 1280;
  const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  function boxSizes(sigma) {
    const n = 3, wIdeal = Math.sqrt(12 * sigma * sigma / n + 1);
    let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
    const s = []; for (let i = 0; i < n; i++) s.push(i < m ? wl : wu);
    return s;
  }
  function boxH(src, dst, w, h, r) {
    const inv = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      const o = y * w; let v = 0;
      for (let k = -r; k <= r; k++) v += src[o + Math.min(Math.max(k, 0), w - 1)];
      for (let x = 0; x < w; x++) {
        dst[o + x] = v * inv;
        v += src[o + Math.min(x + r + 1, w - 1)] - src[o + Math.max(x - r, 0)];
      }
    }
  }
  function boxV(src, dst, w, h, r) {
    const inv = 1 / (2 * r + 1);
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -r; k <= r; k++) v += src[Math.min(Math.max(k, 0), h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        dst[y * w + x] = v * inv;
        v += src[Math.min(y + r + 1, h - 1) * w + x] - src[Math.max(y - r, 0) * w + x];
      }
    }
  }
  function blur(src, w, h, sigma) {
    const a = Float32Array.from(src);
    if (sigma < 0.3) return a;
    const b = new Float32Array(a.length);
    for (const bs of boxSizes(sigma)) { const r = (bs - 1) >> 1; if (r < 1) continue; boxH(a, b, w, h, r); boxV(b, a, w, h, r); }
    return a;
  }
  function normBlur(v, wt, w, h, sigma) {
    const n = v.length, vw = new Float32Array(n);
    for (let i = 0; i < n; i++) vw[i] = v[i] * wt[i];
    const a = blur(vw, w, h, sigma), b = blur(wt, w, h, sigma), out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = b[i] > 1e-6 ? a[i] / b[i] : 0;
    return out;
  }
  function lumaOf(rgb) { const n = rgb.length / 3, L = new Float32Array(n); for (let i = 0; i < n; i++) L[i] = luma(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]); return L; }

  // ---- 3D LUT ----
  function fitLUT(items) {
    const M = N * N * N, s = N - 1;
    const acc = new Float64Array(M * 3), ws = new Float64Array(M);
    for (const it of items) {
      const B = it.B, T = it.T, W = it.W, n = W.length;
      for (let p = 0; p < n; p++) {
        const w = W[p]; if (w <= 0) continue;
        const r = B[3 * p] * s, g = B[3 * p + 1] * s, b = B[3 * p + 2] * s;
        const r0 = Math.min(r | 0, s - 1), g0 = Math.min(g | 0, s - 1), b0 = Math.min(b | 0, s - 1);
        const fr = r - r0, fg = g - g0, fb = b - b0;
        const tr = T[3 * p], tg = T[3 * p + 1], tb = T[3 * p + 2];
        for (let c = 0; c < 8; c++) {
          const dr = c & 1, dg = (c >> 1) & 1, db = c >> 2;
          const wt = w * (dr ? fr : 1 - fr) * (dg ? fg : 1 - fg) * (db ? fb : 1 - fb);
          if (wt <= 0) continue;
          const idx = (b0 + db) * N * N + (g0 + dg) * N + (r0 + dr);
          ws[idx] += wt; acc[3 * idx] += wt * tr; acc[3 * idx + 1] += wt * tg; acc[3 * idx + 2] += wt * tb;
        }
      }
    }
    const data = new Float32Array(M * 3), conf = new Float32Array(M);
    for (let idx = 0; idx < M; idx++) {
      if (ws[idx] <= 0) continue;
      const r = (idx % N) / s, g = (((idx / N) | 0) % N) / s, b = ((idx / (N * N)) | 0) / s;
      data[3 * idx] = acc[3 * idx] / ws[idx] - r;
      data[3 * idx + 1] = acc[3 * idx + 1] / ws[idx] - g;
      data[3 * idx + 2] = acc[3 * idx + 2] / ws[idx] - b;
      conf[idx] = ws[idx] / (ws[idx] + 4);
    }
    let D = new Float32Array(M * 3), E = new Float32Array(M * 3);
    for (let i = 0; i < M * 3; i++) D[i] = data[i] * conf[(i / 3) | 0];
    const NN = N * N;
    for (let iter = 0; iter < 220; iter++) {
      for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
        const idx = b * NN + g * N + r, c = conf[idx];
        let cnt = 0, s0 = 0, s1 = 0, s2 = 0;
        const add = j => { s0 += D[3 * j]; s1 += D[3 * j + 1]; s2 += D[3 * j + 2]; cnt++; };
        if (r > 0) add(idx - 1); if (r < s) add(idx + 1);
        if (g > 0) add(idx - N); if (g < s) add(idx + N);
        if (b > 0) add(idx - NN); if (b < s) add(idx + NN);
        const k = 1 - c;
        E[3 * idx] = c * data[3 * idx] + k * s0 / cnt;
        E[3 * idx + 1] = c * data[3 * idx + 1] + k * s1 / cnt;
        E[3 * idx + 2] = c * data[3 * idx + 2] + k * s2 / cnt;
      }
      const t = D; D = E; E = t;
    }
    // smoothing passes: keeps the curve gentle so it can't amplify JPEG blocks or noise
    for (let pass = 0; pass < 4; pass++) {
      for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
        const idx = b * NN + g * N + r; let cnt = 0, s0 = 0, s1 = 0, s2 = 0;
        const add = j => { s0 += D[3 * j]; s1 += D[3 * j + 1]; s2 += D[3 * j + 2]; cnt++; };
        if (r > 0) add(idx - 1); if (r < s) add(idx + 1);
        if (g > 0) add(idx - N); if (g < s) add(idx + N);
        if (b > 0) add(idx - NN); if (b < s) add(idx + NN);
        E[3 * idx] = 0.5 * D[3 * idx] + 0.5 * s0 / cnt; E[3 * idx + 1] = 0.5 * D[3 * idx + 1] + 0.5 * s1 / cnt; E[3 * idx + 2] = 0.5 * D[3 * idx + 2] + 0.5 * s2 / cnt;
      }
      const t = D; D = E; E = t;
    }
    const lut = new Float32Array(M * 3);
    for (let idx = 0; idx < M; idx++) {
      const r = (idx % N) / s, g = (((idx / N) | 0) % N) / s, b = ((idx / (N * N)) | 0) / s;
      lut[3 * idx] = Math.min(1, Math.max(0, r + D[3 * idx]));
      lut[3 * idx + 1] = Math.min(1, Math.max(0, g + D[3 * idx + 1]));
      lut[3 * idx + 2] = Math.min(1, Math.max(0, b + D[3 * idx + 2]));
    }
    return lut;
  }
  function lutAt(lut, r, g, b, out, o) {
    const s = N - 1;
    r = r <= 0 ? 0 : r >= 1 ? s : r * s; g = g <= 0 ? 0 : g >= 1 ? s : g * s; b = b <= 0 ? 0 : b >= 1 ? s : b * s;
    const r0 = Math.min(r | 0, s - 1), g0 = Math.min(g | 0, s - 1), b0 = Math.min(b | 0, s - 1);
    const fr = r - r0, fg = g - g0, fb = b - b0, NN = N * N;
    const i000 = 3 * (b0 * NN + g0 * N + r0), i100 = i000 + 3, i010 = i000 + 3 * N, i110 = i010 + 3;
    const i001 = i000 + 3 * NN, i101 = i001 + 3, i011 = i001 + 3 * N, i111 = i011 + 3;
    for (let c = 0; c < 3; c++) {
      const c00 = lut[i000 + c] + (lut[i100 + c] - lut[i000 + c]) * fr;
      const c10 = lut[i010 + c] + (lut[i110 + c] - lut[i010 + c]) * fr;
      const c01 = lut[i001 + c] + (lut[i101 + c] - lut[i001 + c]) * fr;
      const c11 = lut[i011 + c] + (lut[i111 + c] - lut[i011 + c]) * fr;
      const c0 = c00 + (c10 - c00) * fg, c1 = c01 + (c11 - c01) * fg;
      out[o + c] = c0 + (c1 - c0) * fb;
    }
  }
  function applyLUTArr(lut, rgb) { const out = new Float32Array(rgb.length); for (let i = 0; i < rgb.length; i += 3) lutAt(lut, rgb[i], rgb[i + 1], rgb[i + 2], out, i); return out; }
  function identityLUT() { const s = N - 1, lut = new Float32Array(N * N * N * 3); for (let idx = 0; idx < N * N * N; idx++) { lut[3 * idx] = (idx % N) / s; lut[3 * idx + 1] = (((idx / N) | 0) % N) / s; lut[3 * idx + 2] = ((idx / (N * N)) | 0) / s; } return lut; }

  function median(L) { const a = Float32Array.from(L).sort(); return a[(a.length / 2) | 0]; }
  function radialD(w, h) { const d = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const dx = (x + 0.5) / w * 2 - 1, dy = (y + 0.5) / h * 2 - 1; d[y * w + x] = Math.min(1, Math.sqrt(dx * dx + dy * dy) / Math.SQRT2); } return d; }
  function interp(tab, v) { const n = tab.length, t = Math.min(Math.max(v, 0), 1) * (n - 1), i = Math.min(t | 0, n - 2), f = t - i; return tab[i] + (tab[i + 1] - tab[i]) * f; }
  function smoothTab(t, passes) { let a = Array.from(t); for (let p = 0; p < passes; p++) { const b = a.slice(); for (let i = 0; i < a.length; i++) { const l = a[Math.max(i - 1, 0)], r = a[Math.min(i + 1, a.length - 1)]; b[i] = (l + 2 * a[i] + r) / 4; } a = b; } return a; }
  function binMeans(vals, keys, wts, nb, shrink) {
    const s = new Float64Array(nb), c = new Float64Array(nb);
    for (const k in keys) { /* noop for arrays of arrays */ }
    for (let j = 0; j < vals.length; j++) { const V = vals[j], K = keys[j], W = wts[j]; for (let i = 0; i < V.length; i++) { const t = Math.min(Math.max(K[i], 0), 0.9999) * nb; const b = t | 0; s[b] += V[i] * W[i]; c[b] += W[i]; } }
    let total = 0; for (let b = 0; b < nb; b++) total += c[b];
    const out = new Array(nb).fill(0), have = new Array(nb).fill(false);
    for (let b = 0; b < nb; b++) if (c[b] > 0) { out[b] = s[b] / c[b]; if (shrink) out[b] *= c[b] / (c[b] + shrink * total); have[b] = true; }
    for (let b = 0; b < nb; b++) if (!have[b]) { let best = 0, bd = 1e9; for (let k = 0; k < nb; k++) if (have[k] && Math.abs(k - b) < bd) { bd = Math.abs(k - b); best = out[k]; } out[b] = best; }
    return out;
  }

  // ---- noise tile for grain ----
  let noiseTile = null, noiseFine = 1;
  function getNoise() {
    if (noiseTile) return noiseTile;
    const T = 512; let seed = 1234567;
    const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const a = new Float32Array(T * T);
    for (let i = 0; i < a.length; i++) { const u = Math.max(rnd(), 1e-9), v = rnd(); a[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
    // light blur so grain clumps like film (wraps cleanly enough at tile edges)
    const b = blur(a, T, T, 0.7);
    let m = 0, q = 0; for (const x of b) { m += x; q += x * x; } m /= b.length; const sd = Math.sqrt(q / b.length - m * m);
    for (let i = 0; i < b.length; i++) b[i] = (b[i] - m) / sd;
    noiseFine = fineStd(b, T, T, null);
    noiseTile = b; return b;
  }
  function fineStd(L, w, h, mask) { const bl = blur(L, w, h, 1.2); let s = 0, q = 0, c = 0; for (let i = 0; i < L.length; i++) { if (mask && !mask[i]) continue; const f = L[i] - bl[i]; s += f; q += f * f; c++; } if (!c) return 0; s /= c; return Math.sqrt(Math.max(0, q / c - s * s)); }

  /* learn(pairs): each pair {B:{w,h,rgb}, A:{w,h,rgb}, crops?:{a:{w,h,L}, b:{w,h,L}}}  (rgb Float32 0..1, same w,h for B and A) */
  function learn(pairs, onStep) {
    const step = onStep || (() => {});
    const P = pairs.map(p => {
      const n = p.B.w * p.B.h, W = new Float32Array(n), B = p.B.rgb, A = p.A.rgb;
      for (let i = 0; i < n; i++) {
        const mxA = Math.max(A[3 * i], A[3 * i + 1], A[3 * i + 2]), mxB = Math.max(B[3 * i], B[3 * i + 1], B[3 * i + 2]);
        W[i] = (mxA > 0.995 || mxB > 0.995) ? 0.15 : 1;
      }
      return { w: p.B.w, h: p.B.h, n, B, A, W, LA: lumaOf(A), LB: lumaOf(B), G: new Float32Array(n), d: radialD(p.B.w, p.B.h), crops: p.crops };
    });
    let lut = null;
    for (let it = 0; it < 3; it++) {
      step(`Fitting color and tone (${it + 1}/3)`);
      const items = P.map(p => { const T = new Float32Array(p.n * 3); for (let i = 0; i < p.n; i++) { const g = Math.exp(-p.G[i]); for (let c = 0; c < 3; c++) T[3 * i + c] = Math.min(1, p.A[3 * i + c] * g); } return { B: p.B, T, W: p.W }; });
      lut = fitLUT(items);
      if (it === 2) break;
      for (const p of P) {
        const Pr = applyLUTArr(lut, p.B), LP = lumaOf(Pr), r = new Float32Array(p.n), cf = new Float32Array(p.n);
        for (let i = 0; i < p.n; i++) { r[i] = Math.log(p.LA[i] + 0.02) - Math.log(LP[i] + 0.02); cf[i] = p.W[i] * (LP[i] > 0.03 && p.LA[i] < 0.985 ? 1 : 0.15); }
        const G = normBlur(r, cf, p.w, p.h, 0.035 * Math.max(p.w, p.h));
        let m = 0, c = 0; for (let i = 0; i < p.n; i++) { m += G[i] * cf[i]; c += cf[i]; } m /= c || 1;
        for (let i = 0; i < p.n; i++) G[i] -= m;
        p.G = G; p.cf = cf;
      }
    }
    step('Separating vignette and dodge & burn');
    const vig = smoothTab(binMeans(P.map(p => p.G), P.map(p => p.d), P.map(p => p.cf), NV, 0), 2);
    const ctxKeys = P.map(p => blur(p.LB, p.w, p.h, 0.03 * Math.max(p.w, p.h)));
    const Gl = P.map(p => { const o = new Float32Array(p.n); for (let i = 0; i < p.n; i++) o[i] = p.G[i] - interp(vig, p.d[i]); return o; });
    let ctx = smoothTab(binMeans(Gl, ctxKeys, P.map(p => p.cf), NC, 0.01), 2);
    let cm = 0; for (const v of ctx) cm += v; cm /= ctx.length; ctx = ctx.map(v => v - cm * 0.0);
    // explained variance
    let v0 = 0, v1 = 0;
    P.forEach((p, j) => { for (let i = 0; i < p.n; i++) { const g = p.G[i], e = g - interp(vig, p.d[i]) - interp(ctx, ctxKeys[j][i]); v0 += g * g * p.cf[i]; v1 += e * e * p.cf[i]; } });

    step('Measuring clarity');
    let num = 0, den = 0;
    P.forEach((p, j) => {
      const Pr = applyLUTArr(lut, p.B), L2 = new Float32Array(p.n);
      for (let i = 0; i < p.n; i++) { const g = Math.exp(interp(vig, p.d[i]) + interp(ctx, ctxKeys[j][i])); L2[i] = luma(Pr[3 * i], Pr[3 * i + 1], Pr[3 * i + 2]) * g; }
      const sg = 0.012 * Math.max(p.w, p.h), bA = blur(p.LA, p.w, p.h, sg), bP = blur(L2, p.w, p.h, sg);
      for (let i = 0; i < p.n; i++) { if (p.cf[i] < 0.5) continue; const ha = p.LA[i] - bA[i], hp = L2[i] - bP[i]; num += ha * hp; den += hp * hp; }
    });
    const clarity = den > 0 ? Math.min(1.5, Math.max(-0.6, num / den - 1)) : 0;

    step('Measuring grain');
    let grain = 0, gc = 0;
    for (const p of P) {
      if (!p.crops) continue;
      const { a, b } = p.crops, bl = blur(b.L, b.w, b.h, 3);
      const gx = new Uint8Array(b.L.length);
      // flat areas: low local gradient in the original
      for (let y = 1; y < b.h - 1; y++) for (let x = 1; x < b.w - 1; x++) { const i = y * b.w + x; const gr = Math.abs(bl[i + 1] - bl[i - 1]) + Math.abs(bl[i + b.w] - bl[i - b.w]); gx[i] = gr < 0.004 && a.L[i] > 0.04 && a.L[i] < 0.96 ? 1 : 0; }
      const fa = fineStd(a.L, a.w, a.h, gx), fb = fineStd(b.L, b.w, b.h, gx);
      grain += Math.sqrt(Math.max(0, fa * fa - fb * fb)); gc++;
    }
    grain = gc ? grain / gc : 0;
    if (grain < 0.0015) grain = 0;

    const toStops = v => v / Math.LN2;
    const stats = {
      vignetteStops: +toStops(interp(vig, 1) - interp(vig, 0)).toFixed(2),
      dodgeBrightStops: +toStops(interp(ctx, 0.8)).toFixed(2),
      dodgeDarkStops: +toStops(interp(ctx, 0.12)).toFixed(2),
      localExplained: v0 > 0 ? Math.round(100 * (1 - v1 / v0)) : 0,
      clarity: Math.round(clarity * 100),
      grain: +(grain * 100).toFixed(2),
      pairs: pairs.length,
      inMed: +(P.reduce((a, p) => a + median(p.LB), 0) / P.length).toFixed(4),
    };
    return { v: 1, n: N, lut, vig, ctx, clarity, grain, stats };
  }

  /* prepare a target at working size: rgb Float32 + context key */
  function prepare(small) { const L = lumaOf(small.rgb); return { w: small.w, h: small.h, rgb: small.rgb, ctxKey: blur(L, small.w, small.h, 0.03 * Math.max(small.w, small.h)), d: radialD(small.w, small.h) }; }

  /* Low-res maps for a target: log gain (vignette + auto dodge/burn + brush) and the blur used for clarity. */
  function maps(look, prep, st, mask) {
    const { w, h } = prep, n = w * h, logG = new Float32Array(n), Lp = new Float32Array(n), tmp = [0, 0, 0];
    const sc = st.color, k = Math.pow(2, st.ev || 0);
    for (let i = 0; i < n; i++) {
      logG[i] = st.vignette * interp(look.vig, prep.d[i]) + st.dodge * interp(look.ctx, Math.min(1, prep.ctxKey[i] * k)) + (mask ? mask[i] : 0);
      const r = Math.min(1, prep.rgb[3 * i] * k), g = Math.min(1, prep.rgb[3 * i + 1] * k), b = Math.min(1, prep.rgb[3 * i + 2] * k);
      lutAt(look.lut, r, g, b, tmp, 0);
      const e = Math.exp(logG[i]);
      Lp[i] = luma(r + (tmp[0] - r) * sc, g + (tmp[1] - g) * sc, b + (tmp[2] - b) * sc) * e;
    }
    const bl = blur(Lp, w, h, 0.012 * Math.max(w, h));
    return { w, h, logG, bl };
  }

  /* Render pixels (RGBA Uint8ClampedArray, W x H) in place, rows [y0, y1). grainScale: 1 at full res. */
  function render(look, st, mp, data, W, H, y0, y1, grainScale) {
    const tile = getNoise(), T = 512, tmp = [0, 0, 0];
    const sc = st.color, cl = look.clarity * st.clarity, k = Math.pow(2, st.ev || 0) / 255;
    const gAmt = look.grain * st.grain / (noiseFine || 1) * grainScale;
    const mw = mp.w, mh = mp.h, sx = mw / W, sy = mh / H, lg = mp.logG, bl = mp.bl;
    const ox = 97, oy = 211, tf = tweakFn(look.tweaks), px = [0, 0, 0];
    for (let y = y0; y < y1; y++) {
      let v = (y + 0.5) * sy - 0.5; v = v < 0 ? 0 : v > mh - 1 ? mh - 1 : v;
      const v0 = Math.min(v | 0, mh - 2 < 0 ? 0 : mh - 2), fv = v - v0, r0 = v0 * mw, r1 = Math.min(v0 + 1, mh - 1) * mw;
      const trow = ((y + oy) % T) * T;
      for (let x = 0; x < W; x++) {
        let u = (x + 0.5) * sx - 0.5; u = u < 0 ? 0 : u > mw - 1 ? mw - 1 : u;
        const u0 = Math.min(u | 0, mw - 2 < 0 ? 0 : mw - 2), fu = u - u0, u1 = Math.min(u0 + 1, mw - 1);
        const a00 = r0 + u0, a10 = r0 + u1, a01 = r1 + u0, a11 = r1 + u1;
        const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
        const G = lg[a00] * w00 + lg[a10] * w10 + lg[a01] * w01 + lg[a11] * w11;
        const B = bl[a00] * w00 + bl[a10] * w10 + bl[a01] * w01 + bl[a11] * w11;
        const p = 4 * (y * W + x);
        let r = data[p] * k, g = data[p + 1] * k, b = data[p + 2] * k;
        if (r > 1) r = 1; if (g > 1) g = 1; if (b > 1) b = 1;
        lutAt(look.lut, r, g, b, tmp, 0);
        r += (tmp[0] - r) * sc; g += (tmp[1] - g) * sc; b += (tmp[2] - b) * sc;
        const e = Math.exp(G); r *= e; g *= e; b *= e;
        if (tf) { px[0] = r; px[1] = g; px[2] = b; tf(px, 0); r = px[0]; g = px[1]; b = px[2]; }
        const L = 0.299 * r + 0.587 * g + 0.114 * b;
        let add = 0;
        if (cl !== 0) { const mid = Math.max(0, Math.min(1, 4 * L * (1 - L))); add += (L - B) * cl * (0.35 + 0.65 * mid); }
        if (gAmt > 0) add += tile[trow + ((x + ox) % T)] * gAmt * (1.15 - 0.5 * L);
        r += add; g += add; b += add;
        data[p] = r * 255 + 0.5; data[p + 1] = g * 255 + 0.5; data[p + 2] = b * 255 + 0.5;
      }
    }
  }


  // ================= Finished-edits-only looks ("reference" looks) =================
  const lin = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const gam = c => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  const fLab = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  function rgb2lab(r, g, b, o) {
    r = lin(r); g = lin(g); b = lin(b);
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, y = 0.2126 * r + 0.7152 * g + 0.0722 * b, z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const fx = fLab(x), fy = fLab(y), fz = fLab(z);
    o[0] = 116 * fy - 16; o[1] = 500 * (fx - fy); o[2] = 200 * (fy - fz);
  }
  function lab2rgb(L, a, b, o) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const inv = t => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; };
    const x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883;
    const r = 3.2406 * x - 1.5372 * y - 0.4986 * z, g = -0.9689 * x + 1.8758 * y + 0.0415 * z, bb = 0.0557 * x - 0.204 * y + 1.057 * z;
    o[0] = Math.min(1, Math.max(0, gam(Math.max(0, r)))); o[1] = Math.min(1, Math.max(0, gam(Math.max(0, g)))); o[2] = Math.min(1, Math.max(0, gam(Math.max(0, bb))));
  }
  function lab2rgbSafe(L, a, b, o) {
    const fy = (L + 16) / 116, inv = t => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; };
    const toLin = (k) => { const fx = fy + a * k / 500, fz = fy - b * k / 200; const x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883;
      return [3.2406 * x - 1.5372 * y - 0.4986 * z, -0.9689 * x + 1.8758 * y + 0.0415 * z, 0.0557 * x - 0.204 * y + 1.057 * z]; };
    const ok = v => v[0] >= -0.002 && v[1] >= -0.002 && v[2] >= -0.002 && v[0] <= 1.002 && v[1] <= 1.002 && v[2] <= 1.002;
    let v = toLin(1);
    if (!ok(v)) { let lo = 0, hi = 1; for (let it = 0; it < 7; it++) { const m = (lo + hi) / 2; if (ok(toLin(m))) lo = m; else hi = m; } v = toLin(lo); }
    for (let c = 0; c < 3; c++) o[c] = Math.min(1, Math.max(0, gam(Math.max(0, v[c]))));
  }
  const NZ = 10;
  // tone quantiles + neutral tint, chroma per tonal zone, measured on a subsample
  function imageStats(rgb, curve) {
    const n = rgb.length / 3, step = n > 400000 ? 3 : 2, t = [0, 0, 0];
    const Ls = [], sa = new Float64Array(NZ), sb = new Float64Array(NZ), sw = new Float64Array(NZ), cnt = new Float64Array(NZ), ch = Array.from({ length: NZ }, () => []);
    for (let i = 0; i < n; i += step) {
      rgb2lab(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2], t);
      Ls.push(t[0]);
      const L = curve ? curve[Math.min(256, Math.max(0, Math.round(t[0] / 100 * 256)))] : t[0];
      const z = Math.min(NZ - 1, Math.max(0, (L / 100 * NZ) | 0)), C = Math.hypot(t[1], t[2]), w = Math.exp(-C / 12);
      sa[z] += t[1] * w; sb[z] += t[2] * w; sw[z] += w; cnt[z]++; if (ch[z].length < 20000) ch[z].push(C);
    }
    const Lsorted = Float32Array.from(Ls).sort(), q = [];
    for (let k = 0; k <= 100; k++) q.push(Lsorted[Math.min(Lsorted.length - 1, Math.round(k / 100 * (Lsorted.length - 1)))]);
    const zA = [], zB = [], zC = [], zN = [];
    for (let z = 0; z < NZ; z++) {
      zA.push(sw[z] > 0 ? sa[z] / sw[z] : null); zB.push(sw[z] > 0 ? sb[z] / sw[z] : null);
      const c = ch[z].sort((x, y) => x - y); zC.push(c.length ? c[(c.length / 2) | 0] : null); zN.push(cnt[z] / (n / step));
    }
    fillZones(zA); fillZones(zB); fillZones(zC);
    return { q, zA, zB, zC, zN };
  }
  function fillZones(arr) { for (let z = 0; z < arr.length; z++) if (arr[z] == null) { let best = 0, bd = 1e9; for (let k = 0; k < arr.length; k++) if (arr[k] != null && Math.abs(k - z) < bd) { bd = Math.abs(k - z); best = arr[k]; } arr[z] = best; } }

  /* learnRef(refs): each ref {w,h,rgb, crop?:{w,h,L}} = a finished edit */
  /* Measure one finished edit {w,h,rgb,crop?,thumb?} */
  function refStats(r) {
    const st = imageStats(r.rgb, null);
    const d = radialD(r.w, r.h), L = lumaOf(r.rgb); let eo = 0, ec = 0, io = 0, ic = 0;
    for (let i = 0; i < L.length; i += 3) { const v = Math.log(L[i] + 0.02); if (d[i] > 0.85) { eo += v; ec++; } else if (d[i] > 0.25 && d[i] < 0.55) { io += v; ic++; } }
    st.edge = +(ec && ic ? (eo / ec - io / ic) / Math.LN2 : 0).toFixed(3);
    if (r.crop) {
      const c = r.crop, bl = blur(c.L, c.w, c.h, 3), m = new Uint8Array(c.L.length);
      for (let y = 1; y < c.h - 1; y++) for (let x = 1; x < c.w - 1; x++) { const i = y * c.w + x; const gr = Math.abs(bl[i + 1] - bl[i - 1]) + Math.abs(bl[i + c.w] - bl[i - c.w]); m[i] = gr < 0.004 && c.L[i] > 0.04 && c.L[i] < 0.96 ? 1 : 0; }
      st.fine = +fineStd(c.L, c.w, c.h, m).toFixed(5);
    }
    st.q = st.q.map(v => +v.toFixed(2)); st.zA = st.zA.map(v => +v.toFixed(2)); st.zB = st.zB.map(v => +v.toFixed(2)); st.zC = st.zC.map(v => +v.toFixed(2)); st.zN = st.zN.map(v => +v.toFixed(4));
    if (r.thumb) st.thumb = r.thumb;
    if (r.name) st.name = r.name;
    st.px = samplePx(r.rgb, 2000);
    return st;
  }
  function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function samplePx(rgb, n) { const R = rng(99), cnt = rgb.length / 3, u = new Uint8Array(n * 3); for (let i = 0; i < n; i++) { const p = (R() * cnt) | 0; u[3 * i] = Math.round(rgb[3 * p] * 255); u[3 * i + 1] = Math.round(rgb[3 * p + 1] * 255); u[3 * i + 2] = Math.round(rgb[3 * p + 2] * 255); } return toB64(u); }

  /* ===== Precise match: move this photo's whole color distribution onto the closest edits (sliced optimal transport), then fit a smooth LUT ===== */
  function rankRefs(look, prep) {
    const tq = imageStats(prep.rgb, null).q;
    return look.refs.map((r, j) => { let d = 0; for (let k = 10; k <= 90; k += 10) d += Math.abs(r.q[k] - tq[k]); return [j, d / 9]; }).sort((a, b) => a[1] - b[1]).map(x => x[0]);
  }
  function canMatch(look) { return look.kind === 'ref' && look.refs.every(r => typeof r.px === 'string'); }
  function otLUT(look, prep, ev, pick, protectSkin) {
    const k = Math.pow(2, ev || 0), rgb = prep.rgb, n = rgb.length / 3, R = rng(7);
    // target sample
    const NX = 12000, Xrgb = new Float32Array(NX * 3), X = new Float32Array(NX * 3), lab = [0, 0, 0];
    for (let i = 0; i < NX; i++) { const p = (R() * n) | 0; for (let c = 0; c < 3; c++) Xrgb[3 * i + c] = Math.min(1, rgb[3 * p + c] * k); rgb2lab(Xrgb[3 * i], Xrgb[3 * i + 1], Xrgb[3 * i + 2], lab); X[3 * i] = lab[0]; X[3 * i + 1] = lab[1]; X[3 * i + 2] = lab[2]; }
    // which edits to match
    let use;
    if (pick != null && pick !== 'auto' && look.refs[pick]) use = [[pick, 1]];
    else {
      const xs = Float32Array.from({ length: NX }, (_, i) => X[3 * i]).sort(), tq = []; for (let q = 10; q <= 90; q += 10) tq.push(xs[Math.round(q / 100 * (NX - 1))]);
      const ws = look.refs.map((r, j) => { let d = 0; for (let q = 1; q <= 9; q++) d += Math.abs(r.q[q * 10] - tq[q - 1]); d /= 9; return [j, Math.exp(-(d / 9) * (d / 9))]; }).sort((a, b) => b[1] - a[1]);
      use = ws.filter((w, i) => i < 3 && w[1] >= ws[0][1] * 0.35);
    }
    const tot = use.reduce((a, u) => a + u[1], 0), NY = 6000, Y = new Float32Array(NY * 3); let yi = 0;
    use.forEach(([j, w], ui) => {
      const u8 = fromB64(look.refs[j].px), m = u8.length / 3, cnt = ui === use.length - 1 ? NY - yi : Math.round(NY * w / tot);
      for (let i = 0; i < cnt && yi < NY; i++, yi++) { const p = (R() * m) | 0; rgb2lab(u8[3 * p] / 255, u8[3 * p + 1] / 255, u8[3 * p + 2] / 255, lab); Y[3 * yi] = lab[0]; Y[3 * yi + 1] = lab[1]; Y[3 * yi + 2] = lab[2]; }
    });
    // auto mode keeps part of this photo's own brightness; a chosen edit is matched fully
    const keep = (pick != null && pick !== 'auto') ? 0.15 : 0.5;
    const med = (A, N) => { const t = Float32Array.from({ length: N }, (_, i) => A[3 * i]).sort(); return t[(N / 2) | 0]; };
    const dm = med(X, NX) - med(Y, NY);
    for (let i = 0; i < NY; i++) { const L = Y[3 * i] / 100; Y[3 * i] += keep * dm * Math.pow(Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, L)))), 0.7); }
    // iterative distribution transfer along random rotations
    const Z = Float32Array.from(X), px = new Float32Array(NX), py = new Float32Array(NY), idx = new Uint32Array(NX);
    for (let it = 0; it < 28; it++) {
      // random orthonormal basis from a random unit quaternion
      let q0 = R() * 2 - 1, q1 = R() * 2 - 1, q2 = R() * 2 - 1, q3 = R() * 2 - 1; const qn = Math.hypot(q0, q1, q2, q3); q0 /= qn; q1 /= qn; q2 /= qn; q3 /= qn;
      const M = [[1 - 2 * (q2 * q2 + q3 * q3), 2 * (q1 * q2 - q0 * q3), 2 * (q1 * q3 + q0 * q2)], [2 * (q1 * q2 + q0 * q3), 1 - 2 * (q1 * q1 + q3 * q3), 2 * (q2 * q3 - q0 * q1)], [2 * (q1 * q3 - q0 * q2), 2 * (q2 * q3 + q0 * q1), 1 - 2 * (q1 * q1 + q2 * q2)]];
      for (const ax of M) {
        for (let i = 0; i < NX; i++) px[i] = Z[3 * i] * ax[0] + Z[3 * i + 1] * ax[1] + Z[3 * i + 2] * ax[2];
        for (let i = 0; i < NY; i++) py[i] = Y[3 * i] * ax[0] + Y[3 * i + 1] * ax[1] + Y[3 * i + 2] * ax[2];
        for (let i = 0; i < NX; i++) idx[i] = i;
        idx.sort((a, b) => px[a] - px[b]); py.sort();
        for (let r = 0; r < NX; r++) {
          const i = idx[r], t = r / (NX - 1) * (NY - 1), j = Math.min(t | 0, NY - 2), f = t - j;
          const d = (py[j] + (py[j + 1] - py[j]) * f - px[i]) * 0.9;
          Z[3 * i] += d * ax[0]; Z[3 * i + 1] += d * ax[1]; Z[3 * i + 2] += d * ax[2];
        }
      }
    }
    // displacement, with skin protection and safety limits, then back to RGB
    const T = new Float32Array(NX * 3), o = [0, 0, 0];
    for (let i = 0; i < NX; i++) {
      const L = X[3 * i], a = X[3 * i + 1], b = X[3 * i + 2];
      let dL = Z[3 * i] - L, da = Z[3 * i + 1] - a, db = Z[3 * i + 2] - b;
      if (protectSkin) {
        const C = Math.hypot(a, b), h = Math.atan2(b, a) * 180 / Math.PI;
        if (C > 7 && C < 60 && L > 15 && L < 92 && h > 22 && h < 78) { const w = Math.min(1, (C - 7) / 8) * Math.min(1, Math.min(h - 22, 78 - h) / 10); da *= 1 - 0.6 * w; db *= 1 - 0.6 * w; dL *= 1 - 0.25 * w; }
      }
      dL = Math.max(-35, Math.min(35, dL)); da = Math.max(-30, Math.min(30, da)); db = Math.max(-30, Math.min(30, db));
      lab2rgbSafe(Math.min(100, Math.max(0, L + dL)), a + da, b + db, o); T[3 * i] = o[0]; T[3 * i + 1] = o[1]; T[3 * i + 2] = o[2];
    }
    // LUT is built from exposure-adjusted input; render() applies the same exposure first
    return fitLUT([{ B: Xrgb, T, W: new Float32Array(NX).fill(1) }]);
  }
  /* Combine measured edits into a look. prev = the look being edited (keeps vignette/grain for older edits that lack those measurements) */
  function combineRef(per, prev) {
    const edges = per.filter(p => p.edge != null).map(p => p.edge).sort((a, b) => a - b);
    let vigStops = edges.length ? Math.max(-1.2, Math.min(0, edges[(edges.length / 2) | 0] * 0.5)) : (prev && prev.stats ? prev.stats.vignetteStops || 0 : 0);
    const vig = Array.from({ length: NV }, (_, i) => { const dd = i / (NV - 1); return vigStops * Math.LN2 * Math.pow(Math.max(0, dd - 0.35) / 0.65, 1.6); });
    const fines = per.filter(p => p.fine != null).map(p => p.fine).sort((a, b) => a - b);
    let grain = fines.length ? Math.max(0, fines[(fines.length / 2) | 0] - 0.003) : (prev ? prev.grain || 0 : 0); if (grain < 0.0015) grain = 0;
    const look = { v: 1, n: N, kind: 'ref', refs: per, vig, ctx: new Array(NC).fill(0), clarity: 0, grain, lut: null, tweaks: prev && prev.tweaks ? Object.assign({}, prev.tweaks) : null,
      stats: { refs: per.length, vignetteStops: +vigStops.toFixed(2), grain: +(grain * 100).toFixed(2), clarity: 0, dodgeBrightStops: 0, dodgeDarkStops: 0, pairs: 0 } };
    look.lut = refLUT(look, null, 0);
    return look;
  }
  function learnRef(refs) { return combineRef(refs.map(refStats), null); }

  /* Fine-tune adjustments saved with a look: brightness, contrast, saturation, warmth, tint (each -100..100) */
  function tweakFn(tw) {
    if (!tw) return null;
    const bk = Math.pow(2, (tw.bright || 0) / 100 * 0.8), cc = (tw.contrast || 0) / 100 * 0.45, sk = 1 + (tw.sat || 0) / 100 * 0.6,
      wr = 1 + (tw.warmth || 0) / 100 * 0.09, wb = 1 - (tw.warmth || 0) / 100 * 0.09, tg = 1 - (tw.tint || 0) / 100 * 0.07;
    if (bk === 1 && cc === 0 && sk === 1 && wr === 1 && tg === 1) return null;
    return (o, i) => {
      let r = o[i] * bk * wr, g = o[i + 1] * bk * tg, b = o[i + 2] * bk * wb;
      const L = 0.299 * r + 0.587 * g + 0.114 * b, Lc = Math.min(1, Math.max(0, L));
      const d = cc * (Lc - 0.5) * (1 - Math.abs(2 * Lc - 1)) * 2;
      r = L + (r - L) * sk + d; g = L + (g - L) * sk + d; b = L + (b - L) * sk + d;
      o[i] = r; o[i + 1] = g; o[i + 2] = b;
    };
  }
  function bakedLUT(look) { const f = tweakFn(look.tweaks), lut = Float32Array.from(look.lut); if (f) for (let i = 0; i < lut.length; i += 3) { f(lut, i); for (let c = 0; c < 3; c++) lut[i + c] = Math.min(1, Math.max(0, lut[i + c])); } return lut; }

  /* Build a LUT that moves one photo toward the reference edits. prep null = a typical photo (for swatches and .cube export). */
  function refLUT(look, prep, ev) {
    let tq;
    if (prep) { const k = Math.pow(2, ev || 0), rgb = prep.rgb, ex = k === 1 ? rgb : rgb.map(v => Math.min(1, v * k)); tq = imageStats(ex, null); tq.rgb = ex; }
    else { tq = { q: Array.from({ length: 101 }, (_, k) => 4 + 90 * k / 100) }; }
    // weight references by how similar their tonal spread is to this photo
    const ws = look.refs.map(r => { let d = 0; for (let k = 10; k <= 90; k += 10) d += Math.abs(r.q[k] - tq.q[k]); d /= 9; return Math.exp(-(d / 9) * (d / 9)) + 0.005; });
    const W = ws.reduce((a, b) => a + b, 0), wn = ws.map(w => w / W);
    const mix = key => Array.from({ length: key === 'q' ? 101 : NZ }, (_, i) => look.refs.reduce((a, r, j) => a + r[key][i] * wn[j], 0));
    const rq0 = mix('q'), rA = mix('zA'), rB = mix('zB'), rC = mix('zC');
    // keep this photo's own brightness in the midtones; take black point, contrast and highlight roll-off from the edits
    const shift = tq.q[50] - rq0[50];
    const rq = rq0.map((v, k) => v + 0.8 * shift * Math.pow(Math.sin(Math.PI * k / 100), 0.7));
    for (let k = 1; k <= 100; k++) rq[k] = Math.max(rq[k], rq[k - 1]);
    // tone curve: quantile match, softened and slope-limited so it can't posterize
    const tqq = tq.q.map((v, k) => v + k * 1e-4);
    const curve = new Float32Array(257);
    for (let i = 0; i <= 256; i++) {
      const L = i / 256 * 100; let j = 0; while (j < 99 && tqq[j + 1] < L) j++;
      let m;
      if (L <= tqq[0]) m = rq[0] * (L / Math.max(tqq[0], 1e-3));
      else if (L >= tqq[100]) m = rq[100] + (100 - rq[100]) * (L - tqq[100]) / Math.max(100 - tqq[100], 1e-3);
      else { const f = (L - tqq[j]) / Math.max(tqq[j + 1] - tqq[j], 1e-4); m = rq[j] + (rq[j + 1] - rq[j]) * Math.min(1, Math.max(0, f)); }
      curve[i] = L + (m - L) * 0.85;
    }
    let cv = blur(curve, 257, 1, 5);
    for (let i = 1; i <= 256; i++) { const dx = 100 / 256; cv[i] = Math.min(cv[i - 1] + 2.6 * dx, Math.max(cv[i - 1] + 0.35 * dx, cv[i])); }
    // a look may set the black point and roll off bright lights, but it never sinks faces and midtones
    for (let i = 0; i <= 256; i++) { const L = i / 256 * 100, dmax = L < 10 ? 5 : 2.5, bmax = L < 55 ? 12 : Math.max(1.5, 12 - (L - 55) * 0.3); cv[i] = Math.min(Math.max(cv[i], L - dmax), L + bmax); }
    for (let i = 1; i <= 256; i++) cv[i] = Math.max(cv[i], cv[i - 1] + 0.3 * 100 / 256);
    for (let i = 0; i <= 256; i++) cv[i] = Math.min(100, Math.max(0, cv[i]));
    // color per tonal zone (measured on this photo after the tone curve)
    let tA, tB, tC;
    if (prep) { const st2 = imageStats(tq.rgb, cv); tA = st2.zA; tB = st2.zB; tC = st2.zC; }
    else { tA = new Array(NZ).fill(0); tB = new Array(NZ).fill(0); tC = new Array(NZ).fill(18); }
    const sZ = [], aZ = [], bZ = [];
    for (let z = 0; z < NZ; z++) {
      const sc = Math.min(1.2, Math.max(0.85, Math.pow((rC[z] + 1) / (tC[z] + 1), 0.5)));
      sZ.push(sc); aZ.push(Math.max(-20, Math.min(20, rA[z] - sc * tA[z]))); bZ.push(Math.max(-20, Math.min(20, rB[z] - sc * tB[z])));
    }
    const sm = a => { const o = a.slice(); for (let i = 0; i < a.length; i++) o[i] = (a[Math.max(0, i - 1)] + 2 * a[i] + a[Math.min(a.length - 1, i + 1)]) / 4; return o; };
    const S2 = sm(sZ), A2 = sm(aZ), B2 = sm(bZ);
    const zi = (arr, L) => { const t = Math.min(NZ - 1, Math.max(0, L / 100 * NZ - 0.5)), i = Math.min(t | 0, NZ - 2), f = t - i; return arr[i] + (arr[i + 1] - arr[i]) * f; };
    const s = N - 1, lut = new Float32Array(N * N * N * 3), lab = [0, 0, 0], out = [0, 0, 0];
    for (let idx = 0; idx < N * N * N; idx++) {
      rgb2lab((idx % N) / s, (((idx / N) | 0) % N) / s, ((idx / (N * N)) | 0) / s, lab);
      const t = Math.min(256, Math.max(0, lab[0] / 100 * 256)), i0 = Math.min(t | 0, 255), L2 = cv[i0] + (cv[i0 + 1] - cv[i0]) * (t - i0);
      const C = Math.hypot(lab[1], lab[2]), att = 1 - 0.75 * Math.min(1, C / 45);
      const lk = Math.pow(Math.min(1.7, Math.max(0.7, (L2 + 4) / (lab[0] + 4))), 0.8);
      const hp = 1 - 0.85 * Math.min(1, Math.max(0, (L2 - 82) / 18)), tint = 0.75 * att * hp;
      const sc = zi(S2, L2) * lk, a2 = lab[1] * sc + zi(A2, L2) * tint, b2 = lab[2] * sc + zi(B2, L2) * tint;
      lab2rgbSafe(L2, a2, b2, out); lut[3 * idx] = out[0]; lut[3 * idx + 1] = out[1]; lut[3 * idx + 2] = out[2];
    }
    return lut;
  }

  // ---- (de)serialise ----
  function toB64(u8) { let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }

  /* ===== skin: what skin looks like in a look's examples, and tuning a LUT so this photo's skin lands there ===== */
  function isSkinLab(L, a, b) { const C = Math.hypot(a, b), h = Math.atan2(b, a) * 180 / Math.PI; return L > 14 && L < 88 && C > 9 && C < 48 && h > 22 && h < 78; }
  function skinOfPx(u8) {
    const t = [0, 0, 0], Ls = [], As = [], Bs = [], n = u8.length / 3;
    for (let i = 0; i < n; i++) { rgb2lab(u8[3 * i] / 255, u8[3 * i + 1] / 255, u8[3 * i + 2] / 255, t); if (isSkinLab(t[0], t[1], t[2])) { Ls.push(t[0]); As.push(t[1]); Bs.push(t[2]); } }
    if (Ls.length < Math.max(40, n * 0.04)) return null;
    const md = (a, q) => { a.sort((x, y) => x - y); return a[(a.length * q) | 0]; };
    return { L: md(Ls.slice(), 0.5), hi: md(Ls.slice(), 0.9), lo: md(Ls, 0.1), a: md(As, 0.5), b: md(Bs, 0.5), f: Ls.length / n };
  }
  function lookSkin(look) {
    if (!look || look.kind !== 'ref') return null; if (look._skin !== undefined) return look._skin;
    const all = look.refs.map(r => typeof r.px === 'string' ? skinOfPx(fromB64(r.px)) : null).filter(Boolean);
    if (!all.length) return look._skin = null;
    const md = k => { const a = all.map(x => x[k]).sort((x, y) => x - y); return a[(a.length / 2) | 0]; };
    return look._skin = { L: md('L'), hi: md('hi'), lo: md('lo'), a: md('a'), b: md('b'), all };
  }
  /* move the near-white outputs of a LUT (dress, shirt, veil) by (da, db) in Lab, so whites land clean; colours and skin stay put */
  function whiteTune(lut, da, db) {
    const out = new Float32Array(lut.length), lab = [0, 0, 0], o = [0, 0, 0];
    for (let i = 0; i < lut.length; i += 3) {
      rgb2lab(lut[i], lut[i + 1], lut[i + 2], lab); const C = Math.hypot(lab[1], lab[2]);
      const w = Math.min(1, Math.max(0, (lab[0] - 45) / 15)) * Math.min(1, Math.max(0, (18 - C) / 7));
      if (w < 0.01) { out[i] = lut[i]; out[i + 1] = lut[i + 1]; out[i + 2] = lut[i + 2]; continue; }
      const k = 1 - 0.8 * w; lab2rgbSafe(lab[0], lab[1] * k + da * w, lab[2] * k + db * w, o); out[i] = o[0]; out[i + 1] = o[1]; out[i + 2] = o[2];   /* near-whites lose their tint (pink, lavender, blue lace edges all at once), then sit at a clean, slightly warm white */
    }
    return out;
  }
  /* move skin-coloured outputs of a LUT by (da, db) in Lab; whites, blacks and other hues stay put */
  function skinTune(lut, cur, da, db, masked) {
    const out = new Float32Array(lut.length), lab = [0, 0, 0], o = [0, 0, 0], h0 = Math.atan2(cur.b, cur.a), C0 = Math.max(8, Math.hypot(cur.a, cur.b));
    for (let i = 0; i < lut.length; i += 3) {
      rgb2lab(lut[i], lut[i + 1], lut[i + 2], lab);
      const C = Math.hypot(lab[1], lab[2]); let dh = Math.atan2(lab[2], lab[1]) - h0; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI;
      // with a skin mask the shift is even across tones (only clean highlights and deep blacks are spared); without one it is limited to skin hues
      const w = masked ? Math.min(1, Math.max(0, (97 - lab[0]) / 12)) * Math.min(1, Math.max(0, (lab[0] - 3) / 8)) * (lab[0] > 66 ? Math.min(1, Math.max(0, (C - 3) / 12)) : 1) * (0.2 + 0.8 * Math.min(1, Math.max(0, (C - 2) / (0.45 * C0))))   /* hair, shadows and other near-gray things in the skin area barely move, so they never turn teal or purple */ : Math.exp(-(dh / 0.5) * (dh / 0.5)) * Math.min(1, Math.max(0, (C - 4) / 8)) * Math.min(1.25, C / C0) * Math.min(1, Math.max(0, (96 - lab[0]) / 14));
      if (w < 0.004) { out[i] = lut[i]; out[i + 1] = lut[i + 1]; out[i + 2] = lut[i + 2]; continue; }
      lab2rgbSafe(lab[0], lab[1] + da * w, lab[2] + db * w, o); out[i] = o[0]; out[i + 1] = o[1]; out[i + 2] = o[2];
    }
    return out;
  }

  /* safety on any adapted look: it may grade colour and set mood, but it never turns bright lights gray, never sinks midtones, never over-brightens */
  function guardLUT(lut) {
    const out = new Float32Array(lut.length), s = N - 1, a = [0, 0, 0], b = [0, 0, 0], o = [0, 0, 0];
    for (let idx = 0; idx < N * N * N; idx++) {
      rgb2lab((idx % N) / s, (((idx / N) | 0) % N) / s, ((idx / (N * N)) | 0) / s, a);
      rgb2lab(lut[3 * idx], lut[3 * idx + 1], lut[3 * idx + 2], b);
      const L = a[0], lo = L - (L < 10 ? 5 : 2.5), hi = L + (L < 55 ? 12 : Math.max(1.5, 12 - (L - 55) * 0.3));
      const L2 = Math.min(hi, Math.max(lo, b[0]));
      // near-white input keeps its own colour (white stays white), blending in from L 84 up
      // white lock: bright, nearly colourless input (a white dress, a shirt) keeps its own colour too, so no look can tint it pink, lavender or green
      const Cin = Math.hypot(a[1], a[2]), kw = 0.9 * Math.min(1, Math.max(0, (L - 52) / 16)) * Math.min(1, Math.max(0, (17 - Cin) / 8));
      const k = Math.max(kw, Math.min(1, Math.max(0, (L - 84) / 12))), A2 = b[1] + (a[1] - b[1]) * k, B2 = b[2] + (a[2] - b[2]) * k;
      lab2rgbSafe(L2, A2, B2, o); out[3 * idx] = o[0]; out[3 * idx + 1] = o[1]; out[3 * idx + 2] = o[2];
    }
    return out;
  }
  function fromB64(b64) { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  function serialize(look, meta) {
    if (look.kind === 'ref') return Object.assign({ format: 'lookmatch', v: 1, kind: 'ref', n: look.n, refs: look.refs, vig: look.vig.map(x => +x.toFixed(4)), grain: +look.grain.toFixed(5), stats: look.stats, tweaks: look.tweaks || null }, meta || {});
    const u8 = new Uint8Array(look.lut.length); for (let i = 0; i < u8.length; i++) u8[i] = Math.round(look.lut[i] * 255);
    return Object.assign({ format: 'lookmatch', v: 1, n: look.n, tweaks: look.tweaks || null, lut: toB64(u8), vig: look.vig.map(x => +x.toFixed(4)), ctx: look.ctx.map(x => +x.toFixed(4)), clarity: +look.clarity.toFixed(3), grain: +look.grain.toFixed(5), stats: look.stats }, meta || {});
  }
  function deserialize(doc) {
    if (doc && doc.format === 'lookmatch' && doc.kind === 'ref') {
      if (!Array.isArray(doc.refs) || !doc.refs.length) throw new Error('This look file is damaged.');
      const look = { v: 1, n: N, kind: 'ref', refs: doc.refs, vig: doc.vig, ctx: new Array(NC).fill(0), clarity: 0, grain: doc.grain || 0, stats: doc.stats || {}, tweaks: doc.tweaks || null };
      look.lut = refLUT(look, null, 0); return look;
    }
    if (!doc || doc.format !== 'lookmatch' || doc.n !== N || typeof doc.lut !== 'string') throw new Error('Not a Look Match look file.');
    const u8 = fromB64(doc.lut); if (u8.length !== N * N * N * 3) throw new Error('This look file is damaged.');
    const lut = new Float32Array(u8.length); for (let i = 0; i < u8.length; i++) lut[i] = u8[i] / 255;
    return { v: 1, n: N, lut, vig: doc.vig, ctx: doc.ctx, clarity: doc.clarity || 0, grain: doc.grain || 0, stats: doc.stats || {}, tweaks: doc.tweaks || null };
  }
  function toCube(look, title) {
    const lines = [`TITLE "${String(title).replace(/"/g, "'")}"`, `LUT_3D_SIZE ${N}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
    const lut = bakedLUT(look);
    for (let i = 0; i < N * N * N; i++) lines.push(`${lut[3 * i].toFixed(6)} ${lut[3 * i + 1].toFixed(6)} ${lut[3 * i + 2].toFixed(6)}`);
    return lines.join('\n') + '\n';
  }
  function sampleLook() {
    const lut = identityLUT(), s = N - 1;
    for (let idx = 0; idx < N * N * N; idx++) {
      let r = lut[3 * idx], g = lut[3 * idx + 1], b = lut[3 * idx + 2];
      const L = luma(r, g, b);
      const curve = x => { x = Math.min(1, Math.max(0, (x - 0.03) / 0.97)); return x + 0.22 * Math.sin(Math.PI * x) * (0.5 - x) * -1 * -1; };
      r = curve(r); g = curve(g); b = curve(b);
      const sh = Math.pow(1 - L, 2.2), hi = Math.pow(L, 2);
      r += -0.035 * sh + 0.04 * hi; g += 0.005 * sh + 0.012 * hi; b += 0.05 * sh - 0.045 * hi;
      const L2 = luma(r, g, b); r = L2 + (r - L2) * 0.9; g = L2 + (g - L2) * 0.9; b = L2 + (b - L2) * 0.9;
      lut[3 * idx] = Math.min(1, Math.max(0, r)); lut[3 * idx + 1] = Math.min(1, Math.max(0, g)); lut[3 * idx + 2] = Math.min(1, Math.max(0, b));
    }
    const vig = Array.from({ length: NV }, (_, i) => { const d = i / (NV - 1); return -0.55 * Math.pow(Math.max(0, d - 0.35) / 0.65, 1.6); });
    const ctx = new Array(NC).fill(0);
    return { v: 1, n: N, lut, vig, ctx, clarity: 0.15, grain: 0.004, stats: { vignetteStops: -0.79, dodgeBrightStops: 0, dodgeDarkStops: 0, clarity: 15, grain: 0.4, pairs: 0, localExplained: 0 } };
  }
  return { guardLUT, whiteTune, identityLUT,  skinOfPx, lookSkin, skinTune, isSkinLab, fromB64, rgb2lab, N, WORK, learn, learnRef, otLUT, canMatch, rankRefs, refStats, combineRef, bakedLUT, refLUT, prepare, maps, render, serialize, deserialize, toCube, sampleLook, lutAt, luma, blur };
})();
window.LookCore = LookCore;
