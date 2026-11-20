/* ===================== Pipeline: one call renders a photo with all its settings ===================== */
const Pipe = (() => {
  const LC = window.LookCore, D = window.Dev, MAPLONG = 768;
  const lin = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const gam = c => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  const tick = () => new Promise(r => setTimeout(r, 0));

  function resample(m, w0, h0, w1, h1) {
    if (!m) return null; if (w0 === w1 && h0 === h1) return m;
    const o = new Float32Array(w1 * h1);
    for (let y = 0; y < h1; y++) for (let x = 0; x < w1; x++) { const sx = Math.min(w0 - 1, Math.round((x + 0.5) * w0 / w1 - 0.5)), sy = Math.min(h0 - 1, Math.round((y + 0.5) * h0 / h1 - 0.5)); o[y * w1 + x] = m[Math.max(0, sy) * w0 + Math.max(0, sx)]; }
    return o;
  }
  /* white balance + exposure applied to the small image, so looks adapt to the corrected photo */
  function preCorrect(small, s) {
    const t = s.temp / 100, tn = s.tint / 100; let gr = Math.exp(0.28 * t), gg = Math.exp(-0.16 * tn), gb = Math.exp(-0.28 * t); const gl = 0.299 * gr + 0.587 * gg + 0.114 * gb; gr /= gl; gg /= gl; gb /= gl;
    const ex = Math.pow(2, s.ev || 0), out = new Float32Array(small.rgb.length), g3 = [gr, gg, gb];
    const knee = v => v <= 0.8 ? v : 0.8 + 0.2 * (1 - Math.exp(-(v - 0.8) / 0.2));
    for (let i = 0; i < out.length; i++) out[i] = Math.min(1, gam(knee(lin(small.rgb[i]) * g3[i % 3] * ex)));
    return { w: small.w, h: small.h, rgb: out };
  }
  /* ---------- remove distractions: boxes from Claude + the Remove brush, filled content-aware ---------- */
  const GRID = 384;
  function removalMask(s, rm, cw, ch) {
    const boxes = (s.removals || []).filter(r => r.on);
    if (!boxes.length && !rm) return null;
    const k = GRID / Math.max(cw, ch), gw = Math.max(1, Math.round(cw * k)), gh = Math.max(1, Math.round(ch * k)), m = new Float32Array(gw * gh);
    for (const r of boxes) {
      const [bx, by, bw, bh] = r.box, pad = 0.08;
      const x0 = Math.max(0, Math.floor((bx - bw * pad) * gw)), x1 = Math.min(gw - 1, Math.ceil((bx + bw * (1 + pad)) * gw)), y0 = Math.max(0, Math.floor((by - bh * pad) * gh)), y1 = Math.min(gh - 1, Math.ceil((by + bh * (1 + pad)) * gh));
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.max(1, (x1 - x0) / 2), ry = Math.max(1, (y1 - y0) / 2);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const d = ((x - cx) / rx) ** 2 * 0.55 + ((y - cy) / ry) ** 2 * 0.55; if (d <= 1) m[y * gw + x] = 1; } // rounded box
    }
    if (rm) { const b = resample(rm.data instanceof Float32Array ? rm.data : Float32Array.from(rm.data), rm.w, rm.h, gw, gh); for (let i = 0; i < m.length; i++) if (b[i] > 0.3) m[i] = 1; }
    let any = 0; for (const v of m) any += v; if (!any) return null;
    return { gw, gh, m };
  }
  function components(M) {
    const { gw, gh, m } = M, lab = new Int32Array(gw * gh).fill(-1), out = [];
    for (let i = 0; i < gw * gh; i++) {
      if (!m[i] || lab[i] >= 0) continue; const id = out.length, st = [i]; lab[i] = id; let x0 = gw, y0 = gh, x1 = 0, y1 = 0;
      while (st.length) { const j = st.pop(), x = j % gw, y = (j / gw) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const q of [x > 0 ? j - 1 : -1, x < gw - 1 ? j + 1 : -1, j - gw, j + gw]) if (q >= 0 && q < gw * gh && m[q] && lab[q] < 0) { lab[q] = id; st.push(q); } }
      out.push({ x0, y0, x1, y1 });
    }
    // merge overlapping regions once expanded
    return out;
  }
  const fills = new Map();
  function applyRemovals(data, cw, ch, s, rm, key) {
    const M = removalMask(s, rm, cw, ch); if (!M) return false;
    const { gw, gh, m } = M, sx = cw / gw, sy = ch / gh;
    const soft = D ? window.LookCore.blur(m, gw, gh, 0.8) : m;
    for (const [ci, c] of components(M).entries()) {
      const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1, mg = Math.max(10, Math.round(Math.max(bw, bh) * 0.7));
      const gx0 = Math.max(0, c.x0 - mg), gy0 = Math.max(0, c.y0 - mg), gx1 = Math.min(gw - 1, c.x1 + mg), gy1 = Math.min(gh - 1, c.y1 + mg);
      const X0 = Math.floor(gx0 * sx), Y0 = Math.floor(gy0 * sy), X1 = Math.min(cw, Math.ceil((gx1 + 1) * sx)), Y1 = Math.min(ch, Math.ceil((gy1 + 1) * sy));
      const RW = X1 - X0, RH = Y1 - Y0, k = Math.min(1, 300 / Math.max(RW, RH)), w = Math.max(8, Math.round(RW * k)), h = Math.max(8, Math.round(RH * k));
      const fk = key + '|' + ci + '|' + [gx0, gy0, gx1, gy1].join(',');
      let F = fills.get(fk);
      if (!F) {
        const img = new Float32Array(w * h * 3), hole = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          // box-sample the full-resolution region down to the working size
          const ax = X0 + Math.floor(x * RW / w), bx2 = Math.max(ax + 1, X0 + Math.floor((x + 1) * RW / w)), ay = Y0 + Math.floor(y * RH / h), by2 = Math.max(ay + 1, Y0 + Math.floor((y + 1) * RH / h));
          let r = 0, g = 0, b = 0, n = 0; const st = Math.max(1, ((bx2 - ax) / 3) | 0);
          for (let yy = ay; yy < by2; yy += st) for (let xx = ax; xx < bx2; xx += st) { const p = 4 * (yy * cw + xx); r += data[p]; g += data[p + 1]; b += data[p + 2]; n++; }
          const o = 3 * (y * w + x); img[o] = r / n / 255; img[o + 1] = g / n / 255; img[o + 2] = b / n / 255;
          const gxx = Math.min(gw - 1, Math.floor((X0 + (x + 0.5) * RW / w) / sx)), gyy = Math.min(gh - 1, Math.floor((Y0 + (y + 0.5) * RH / h) / sy));
          hole[y * w + x] = m[gyy * gw + gxx] ? 1 : 0;
        }
        // grow the hole by a pixel so edges of the removed object don't survive
        const h2 = Uint8Array.from(hole); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (hole[i - 1] || hole[i + 1] || hole[i - w] || hole[i + w]) h2[i] = 1; }
        window.Inpaint.fill(img, h2, w, h, 1 + ci);
        F = { img, w, h }; fills.set(fk, F); if (fills.size > 40) fills.delete(fills.keys().next().value);
      }
      // composite back at full resolution with a soft edge
      const tile = D.noise(), T = 512;
      for (let Y = Y0; Y < Y1; Y++) for (let X = X0; X < X1; X++) {
        const gxf = X / sx - 0.5, gyf = Y / sy - 0.5, gx = Math.max(0, Math.min(gw - 1, Math.round(gxf))), gy = Math.max(0, Math.min(gh - 1, Math.round(gyf)));
        const a = Math.min(1, soft[gy * gw + gx] * 1.6); if (a <= 0.01) continue;
        const fx = Math.min(F.w - 1.001, Math.max(0, (X - X0) * F.w / RW - 0.5)), fy = Math.min(F.h - 1.001, Math.max(0, (Y - Y0) * F.h / RH - 0.5)), x0 = fx | 0, y0 = fy | 0, ux = fx - x0, uy = fy - y0;
        const i00 = 3 * (y0 * F.w + x0), i10 = i00 + 3, i01 = i00 + 3 * F.w, i11 = i01 + 3, p = 4 * (Y * cw + X), nz = tile[(Y % T) * T + (X % T)] * 0.006;
        for (let c2 = 0; c2 < 3; c2++) { const v = (F.img[i00 + c2] * (1 - ux) + F.img[i10 + c2] * ux) * (1 - uy) + (F.img[i01 + c2] * (1 - ux) + F.img[i11 + c2] * ux) * uy + nz; data[p + c2] = data[p + c2] * (1 - a) + v * 255 * a; }
      }
    }
    return true;
  }

  /* skin smoothing: even out blotches and coarse texture on skin, keep edges (eyes, lips, lashes) and the finest pores.
     Works on a reduced copy of the skin area and adds the difference back, so fine detail above that scale survives. */
  function smoothSkin(data, cw, ch, M, mw, mh, amt, FM) {
    /* a retoucher's smooth skin, in two layers, on each colour channel:
       1) grain and fine noise on the skin are wiped out (no grain on skin, ever);
       2) texture, bumps and blotches are smoothed toward an edge-aware soft version of the skin, keeping a little texture so it never looks plastic.
       Edges with real contrast (eyes, lips, nostrils, jaw, hair line) are kept by the edge-aware filter and by the skin mask. */
    let x0 = mw, y0 = mh, x1 = -1, y1 = -1;
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (M[y * mw + x] > 0.05) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return;
    const X0 = Math.max(0, Math.floor((x0 - 2) * cw / mw)), Y0 = Math.max(0, Math.floor((y0 - 2) * ch / mh)), X1 = Math.min(cw, Math.ceil((x1 + 3) * cw / mw)), Y1 = Math.min(ch, Math.ceil((y1 + 3) * ch / mh));
    const RW = X1 - X0, RH = Y1 - Y0; if (RW < 16 || RH < 16) return;
    const k = Math.min(1, 1600 / Math.max(RW, RH)), w = Math.max(8, Math.round(RW * k)), h = Math.max(8, Math.round(RH * k)), n = w * h;
    const C = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (let y = 0; y < h; y++) { const ay = Y0 + Math.floor(y * RH / h), by = Math.max(ay + 1, Y0 + Math.floor((y + 1) * RH / h));
      for (let x = 0; x < w; x++) { const ax = X0 + Math.floor(x * RW / w), bx = Math.max(ax + 1, X0 + Math.floor((x + 1) * RW / w)); let r = 0, g = 0, bb = 0, c = 0;
        for (let yy = ay; yy < by; yy++) for (let xx = ax; xx < bx; xx++) { const p = 4 * (yy * cw + xx); r += data[p]; g += data[p + 1]; bb += data[p + 2]; c++; }
        const i = y * w + x; C[0][i] = r / c / 255; C[1][i] = g / c / 255; C[2][i] = bb / c / 255; } }
    // the size of a face here, so the filters scale with how big the people are in the frame
    let cnt = 0; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const m = M[Math.min(mh - 1, ((Y0 + y * RH / h) * mh / ch) | 0) * mw + Math.min(mw - 1, ((X0 + x * RW / w) * mw / cw) | 0)]; if (m > 0.5) cnt++; }
    const sz = Math.sqrt(Math.max(256, cnt));
    const gf = (I, r, eps) => { const II = new Float32Array(n); for (let i = 0; i < n; i++) II[i] = I[i] * I[i];
      const mI = LC.blur(I, w, h, r), mII = LC.blur(II, w, h, r), A = new Float32Array(n), B = new Float32Array(n);
      for (let i = 0; i < n; i++) { const v = Math.max(0, mII[i] - mI[i] * mI[i]), a = v / (v + eps); A[i] = a; B[i] = mI[i] * (1 - a); }
      const mA = LC.blur(A, w, h, r), mB = LC.blur(B, w, h, r), o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = mA[i] * I[i] + mB[i]; return o; };
    const rF = Math.max(1, 0.005 * sz), rC = Math.max(3, 0.035 * sz);
    const wG = Math.min(0.85, amt * 1.3), wT = Math.min(0.6, amt * 0.7);   /* keeps real skin texture: smooth, never waxy */
    const F = C.map(I => gf(I, rF, 0.0006)), CO = F.map(f => gf(f, rC, 0.002)), Dl = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) {
      // the skin's own sheen and highlights are what make it look alive (deep skin above all): bumps and dark blotches are smoothed fully, highlights only a little
      const dl = (CO[0][i] - F[0][i]) * 0.3 + (CO[1][i] - F[1][i]) * 0.59 + (CO[2][i] - F[2][i]) * 0.11, fl = F[0][i] * 0.3 + F[1][i] * 0.59 + F[2][i] * 0.11 + 0.02, rel = dl / fl;
      // tattoos, freckles that define the person, lash lines and other strong dark marks are kept: only soft bumps and blotches are smoothed
      const hk = dl < 0 ? 0.3 : Math.max(0, Math.min(1, (0.4 - rel) / 0.2));
      for (let c = 0; c < 3; c++) Dl[c][i] = (F[c][i] - C[c][i]) * wG + (CO[c][i] - F[c][i]) * wT * hk; }
    for (let Y = Y0; Y < Y1; Y++) { const my = Math.min(mh - 1.001, Math.max(0, (Y + 0.5) * mh / ch - 0.5)), my0 = my | 0, vy = my - my0, fy = Math.min(h - 1.001, Math.max(0, (Y - Y0 + 0.5) * h / RH - 0.5)), fy0 = fy | 0, uy = fy - fy0;
      for (let X = X0; X < X1; X++) { const mx = Math.min(mw - 1.001, Math.max(0, (X + 0.5) * mw / cw - 0.5)), mx0 = mx | 0, vx = mx - mx0, mi = my0 * mw + mx0;
        const m = (M[mi] * (1 - vx) + M[mi + 1] * vx) * (1 - vy) + (M[mi + mw] * (1 - vx) + M[mi + mw + 1] * vx) * vy; if (m < 0.03) continue;
        const fx = Math.min(w - 1.001, Math.max(0, (X - X0 + 0.5) * w / RW - 0.5)), fx0 = fx | 0, ux = fx - fx0, fi = fy0 * w + fx0, p = 4 * (Y * cw + X), mm = Math.min(1, m * 1.15) * (FM ? 0.5 + 0.5 * Math.min(1, FM[mi] * 1.3) : 1);   /* faces get the full smoothing, bodies about half, as a retoucher would */
        for (let c = 0; c < 3; c++) { const D = Dl[c], d = (D[fi] * (1 - ux) + D[fi + 1] * ux) * (1 - uy) + (D[fi + w] * (1 - ux) + D[fi + w + 1] * ux) * uy;
          // full-size grain under the reduced copy is taken out too: pull each pixel toward its own small neighbourhood
          data[p + c] += d * mm * 255; } } }
    // pixel-level grain (finer than the reduced copy) on the skin: a small edge-aware smoothing at full size
    if (k < 1 || true) { const g = Math.min(0.7, amt), sig = 5, EW = new Float32Array(256); for (let d = 0; d < 256; d++) EW[d] = Math.exp(-(d * d) / (2 * sig * sig));
      const src = new Uint8ClampedArray(data.subarray(4 * (Y0 * cw), 4 * (Y1 * cw)));
      for (let Y = Y0 + 1; Y < Y1 - 1; Y++) { const my = Math.min(mh - 1, (Y * mh / ch) | 0);
        for (let X = Math.max(1, X0); X < Math.min(cw - 1, X1); X++) { const m = M[my * mw + Math.min(mw - 1, (X * mw / cw) | 0)]; if (m < 0.05) continue; const p = 4 * ((Y - Y0) * cw + X);
          for (let c = 0; c < 3; c++) { const v = src[p + c]; let s1 = 0, s0 = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const q = src[p + 4 * (dy * cw + dx) + c], wv = EW[q > v ? q - v : v - q]; s1 += q * wv; s0 += wv; }
            data[4 * (Y * cw + X) + c] = v + (s1 / s0 - v) * g * Math.min(1, m * 1.2); } } } }
  }

  /* blemish heal and shine control on faces, as a retoucher's healing brush would:
     heal  - small dark or red spots (pimples, marks, small scars) are filled in from the skin right around them; pores and real features stay
     shine - oily hot spots (forehead, nose, cheekbones) are toned down toward the skin around them, never to flat grey */
  function healSkin(data, cw, ch, M, mw, mh, heal, shine) {
    let x0 = mw, y0 = mh, x1 = -1, y1 = -1;
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (M[y * mw + x] > 0.05) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return;
    const X0 = Math.max(0, Math.floor((x0 - 2) * cw / mw)), Y0 = Math.max(0, Math.floor((y0 - 2) * ch / mh)), X1 = Math.min(cw, Math.ceil((x1 + 3) * cw / mw)), Y1 = Math.min(ch, Math.ceil((y1 + 3) * ch / mh));
    const RW = X1 - X0, RH = Y1 - Y0; if (RW < 16 || RH < 16) return;
    const k = Math.min(1, 1400 / Math.max(RW, RH)), w = Math.max(8, Math.round(RW * k)), h = Math.max(8, Math.round(RH * k)), n = w * h, C = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], Wm = new Float32Array(n);
    for (let y = 0; y < h; y++) { const sy = Math.min(ch - 1, Y0 + (((y + 0.5) * RH / h) | 0)), my = Math.min(mh - 1, (sy * mh / ch) | 0);
      for (let x = 0; x < w; x++) { const sx = Math.min(cw - 1, X0 + (((x + 0.5) * RW / w) | 0)), p = 4 * (sy * cw + sx), i = y * w + x; Wm[i] = M[my * mw + Math.min(mw - 1, (sx * mw / cw) | 0)] + 1e-3;
        for (let c = 0; c < 3; c++) C[c][i] = Math.log(data[p + c] / 255 + 0.02) * Wm[i]; } }
    let fw = 0; for (let i = 0; i < n; i++) if (Wm[i] > 0.5) fw++; const fs = Math.sqrt(Math.max(64, fw));
    const r1 = Math.max(0.8, 0.006 * fs), r3 = Math.max(3, 0.035 * fs), b1 = LC.blur(Wm, w, h, r1), b3 = LC.blur(Wm, w, h, r3);
    const S1 = C.map(I => LC.blur(I, w, h, r1)), S3 = C.map(I => LC.blur(I, w, h, r3)), Dl = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) { if (Wm[i] < 0.05) continue;
      const v = [0, 1, 2].map(c => S1[c][i] / b1[i] - S3[c][i] / b3[i]), dl = 0.3 * v[0] + 0.59 * v[1] + 0.11 * v[2], red = v[0] - v[1];
      // a spot: darker than the skin around it, or redder than it; the stronger and the more compact, the surer it is a blemish
      const spot = Math.max(0, Math.min(1, (-dl - 0.03) / 0.05)) + Math.max(0, Math.min(1, (red - 0.035) / 0.05)) * 0.8, wh = Math.min(1, spot) * heal;
      const hot = Math.max(0, Math.min(1, (dl - 0.06) / 0.08)) * shine * 0.7;
      for (let c = 0; c < 3; c++) Dl[c][i] = -v[c] * Math.max(wh, hot); }
    const Ds = Dl.map(d => LC.blur(d, w, h, r1));
    for (let Y = Y0; Y < Y1; Y++) { const my = Math.min(mh - 1.001, Math.max(0, (Y + 0.5) * mh / ch - 0.5)), my0 = my | 0, vy = my - my0, fy = Math.min(h - 1.001, Math.max(0, (Y - Y0 + 0.5) * h / RH - 0.5)), fy0 = fy | 0, uy = fy - fy0;
      for (let X = X0; X < X1; X++) { const mx = Math.min(mw - 1.001, Math.max(0, (X + 0.5) * mw / cw - 0.5)), mx0 = mx | 0, vx = mx - mx0, mi = my0 * mw + mx0;
        const m = (M[mi] * (1 - vx) + M[mi + 1] * vx) * (1 - vy) + (M[mi + mw] * (1 - vx) + M[mi + mw + 1] * vx) * vy; if (m < 0.03) continue;
        const fx = Math.min(w - 1.001, Math.max(0, (X - X0 + 0.5) * w / RW - 0.5)), fx0 = fx | 0, ux = fx - fx0, fi = fy0 * w + fx0, p = 4 * (Y * cw + X);
        for (let c = 0; c < 3; c++) { const D = Ds[c], d = ((D[fi] * (1 - ux) + D[fi + 1] * ux) * (1 - uy) + (D[fi + w] * (1 - ux) + D[fi + w + 1] * ux) * uy) * Math.min(1, m * 1.2); if (d) data[p + c] = ((data[p + c] / 255 + 0.02) * Math.exp(d) - 0.02) * 255; } } }
  }
  /* fabric smoothing: creases and wrinkles in dresses, suits and shirts are flattened (their mid-size shading),
     while seams, lapels, folds with real edges, lace, beading and the weave (fine detail) are kept */
  function fabricSmooth(data, cw, ch, M, mw, mh, amt) {
    let x0 = mw, y0 = mh, x1 = -1, y1 = -1;
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (M[y * mw + x] > 0.05) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return;
    const X0 = Math.max(0, Math.floor((x0 - 2) * cw / mw)), Y0 = Math.max(0, Math.floor((y0 - 2) * ch / mh)), X1 = Math.min(cw, Math.ceil((x1 + 3) * cw / mw)), Y1 = Math.min(ch, Math.ceil((y1 + 3) * ch / mh));
    const RW = X1 - X0, RH = Y1 - Y0; if (RW < 16 || RH < 16) return;
    const k = Math.min(1, 1000 / Math.max(RW, RH)), w = Math.max(8, Math.round(RW * k)), h = Math.max(8, Math.round(RH * k)), n = w * h, I = new Float32Array(n);
    for (let y = 0; y < h; y++) { const sy = Math.min(ch - 1, Y0 + (((y + 0.5) * RH / h) | 0)); for (let x = 0; x < w; x++) { const sx = Math.min(cw - 1, X0 + (((x + 0.5) * RW / w) | 0)), p = 4 * (sy * cw + sx); I[y * w + x] = Math.log((0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255 + 0.02); } }
    const sz = Math.max(w, h), lp = LC.blur(I, w, h, Math.max(1, 0.004 * sz)), r = Math.max(3, 0.03 * sz), eps = 0.006, LL = new Float32Array(n); for (let i = 0; i < n; i++) LL[i] = lp[i] * lp[i];
    const m1 = LC.blur(lp, w, h, r), m2 = LC.blur(LL, w, h, r), A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) { const v = Math.max(0, m2[i] - m1[i] * m1[i]), a = v / (v + eps); A[i] = a; B[i] = m1[i] * (1 - a); }
    const mA = LC.blur(A, w, h, r), mB = LC.blur(B, w, h, r), Dl = new Float32Array(n); for (let i = 0; i < n; i++) Dl[i] = Math.max(-0.35, Math.min(0.35, mA[i] * lp[i] + mB[i] - lp[i]));
    for (let Y = Y0; Y < Y1; Y++) { const my = Math.min(mh - 1.001, Math.max(0, (Y + 0.5) * mh / ch - 0.5)), my0 = my | 0, vy = my - my0, fy = Math.min(h - 1.001, Math.max(0, (Y - Y0 + 0.5) * h / RH - 0.5)), fy0 = fy | 0, uy = fy - fy0;
      for (let X = X0; X < X1; X++) { const mx = Math.min(mw - 1.001, Math.max(0, (X + 0.5) * mw / cw - 0.5)), mx0 = mx | 0, vx = mx - mx0, mi = my0 * mw + mx0;
        const m = (M[mi] * (1 - vx) + M[mi + 1] * vx) * (1 - vy) + (M[mi + mw] * (1 - vx) + M[mi + mw + 1] * vx) * vy; if (m < 0.03) continue;
        const fx = Math.min(w - 1.001, Math.max(0, (X - X0 + 0.5) * w / RW - 0.5)), fx0 = fx | 0, ux = fx - fx0, fi = fy0 * w + fx0, p = 4 * (Y * cw + X);
        const d = ((Dl[fi] * (1 - ux) + Dl[fi + 1] * ux) * (1 - uy) + (Dl[fi + w] * (1 - ux) + Dl[fi + w + 1] * ux) * uy) * Math.min(1, m * 1.2) * amt * 0.85, g = Math.exp(d);
        data[p] = ((data[p] / 255 + 0.02) * g - 0.02) * 255; data[p + 1] = ((data[p + 1] / 255 + 0.02) * g - 0.02) * 255; data[p + 2] = ((data[p + 2] / 255 + 0.02) * g - 0.02) * 255; } }
  }
  /* flyaway hair: thin stray strands just outside the person's outline are replaced by the background behind them.
     Only a narrow band right at the outline is touched, so curls, buns and real hair volume stay. */
  function hairTidy(data, cw, ch, P, mw, mh, amt) {
    const s = Math.min(1, 1200 / Math.max(cw, ch)), w = Math.max(8, Math.round(cw * s)), h = Math.max(8, Math.round(ch * s)), n = w * h, C = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], Wb = new Float32Array(n), band = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x, X = Math.min(cw - 1, (x / s) | 0), Y = Math.min(ch - 1, (y / s) | 0), p = 4 * (Y * cw + X), m = P[Math.min(mh - 1, (Y * mh / ch) | 0) * mw + Math.min(mw - 1, (X * mw / cw) | 0)];
      const bg = m < 0.08 ? 1 : 0; Wb[i] = bg; for (let c = 0; c < 3; c++) C[c][i] = data[p + c] * bg; band[i] = m > 0.04 && m < 0.4 ? 1 - Math.abs(m - 0.2) / 0.2 : 0; }
    const r = Math.max(2, 0.008 * Math.max(w, h)), bW = LC.blur(Wb, w, h, r), BG = C.map(A => LC.blur(A, w, h, r)), bd = LC.blur(band, w, h, 0.002 * Math.max(w, h));
    for (let Y = 0; Y < ch; Y++) { const y = Math.min(h - 1, (Y * s) | 0); for (let X = 0; X < cw; X++) { const i = y * w + Math.min(w - 1, (X * s) | 0), b = bd[i]; if (b < 0.02 || bW[i] < 0.15) continue;
      const p = 4 * (Y * cw + X), t = Math.min(1, b * 1.5) * amt * 0.9; for (let c = 0; c < 3; c++) data[p + c] += (BG[c][i] / bW[i] - data[p + c]) * t; } }
  }
  /* soft glow: the bright parts of the scene bloom gently, the dreamy wedding look (an Orton-style glow), kept off deep shadows so nothing goes milky */
  function glowFx(data, cw, ch, amt) {
    const s = Math.min(1, 900 / Math.max(cw, ch)), w = Math.max(8, Math.round(cw * s)), h = Math.max(8, Math.round(ch * s)), n = w * h, R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = 4 * (Math.min(ch - 1, (y / s) | 0) * cw + Math.min(cw - 1, (x / s) | 0)), i = y * w + x, r = data[p] / 255, g = data[p + 1] / 255, b = data[p + 2] / 255, l = 0.299 * r + 0.587 * g + 0.114 * b, k = Math.pow(Math.max(0, (l - 0.35) / 0.65), 1.6); R[i] = r * k; G[i] = g * k; B[i] = b * k; }
    const rr = 0.02 * Math.max(w, h), Rb = LC.blur(R, w, h, rr), Gb = LC.blur(G, w, h, rr), Bb = LC.blur(B, w, h, rr), a = 0.55 * amt;
    for (let y = 0; y < ch; y++) { const fy = Math.min(h - 1.001, y * s), y0 = fy | 0, uy = fy - y0;
      for (let x = 0; x < cw; x++) { const fx = Math.min(w - 1.001, x * s), x0 = fx | 0, ux = fx - x0, i = y0 * w + x0, p = 4 * (y * cw + x);
        const L = A => (A[i] * (1 - ux) + A[i + 1] * ux) * (1 - uy) + (A[i + w] * (1 - ux) + A[i + w + 1] * ux) * uy, gv = [L(Rb), L(Gb), L(Bb)];
        for (let c = 0; c < 3; c++) { const v = data[p + c] / 255, sc = 1 - (1 - v) * (1 - gv[c] * a); data[p + c] = sc * 255; } } }
  }
  /* sun flare: a warm light source just at or outside the frame - a hot core, a wide soft bloom, a faint haze over the frame on that side and a few soft ghosts along the line through the centre */
  function flareFx(data, cw, ch, amt, fx, fy, warm) {
    const W = Math.max(cw, ch), cx = fx * cw, cy = fy * ch, wt = warm / 100, col = [1, 0.86 - 0.12 * wt, 0.62 - 0.32 * wt], ghosts = [[0.55, 0.06, 0.7], [0.85, 0.035, 0.55], [1.3, 0.1, 0.35]];
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const dx = (x - cx) / W, dy = (y - cy) / W, d2 = dx * dx + dy * dy, p = 4 * (y * cw + x);
      let e = 1.3 * Math.exp(-d2 / 0.003) + 0.75 * Math.exp(-d2 / 0.04) + 0.45 * Math.exp(-d2 / 0.25) + 0.35 * Math.exp(-(dy * dy) / 0.0001 - (dx * dx) / 0.15);   /* core, bloom, haze, a soft horizontal streak */
      for (const [t, r, k] of ghosts) { const gx = cx + (cw / 2 - cx) * 2 * t, gy = cy + (ch / 2 - cy) * 2 * t, gd = ((x - gx) ** 2 + (y - gy) ** 2) / (W * W); e += k * 0.3 * Math.exp(-gd / (r * r)); }
      e *= amt; if (e < 0.002) continue;
      for (let c = 0; c < 3; c++) { const v = data[p + c] / 255; data[p + c] = (1 - (1 - v) * (1 - Math.min(1, e * col[c]))) * 255; } }
  }

  /* people boxes (in original-photo coordinates) carried through crop/rotate/flip into map space */
  function boxMaps(people, s, SW, SH, w, h) {
    const k = 256 / Math.max(SW, SH), bw = Math.max(2, Math.round(SW * k)), bh = Math.max(2, Math.round(SH * k)), c = document.createElement('canvas'); c.width = bw; c.height = bh;
    const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, bw, bh); x.globalCompositeOperation = 'lighter';
    const low = document.createElement('canvas'); low.width = bw; low.height = bh; const lx = low.getContext('2d'); lx.fillStyle = '#000'; lx.fillRect(0, 0, bw, bh); lx.fillStyle = '#fff';
    for (const p of people) { const [a, b, cc, d] = p.b; if (d > 0.96 && p.f && p.f[3] - p.f[1] > 0.2) { /* close and waist-up shots only: in a full-length shot the floor around the feet is not them */ const fy = p.f ? p.f[3] + (p.f[3] - p.f[1]) * 0.6 : (b + d) / 2, mx = (a + cc) / 2, hw = (cc - a) * 0.4; lx.fillRect((mx - hw) * bw, fy * bh, 2 * hw * bw, bh - fy * bh); } x.fillStyle = '#f00'; x.fillRect(a * bw, b * bh, (cc - a) * bw, (d - b) * bh);
      x.fillStyle = '#00f'; x.beginPath(); x.ellipse((a + cc) / 2 * bw, (b + d) / 2 * bh, (cc - a) * bw * 0.27, (d - b) * bh * 0.44, 0, 0, 7); x.fill();
      // a body that runs off the bottom of the frame: the bottom of the frame under them is them (dress, suit), however dark
      if (p.f) { const [fa, fb, fc, fd] = p.f; x.fillStyle = '#0f0'; x.beginPath(); x.ellipse((fa + fc) / 2 * bw, (fb + fd) / 2 * bh, (fc - fa) * bw * 0.42, (fd - fb) * bh * 0.46, 0, 0, 7); x.fill(); } }
    const o = document.createElement('canvas'); o.width = w; o.height = h; const ox = o.getContext('2d', { willReadFrequently: true }); ox.fillStyle = '#000'; ox.fillRect(0, 0, w, h);
    if (s) D.drawGeom(ox, c, bw, bh, s, w, h); else ox.drawImage(c, 0, 0, w, h);
    const d = ox.getImageData(0, 0, w, h).data, box = new Float32Array(w * h), face = new Float32Array(w * h), core = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) { box[i] = d[4 * i] > 100 ? 1 : 0; face[i] = d[4 * i + 1] > 100 ? 1 : 0; core[i] = d[4 * i + 2] > 100 ? 1 : 0; }
    ox.fillStyle = '#000'; ox.fillRect(0, 0, w, h); if (s) D.drawGeom(ox, low, bw, bh, s, w, h); else ox.drawImage(low, 0, 0, w, h);
    const ld = ox.getImageData(0, 0, w, h).data, lower = new Float32Array(w * h); for (let i = 0; i < w * h; i++) lower[i] = ld[4 * i] > 100 ? 1 : 0;
    return { box, face, core, lower };
  }
  /* Portrait dodge & burn, the way a retoucher paints it, placed from each face's eyes, nose and mouth.
     Returns maps at map size: dodge (forehead, nose bridge, under-eyes, cheekbones, chin, catchlights),
     burn (temples, cheek hollows, jawline, sides of the nose); each split into the face's left and right half. */
  function faceSculpt(people, s, SW, SH, w, h) {
    const k = 512 / Math.max(SW, SH), bw = Math.max(2, Math.round(SW * k)), bh = Math.max(2, Math.round(SH * k));
    const mk = () => { const c = document.createElement('canvas'); c.width = bw; c.height = bh; const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, bw, bh); x.globalCompositeOperation = 'lighter'; return [c, x]; };
    const [cA, xA] = mk(), [cB, xB] = mk();   // R = left half, G = right half; cA dodge, cB burn
    const spot = (x, px, py, rx, ry, rot, a, ch) => { if (a <= 0 || rx < 0.5) return; x.save(); x.translate(px, py); x.rotate(rot); x.scale(1, ry / rx);
      const g = x.createRadialGradient(0, 0, 0, 0, 0, rx), c = ch ? `0,${Math.round(255 * a)},0` : `${Math.round(255 * a)},0,0`; g.addColorStop(0, `rgb(${c})`); g.addColorStop(0.5, `rgba(${c},.55)`); g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g; x.beginPath(); x.arc(0, 0, rx, 0, 7); x.fill(); x.restore(); };
    let any = false;
    for (const p of people) {
      if (!p.f && !p.lm) continue;
      let le, re, no, mo;
      const lmOk = p.lm && p.lm.le && p.lm.re && (!p.f || (() => { const [a, b, c, d] = p.f, fw = c - a, fh = d - b, inF = q => q && q[0] > a - 0.1 * fw && q[0] < c + 0.1 * fw && q[1] > b - 0.1 * fh && q[1] < d + 0.1 * fh, ed = Math.hypot(p.lm.re[0] - p.lm.le[0], p.lm.re[1] - p.lm.le[1]);
        return inF(p.lm.le) && inF(p.lm.re) && ed > 0.18 * fw && ed < 0.8 * fw && (!p.lm.n || inF(p.lm.n)) && (!p.lm.m || inF(p.lm.m)); })());   /* landmarks that don't sit inside the face are ignored, so light never lands off the features */
      if (lmOk) { le = p.lm.le; re = p.lm.re; no = p.lm.n; mo = p.lm.m; }
      else { const [a, b, c, d] = p.f, fw = c - a, fh = d - b; le = [a + 0.3 * fw, b + 0.42 * fh]; re = [a + 0.7 * fw, b + 0.42 * fh]; no = [a + 0.5 * fw, b + 0.62 * fh]; mo = [a + 0.5 * fw, b + 0.78 * fh]; }
      const P = v => [v[0] * bw, v[1] * bh], L = P(le), R = P(re), ex = (L[0] + R[0]) / 2, ey = (L[1] + R[1]) / 2;
      let d = Math.hypot(R[0] - L[0], R[1] - L[1]); if (d < 3) continue; any = true;
      const ang = Math.atan2(R[1] - L[1], R[0] - L[0]), ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;   // u: across the face (left eye to right eye), v: down the face
      const N = no ? P(no) : [ex + vx * 0.75 * d, ey + vy * 0.75 * d], M = mo ? P(mo) : [N[0] + vx * 0.45 * d, N[1] + vy * 0.45 * d];
      const down = Math.max(0.5 * d, Math.hypot(M[0] - ex, M[1] - ey));   // eyes to mouth
      const at = (a, b) => [ex + ux * a * d + vx * b * down, ey + uy * a * d + vy * b * down];
      // side: 0 = left half, 1 = right half of the face (as seen in the photo)
      const D = (pt, rx, ry, a, side) => spot(xA, pt[0], pt[1], 1.45 * rx * d, 1.45 * ry * d, ang, a, side), B = (pt, rx, ry, a, side) => spot(xB, pt[0], pt[1], 1.5 * rx * d, 1.5 * ry * d, ang, a, side);   /* wide, soft shapes: light that reads as light, not as painted spots */
      for (const sd of [0, 1]) {
        const sg = sd ? 1 : -1;
        D(at(sg * 0.2, -0.55), 0.38, 0.3, 0.55, sd);            // forehead
        D(at(sg * 0.06, 0.45), 0.09, 0.42, 0.75, sd);           // nose bridge
        D(at(sg * 0.5, 0.28), 0.17, 0.09, 0.7, sd);             // under the eye
        D(at(sg * 0.68, 0.55), 0.24, 0.13, 0.75, sd);           // cheekbone
        D(at(sg * 0.07, 1.42), 0.2, 0.12, 0.6, sd);             // chin
        D(at(sg * 0.5, 0), 0.07, 0.07, 0.55, sd);               // the eye itself (catchlight, whites)
        B(at(sg * 1.0, -0.2), 0.2, 0.32, 0.8, sd);              // temple
        B(at(sg * 0.8, 0.95), 0.18, 0.28, 0.85, sd);            // cheek hollow under the cheekbone
        B(at(sg * 0.68, 1.45), 0.3, 0.14, 0.75, sd);            // jawline
        B(at(sg * 0.2, 0.62), 0.06, 0.24, 0.6, sd);             // side of the nose
      }
    }
    if (!any) return null;
    const out = (c) => { const o = document.createElement('canvas'); o.width = w; o.height = h; const ox = o.getContext('2d', { willReadFrequently: true }); ox.fillStyle = '#000'; ox.fillRect(0, 0, w, h); if (s) D.drawGeom(ox, c, bw, bh, s, w, h); else ox.drawImage(c, 0, 0, w, h); return ox.getImageData(0, 0, w, h).data; };
    const a = out(cA), b = out(cB), n = w * h, r = { dL: new Float32Array(n), dR: new Float32Array(n), bL: new Float32Array(n), bR: new Float32Array(n) };
    for (let i = 0; i < n; i++) { r.dL[i] = a[4 * i] / 255; r.dR[i] = a[4 * i + 1] / 255; r.bL[i] = b[4 * i] / 255; r.bR[i] = b[4 * i + 1] / 255; }
    return r;
  }
  /* where the eyes, the skin under them and the mouth are, as soft maps (R eyes, G under-eye, B mouth), from the face landmarks */
  function faceFeatures(people, s, SW, SH, w, h) {
    const k = 1024 / Math.max(SW, SH), bw = Math.max(2, Math.round(SW * k)), bh = Math.max(2, Math.round(SH * k)), c = document.createElement('canvas'); c.width = bw; c.height = bh;
    const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, bw, bh); x.globalCompositeOperation = 'lighter'; let any = false;
    const blob = (px, py, rx, ry, rot, col) => { if (rx < 0.5) return; x.save(); x.translate(px, py); x.rotate(rot); x.scale(1, ry / rx); const g = x.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, `rgb(${col})`); g.addColorStop(0.55, `rgba(${col},.8)`); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.beginPath(); x.arc(0, 0, rx, 0, 7); x.fill(); x.restore(); };
    for (const p of people) {
      if (!p.lm || !p.lm.le || !p.lm.re || !p.f) continue;
      const [a, b, cc, d] = p.f, fw = cc - a, fh = d - b, inF = q => q && q[0] > a - 0.1 * fw && q[0] < cc + 0.1 * fw && q[1] > b - 0.1 * fh && q[1] < d + 0.1 * fh;
      const ed = Math.hypot(p.lm.re[0] - p.lm.le[0], p.lm.re[1] - p.lm.le[1]); if (!(inF(p.lm.le) && inF(p.lm.re) && ed > 0.18 * fw && ed < 0.8 * fw)) continue;
      const P = v => [v[0] * bw, v[1] * bh], L = P(p.lm.le), R = P(p.lm.re), dd = Math.hypot(R[0] - L[0], R[1] - L[1]); if (dd < 4) continue; any = true;
      const ang = Math.atan2(R[1] - L[1], R[0] - L[0]), vx = -Math.sin(ang), vy = Math.cos(ang);
      for (const E of [L, R]) { blob(E[0], E[1], 0.22 * dd, 0.12 * dd, ang, '255,0,0'); blob(E[0] + vx * 0.24 * dd, E[1] + vy * 0.24 * dd, 0.22 * dd, 0.1 * dd, ang, '0,255,0'); }
      const M = p.lm.m && inF(p.lm.m) ? P(p.lm.m) : [(L[0] + R[0]) / 2 + vx * 1.15 * dd, (L[1] + R[1]) / 2 + vy * 1.15 * dd];
      blob(M[0], M[1], 0.34 * dd, 0.15 * dd, ang, '0,0,255');
    }
    if (!any) return null;
    const o = document.createElement('canvas'); o.width = w; o.height = h; const ox = o.getContext('2d', { willReadFrequently: true }); ox.fillStyle = '#000'; ox.fillRect(0, 0, w, h);
    if (s) D.drawGeom(ox, c, bw, bh, s, w, h); else ox.drawImage(c, 0, 0, w, h);
    return { d: ox.getImageData(0, 0, w, h).data, w, h };
  }
  /* Beautify: the polished-portrait finish, without redrawing anyone's face.
     Skin: blotches and uneven tone evened out (micro dodge & burn) while pores stay; eyes: clearer whites and crisper iris and lashes;
     under the eyes: shadows lifted; teeth: a touch whiter; and a soft glow on the skin's highlights. */
  function beautify(data, cw, ch, F, S, mw, mh, amt, eyA, thA) { eyA = eyA || 0; thA = thA || 0;
    const fx = F ? F.w / cw : 0, fy = F ? F.h / ch : 0, sxm = mw / cw, sym = mh / ch;
    const samp = (M, W, H, X, Y) => { const x = Math.min(W - 1.001, Math.max(0, X)), y = Math.min(H - 1.001, Math.max(0, Y)), x0 = x | 0, y0 = y | 0, u = x - x0, v = y - y0, i = y0 * W + x0; return (M[i] * (1 - u) + M[i + 1] * u) * (1 - v) + (M[i + W] * (1 - u) + M[i + W + 1] * u) * v; };
    // glow: the bright side of the skin blooms softly (built small, then laid back over the full photo)
    const gk = Math.min(1, 360 / Math.max(cw, ch)), gw = Math.max(8, Math.round(cw * gk)), gh = Math.max(8, Math.round(ch * gk)), G = new Float32Array(gw * gh * 3);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { const X = Math.min(cw - 1, ((x + 0.5) / gk) | 0), Y = Math.min(ch - 1, ((y + 0.5) / gk) | 0), p = 4 * (Y * cw + X), m = samp(S, mw, mh, X * sxm, Y * sym);
      const r = data[p] / 255, g = data[p + 1] / 255, b = data[p + 2] / 255, L = 0.299 * r + 0.587 * g + 0.114 * b, hi = m * Math.pow(Math.max(0, L - 0.45) / 0.55, 1.5), i = 3 * (y * gw + x); G[i] = r * hi; G[i + 1] = g * hi; G[i + 2] = b * hi; }
    const Gr = [0, 1, 2].map(c => { const a = new Float32Array(gw * gh); for (let i = 0; i < a.length; i++) a[i] = G[3 * i + c]; return LC.blur(a, gw, gh, 0.012 * Math.max(gw, gh)); });
    const ga = 0.22 * amt; if (!F && !(amt > 0)) return;
    for (let Y = 0; Y < ch; Y++) for (let X = 0; X < cw; X++) {
      const p = 4 * (Y * cw + X); let r = data[p] / 255, g = data[p + 1] / 255, b = data[p + 2] / 255;
      const sk = samp(S, mw, mh, X * sxm, Y * sym);
      if (sk > 0.02 && ga > 0) { const gx = X * gk, gy = Y * gk; r = 1 - (1 - r) * (1 - ga * samp(Gr[0], gw, gh, gx, gy)); g = 1 - (1 - g) * (1 - ga * samp(Gr[1], gw, gh, gx, gy)); b = 1 - (1 - b) * (1 - ga * samp(Gr[2], gw, gh, gx, gy)); }
      if (F) { const fX = Math.min(F.w - 1, (X * fx) | 0), fY = Math.min(F.h - 1, (Y * fy) | 0), q = 4 * (fY * F.w + fX), eM = F.d[q] / 255, uM = F.d[q + 1] / 255, mM = F.d[q + 2] / 255;
        if (eM > 0.02 || uM > 0.02 || mM > 0.02) {
          const L = 0.299 * r + 0.587 * g + 0.114 * b, mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx > 1e-4 ? (mx - mn) / mx : 0;
          if (eM > 0.02) { const e = eM * Math.min(1, amt + eyA), ey = eM * eyA;
            // red veins and redness in the whites: pulled back to a clean, slightly warm white
            if (ey > 0.02 && L > 0.25 && r > g * 1.08 && sat < 0.55) { const k = 1 - 0.7 * ey * Math.min(1, (r / g - 1.08) / 0.25); r = g + (r - g) * k; }
            // catchlight and iris sparkle: the brightest specks a touch brighter, the iris clearer
            if (ey > 0.02 && L > 0.7) { const k = 1 + 0.18 * ey; r = Math.min(1, r * k); g = Math.min(1, g * k); b = Math.min(1, b * k); }
            else if (ey > 0.02 && L > 0.12 && L < 0.32 && sat > 0.15) { const k = 1 + 0.25 * ey; r = L + (r - L) * k * 1.04; g = L + (g - L) * k * 1.04; b = L + (b - L) * k * 1.04; }
            if (L > 0.32 && sat < 0.38) { const k = 1 - 0.55 * e, t = Math.min(1, L * (1 + 0.14 * e)); r = t + (r - L) * k; g = t + (g - L) * k; b = t + (b - L) * k; }   // whites of the eyes: cleaner and a little brighter
            else if (L < 0.3) { const k = 1 - 0.28 * e; r *= k; g *= k; b *= k; } }                                                                        // iris, lashes, liner: a touch deeper, so the eyes read crisp
          if (uM > 0.02) { const u = uM * amt * 0.22 * Math.max(0, 1 - L / 0.75), k = 1 + u; r = Math.min(1, r * k); g = Math.min(1, g * k); b = Math.min(1, b * k); }   // lift shadows under the eyes
          if (mM > 0.02 && L > 0.38 && sat < 0.42 && r >= b) { const t = mM * Math.min(1, amt + 1.4 * thA) * Math.min(1, (0.42 - sat) / 0.15), L2 = Math.min(1, L * (1 + 0.08 * t)), k = 1 - 0.6 * t; r = L2 + (r - L) * k; g = L2 + (g - L) * k; b = L2 + (b - L) * k; }   // teeth
        } }
      data[p] = r * 255; data[p + 1] = g * 255; data[p + 2] = b * 255;
    }
  }
  /* Definition, the second half of Beautify: faces get their shape (gentle large-scale contrast: cheekbones, jaw, brow), real edges get crisp
     (eyes, lashes, brows, hairline, stubble) while flat skin stays smooth, and hair is calmed (not lifted or turned orange by the skin work) */
  function define(data, cw, ch, P, H, mw, mh, amt, thr, SK) {
    const k = Math.min(1, 900 / Math.max(cw, ch)), w = Math.max(8, Math.round(cw * k)), h = Math.max(8, Math.round(ch * k)), n = w * h, L = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const X = Math.min(cw - 1, ((x + 0.5) / k) | 0), Y = Math.min(ch - 1, ((y + 0.5) / k) | 0), p = 4 * (Y * cw + X); L[y * w + x] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255; }
    const B = LC.blur(L, w, h, 0.02 * Math.max(w, h));   // the face's broad light and shadow
    const samp = (M, W, Hh, X, Y) => { const x = Math.min(W - 1.001, Math.max(0, X)), y = Math.min(Hh - 1.001, Math.max(0, Y)), x0 = x | 0, y0 = y | 0, u = x - x0, v = y - y0, i = y0 * W + x0; return (M[i] * (1 - u) + M[i + 1] * u) * (1 - v) + (M[i + W] * (1 - u) + M[i + W + 1] * u) * v; };
    const src = new Uint8ClampedArray(data), shape = 0.4 * amt, crisp = 0, T = Math.max(2.5, thr);
    for (let Y = 1; Y < ch - 1; Y++) for (let X = 1; X < cw - 1; X++) {
      const pm = samp(P, mw, mh, X * mw / cw, Y * mh / ch); if (pm < 0.03) continue;
      const p = 4 * (Y * cw + X), l = (0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2]) / 255, b = samp(B, w, h, X * k, Y * k), hm = H ? samp(H, mw, mh, X * mw / cw, Y * mh / ch) : 0;
      // shape: push light and shadow apart a little, most in the midtones
      let d = (l - b) * shape * pm * (1 - Math.abs(2 * l - 1)) * 255;
      // crisp: a fine unsharp mask above the grain level (edges only)
      let s4 = 0; for (const o of [-4, 4, -4 * cw, 4 * cw]) s4 += 0.299 * src[p + o] + 0.587 * src[p + o + 1] + 0.114 * src[p + o + 2]; const e = l * 255 - s4 / 4;
      if (Math.abs(e) > T) d += (e - Math.sign(e) * T) * crisp * pm * (SK ? 1 - 0.85 * samp(SK, mw, mh, X * mw / cw, Y * mh / ch) : 1);   // smooth skin stays smooth; eyes, brows, hair and stubble get the crispness
      let r = src[p] + d, g = src[p + 1] + d, bb = src[p + 2] + d;
      // hair: a little deeper and less orange, so it keeps its natural colour next to brightened skin
      if (hm > 0.02) { const t = hm * Math.min(1, amt * 1.4), Lh = 0.299 * r + 0.587 * g + 0.114 * bb, kk = 1 - 0.1 * t, sat = 1 - 0.2 * t; r = Lh * kk + (r - Lh) * kk * sat; g = Lh * kk + (g - Lh) * kk * sat; bb = Lh * kk + (bb - Lh) * kk * sat; }
      data[p] = r; data[p + 1] = g; data[p + 2] = bb;
    }
  }
  /* background blur: soft lens blur behind the people, bright spots bloom like real bokeh; people never bleed into it */
  function bgBlur(data, cw, ch, M, mw, mh, amt) {
    const k = Math.min(1, 720 / Math.max(cw, ch)), w = Math.max(8, Math.round(cw * k)), h = Math.max(8, Math.round(ch * k)), n = w * h;
    const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), Wt = new Float32Array(n);
    for (let y = 0; y < h; y++) { const sy = Math.min(ch - 1, ((y + 0.5) * ch / h) | 0), my = Math.min(mh - 1, ((y + 0.5) * mh / h) | 0);
      for (let x = 0; x < w; x++) { const sx = Math.min(cw - 1, ((x + 0.5) * cw / w) | 0), p = 4 * (sy * cw + sx), m = M[my * mw + Math.min(mw - 1, ((x + 0.5) * mw / w) | 0)];
        const r = lin(data[p] / 255), g = lin(data[p + 1] / 255), b = lin(data[p + 2] / 255), L = 0.299 * r + 0.587 * g + 0.114 * b, wt = (1 - m) * (1 - m) * (1 + 10 * Math.max(0, L - 0.5)) + 1e-4, i = y * w + x;
        R[i] = r * wt; G[i] = g * wt; B[i] = b * wt; Wt[i] = wt; } }
    const rad = Math.max(1, amt * 0.028 * Math.max(w, h)), bR = LC.blur(R, w, h, rad), bG = LC.blur(G, w, h, rad), bB = LC.blur(B, w, h, rad), bW = LC.blur(Wt, w, h, rad);
    for (let Y = 0; Y < ch; Y++) { const my = Math.min(mh - 1.001, Math.max(0, (Y + 0.5) * mh / ch - 0.5)), my0 = my | 0, vy = my - my0, fy = Math.min(h - 1.001, Math.max(0, (Y + 0.5) * h / ch - 0.5)), fy0 = fy | 0, uy = fy - fy0;
      for (let X = 0; X < cw; X++) { const mx = Math.min(mw - 1.001, Math.max(0, (X + 0.5) * mw / cw - 0.5)), mx0 = mx | 0, vx = mx - mx0, mi = my0 * mw + mx0;
        const m = (M[mi] * (1 - vx) + M[mi + 1] * vx) * (1 - vy) + (M[mi + mw] * (1 - vx) + M[mi + mw + 1] * vx) * vy, a = 1 - m; if (a < 0.02) continue;
        const fx = Math.min(w - 1.001, Math.max(0, (X + 0.5) * w / cw - 0.5)), fx0 = fx | 0, ux = fx - fx0, i = fy0 * w + fx0, q = (A) => (A[i] * (1 - ux) + A[i + 1] * ux) * (1 - uy) + (A[i + w] * (1 - ux) + A[i + w + 1] * ux) * uy;
        const wv = Math.max(1e-5, q(bW)), p = 4 * (Y * cw + X);
        data[p] += (gam(Math.min(1, q(bR) / wv)) * 255 - data[p]) * a; data[p + 1] += (gam(Math.min(1, q(bG) / wv)) * 255 - data[p + 1]) * a; data[p + 2] += (gam(Math.min(1, q(bB) / wv)) * 255 - data[p + 2]) * a; } }
  }
  /* bokeh lights: soft out-of-focus light discs added behind the people */
  function bokehLights(data, cw, ch, M, mw, mh, amt, seed) {
    let sd = seed | 0; const rnd = () => { sd = sd + 0x6D2B79F5 | 0; let t = Math.imul(sd ^ sd >>> 15, 1 | sd); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const k = Math.min(1, 1000 / Math.max(cw, ch)), w = Math.round(cw * k), h = Math.round(ch * k), c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#000'; x.fillRect(0, 0, w, h); x.globalCompositeOperation = 'lighter';
    const N = Math.round(10 + 34 * amt), big = Math.max(w, h), cols = [[255, 205, 140], [255, 226, 180], [255, 240, 215], [255, 190, 120]];
    for (let j = 0; j < N * 3 && j < 400; j++) { const px = rnd(), py = Math.pow(rnd(), 1.6) * 0.8, r = (0.022 + 0.045 * rnd()) * big, a = (0.1 + 0.26 * rnd()) * (0.5 + 0.5 * amt), cl = cols[(rnd() * cols.length) | 0];
      if (M[Math.min(mh - 1, (py * mh) | 0) * mw + Math.min(mw - 1, (px * mw) | 0)] > 0.3 && rnd() < 0.8) continue;
      const g = x.createRadialGradient(px * w, py * h, r * 0.72, px * w, py * h, r); g.addColorStop(0, `rgba(${cl[0]},${cl[1]},${cl[2]},${a})`); g.addColorStop(0.8, `rgba(${cl[0]},${cl[1]},${cl[2]},${a * 1.25})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g; x.beginPath(); x.arc(px * w, py * h, r, 0, 7); x.fill(); }
    const d = x.getImageData(0, 0, w, h).data;
    for (let Y = 0; Y < ch; Y++) { const my = Math.min(mh - 1, ((Y + 0.5) * mh / ch) | 0), ly = Math.min(h - 1, ((Y + 0.5) * h / ch) | 0);
      for (let X = 0; X < cw; X++) { const a = 1 - M[my * mw + Math.min(mw - 1, ((X + 0.5) * mw / cw) | 0)]; if (a < 0.02) continue; const q = 4 * (ly * w + Math.min(w - 1, ((X + 0.5) * w / cw) | 0)), p = 4 * (Y * cw + X);
        for (let c2 = 0; c2 < 3; c2++) { const v = d[q + c2] / 255 * a; if (v > 0.003) data[p + c2] = 255 - (255 - data[p + c2]) * (1 - v); } } }
  }

  /* even skin tone: takes out blotches (patches a little lighter or darker than the skin around them) while keeping
     pores and fine detail (smaller than the patches) and the face's real shape and shading (larger than the patches). */
  function evenSkin(data, cw, ch, M, mw, mh, amt) {
    let x0 = mw, y0 = mh, x1 = -1, y1 = -1;
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (M[y * mw + x] > 0.05) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return;
    const X0 = Math.max(0, Math.floor((x0 - 2) * cw / mw)), Y0 = Math.max(0, Math.floor((y0 - 2) * ch / mh)), X1 = Math.min(cw, Math.ceil((x1 + 3) * cw / mw)), Y1 = Math.min(ch, Math.ceil((y1 + 3) * ch / mh));
    const RW = X1 - X0, RH = Y1 - Y0; if (RW < 16 || RH < 16) return;
    const k = Math.min(1, 900 / Math.max(RW, RH)), w = Math.max(8, Math.round(RW * k)), h = Math.max(8, Math.round(RH * k)), n = w * h, C = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], Wm = new Float32Array(n);
    for (let y = 0; y < h; y++) { const sy = Math.min(ch - 1, Y0 + (((y + 0.5) * RH / h) | 0)), my = Math.min(mh - 1, (sy * mh / ch) | 0);
      for (let x = 0; x < w; x++) { const sx = Math.min(cw - 1, X0 + (((x + 0.5) * RW / w) | 0)), p = 4 * (sy * cw + sx), i = y * w + x, m = M[my * mw + Math.min(mw - 1, (sx * mw / cw) | 0)]; Wm[i] = m + 1e-3;
        // work in log light so a patch is "x% darker" wherever it sits; weight by the mask so hair and background don't leak in
        for (let c = 0; c < 3; c++) C[c][i] = Math.log(data[p + c] / 255 + 0.02) * Wm[i]; } }
    // patches are judged against the skin around them, measured across the whole face
    let fw = 0; for (let i = 0; i < n; i++) if (Wm[i] > 0.5) fw++; const faceSize = Math.sqrt(Math.max(64, fw));
    const rs = Math.max(1.2, 0.012 * faceSize), rl = Math.max(6, 0.11 * faceSize), bWs = LC.blur(Wm, w, h, rs), bWl = LC.blur(Wm, w, h, rl), D = [];
    for (let c = 0; c < 3; c++) { const s1 = LC.blur(C[c], w, h, rs), l1 = LC.blur(C[c], w, h, rl), d = new Float32Array(n);
      for (let i = 0; i < n; i++) { const v = s1[i] / bWs[i] - l1[i] / bWl[i], lim = 0.12; d[i] = -lim * Math.tanh(v / lim) * (v > 0 ? 0.25 : 1); }   /* dark blotches evened; the skin's sheen and highlights stay */ D.push(d); }
    for (let Y = Y0; Y < Y1; Y++) { const my = Math.min(mh - 1.001, Math.max(0, (Y + 0.5) * mh / ch - 0.5)), my0 = my | 0, vy = my - my0, fy = Math.min(h - 1.001, Math.max(0, (Y - Y0 + 0.5) * h / RH - 0.5)), fy0 = fy | 0, uy = fy - fy0;
      for (let X = X0; X < X1; X++) { const mx = Math.min(mw - 1.001, Math.max(0, (X + 0.5) * mw / cw - 0.5)), mx0 = mx | 0, vx = mx - mx0, mi = my0 * mw + mx0;
        const m = (M[mi] * (1 - vx) + M[mi + 1] * vx) * (1 - vy) + (M[mi + mw] * (1 - vx) + M[mi + mw + 1] * vx) * vy; if (m < 0.03) continue;
        const fx = Math.min(w - 1.001, Math.max(0, (X - X0 + 0.5) * w / RW - 0.5)), fx0 = fx | 0, ux = fx - fx0, fi = fy0 * w + fx0, p = 4 * (Y * cw + X);
        for (let c = 0; c < 3; c++) { const d = ((D[c][fi] * (1 - ux) + D[c][fi + 1] * ux) * (1 - uy) + (D[c][fi + w] * (1 - ux) + D[c][fi + w + 1] * ux) * uy) * m * amt; data[p + c] = ((data[p + c] / 255 + 0.02) * Math.exp(d) - 0.02) * 255; } } }
  }

  /* noise reduction for high-ISO shots: colour noise is smoothed hard, brightness noise gently and only where there are no edges */
  /* how grainy the photo is: the typical pixel-to-pixel wobble in flat areas (0-255 scale) */
  function noiseSigma(data, w, h) { const v = []; const step = Math.max(2, Math.round(Math.sqrt(w * h / 40000)));
    for (let y = 1; y < h - 1; y += step) for (let x = 1; x < w - 1; x += step) { const p = 4 * (y * w + x), L = q => 0.299 * data[q] + 0.587 * data[q + 1] + 0.114 * data[q + 2];
      const c = L(p), d = c - (L(p - 4) + L(p + 4) + L(p - 4 * w) + L(p + 4 * w)) / 4; v.push(Math.abs(d)); }
    v.sort((a, b) => a - b); return 1.4826 * v[(v.length * 0.5) | 0] / 1.118; }
  function denoise(data, w, h, amt, scale) {
    const n = w * h, Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
    const sig = noiseSigma(data, w, h) / 255;   // measured grain
    for (let i = 0; i < n; i++) { const r = data[4 * i], g = data[4 * i + 1], b = data[4 * i + 2]; const y = 0.299 * r + 0.587 * g + 0.114 * b; Y[i] = y / 255; Cb[i] = (b - y) / 255; Cr[i] = (r - y) / 255; }
    // brightness smoothing is sized to the grain actually in the photo: grain is flattened, real edges and texture stronger than it stay
    const rc = Math.max(1, 4 * scale * (0.5 + amt)), rl = Math.max(1, (1.5 + 2 * amt) * Math.max(0.5, scale)), eps = 0.00015 + Math.pow(sig * (1.5 + 3 * amt), 2);
    const cb = LC.blur(Cb, w, h, rc), cr = LC.blur(Cr, w, h, rc);
    // guided filter on brightness: flat areas are smoothed, edges and texture with real contrast are kept
    const YY = new Float32Array(n); for (let i = 0; i < n; i++) YY[i] = Y[i] * Y[i];
    const mY = LC.blur(Y, w, h, rl), mYY = LC.blur(YY, w, h, rl), A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) { const v = Math.max(0, mYY[i] - mY[i] * mY[i]), a = v / (v + eps); A[i] = a; B[i] = mY[i] * (1 - a); }
    const mA = LC.blur(A, w, h, rl), mB = LC.blur(B, w, h, rl), ky = 0.85 * amt, kc = Math.min(1, 1.2 * amt);
    for (let i = 0; i < n; i++) { const y = Y[i] + (mA[i] * Y[i] + mB[i] - Y[i]) * ky, b = Cb[i] + (cb[i] - Cb[i]) * kc, r = Cr[i] + (cr[i] - Cr[i]) * kc;
      const R = (y + r) * 255, Bv = (y + b) * 255, G = (y * 255 - 0.299 * R - 0.114 * Bv) / 0.587; data[4 * i] = R; data[4 * i + 1] = G; data[4 * i + 2] = Bv; }
  }

  /* cache of expensive per-photo pieces */
  const cache = new Map();
  function memo(key, fn) { if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; } const v = fn(); cache.set(key, v); if (cache.size > 60) cache.delete(cache.keys().next().value); return v; }

  /* opts: {src, SW, SH, s, look (look object or null), id, maxLong, brush:{w,h,data}, subj:{w,h,data}, onProgress, full} */
  async function process(o) {
    const s = o.s, [cw, ch] = D.outSize(o.SW, o.SH, s, o.maxLong);
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#000'; x.fillRect(0, 0, cw, ch);
    D.drawGeom(x, o.src, o.SW, o.SH, s, cw, ch);
    const img = x.getImageData(0, 0, cw, ch);
    const rmKey = JSON.stringify((s.removals || []).filter(r => r.on).map(r => r.box)) + (o.rm ? ':' + (o.rm.v || 0) : '');
    const gkey = [o.id.replace(/[spF]$/, ''), s.rot, s.flipH, s.angle, JSON.stringify(s.crop), rmKey].join('|');
    if (applyRemovals(img.data, cw, ch, s, o.rm, gkey)) x.putImageData(img, 0, 0);
    o.onRemoved && o.onRemoved(c);
    const small = memo('small|' + gkey + '|' + (o.full ? 'f' : 'p'), () => D.smallFrom(img.data, cw, ch, MAPLONG));
    const mkey = gkey + '|' + small.w + 'x' + small.h + (o.full ? 'f' : 'p') + (s.people && s.people.length ? ':' + hashStr(JSON.stringify(s.people)) : '');   // masks are per map size: preview and full-size renders must never share them
    const pre = memo('pre|' + gkey + '|' + s.ev + '|' + s.temp + '|' + s.tint + (o.full ? 'f' : 'p'), () => preCorrect(small, s));
    const prep = LC.prepare(pre);
    // look, adapted to this photo when it was taught from finished edits
    let look = null;
    if (o.look) {
      const L = o.look;
      if (L.kind === 'ref') {
        const pick = s.pick != null && s.pick !== 'auto' && L.refs[s.pick] && L.refs[s.pick].px ? s.pick : 'auto';
        const lut = memo(['adapt', o.lookKey, gkey, s.ev, s.temp, s.tint, pick].join('|'), () => LC.guardLUT(pick === 'auto' ? LC.refLUT(L, prep, 0) : LC.otLUT(L, prep, 0, pick, true)));
        look = Object.assign({}, L, { lut });
      } else look = L;
    }
    let lut = D.bake(s, look);
    const sky = (s.skyExp || s.skySat || s.skyTemp) ? memo('sky|' + mkey, () => D.skyMask(small)) : null;
    const brush = o.brush ? resample(o.brush.data, o.brush.w, o.brush.h, small.w, small.h) : null;
    let cr = null, sm = null;
    const needSubj = (s.creative && s.creativeAmt > 0) || !!(s.aiStrokes && s.aiStrokes.length) || !!(s.curve && s.curve.target !== 'whole') || (look && s.lookBg) || s.subjLight > 0 || s.dodgeBurn > 0 || s.skinMatch > 0 || (s.bgEdit ?? 100) < 100 || s.pop > 0 || s.faceLight > 0 || s.studioLight > 0 || s.skinSmooth > 0 || s.beautify > 0 || s.heal > 0 || s.shine > 0 || s.fabric > 0 || s.flyaways > 0 || s.eyes > 0 || s.teeth > 0 || s.bgBlur > 0 || s.bokeh > 0 || !!look;
    if (needSubj) { const paint = o.subj ? resample(o.subj.data instanceof Float32Array ? o.subj.data : Float32Array.from(o.subj.data), o.subj.w, o.subj.h, small.w, small.h) : null; if (s.people && s.people.length) {
        // people located by Claude: exact skin (learned from their own face) and person masks
        const pm = memo('pmk|' + mkey + (o.subj ? ':' + (o.subj.v || 0) : ''), () => D.peopleMasks(small, boxMaps(s.people, s, o.SW, o.SH, small.w, small.h), paint));
        sm = { focus: pm.person, mask: pm.person, frac: pm.frac, pk: { people: pm.skin, tight: pm.skinTight, hair: pm.hair, R: pm.person, person: pm.person }, face: pm.face, facePx: pm.facePx, exact: true };
        // two or more people: each gets their own skin, learned from their own face, so a light-skinned and a deep-skinned person are edited differently
        if (s.people.length > 1) sm.persons = s.people.map((pp, i) => { const q = memo('pmk' + i + '|' + mkey + (o.subj ? ':' + (o.subj.v || 0) : ''), () => D.peopleMasks(small, boxMaps([pp], s, o.SW, o.SH, small.w, small.h), null));
          const Y = q.facePx && q.facePx.length ? (() => { const v = q.facePx.map(j => 0.299 * small.rgb[3 * j] + 0.587 * small.rgb[3 * j + 1] + 0.114 * small.rgb[3 * j + 2]).sort((x, y) => x - y); return Math.max(1e-4, v[(v.length / 2) | 0]); })() : 0;
          return { skin: q.skin, tight: q.skinTight, person: q.person, hair: q.hair, face: q.face, facePx: q.facePx, depth: D.skinDepthOf(small, q.facePx), Y }; }).filter(q => q.facePx && q.facePx.length > 40);
        // in the same light, a lighter complexion reads brighter: people a stop or more darker than the lightest face are deeper-skinned, and the lightest one is not
        // with several people, each person's own skin and hair maps (learned from their own face) replace the shared guess
        if (sm.persons && sm.persons.length > 1) { const U = k => memo('union' + k + '|' + mkey, () => { const o2 = new Float32Array(small.w * small.h); for (const q of sm.persons) { const a = q[k]; if (a) for (let i = 0; i < o2.length; i++) if (a[i] > o2[i]) o2[i] = a[i]; } return o2; });
          sm.pk = Object.assign({}, sm.pk, { people: U('skin'), tight: U('tight'), hair: U('hair') }); }
        if (sm.persons && sm.persons.length > 1) { const Ymax = Math.max(...sm.persons.map(q => q.Y)), Ymin = Math.min(...sm.persons.map(q => q.Y));
          for (const q of sm.persons) { const rel = Math.log2(Ymax / q.Y) / 2.2, spread = Math.log2(Ymax / Ymin); if (spread > 0.9) { if (rel < 0.15) q.depth = Math.min(q.depth, 0.3); else q.depth = Math.max(q.depth, Math.min(1, 0.45 + rel)); } } }
      } else {
      sm = D.subjectMask(small, paint);
      // people stay people: creative scene grades, background-only looks and burning all go around everyone in the frame
      const pk = memo('person|' + mkey + (o.subj ? ':' + (o.subj.v || 0) : ''), () => D.personMask(small, sm)); const tight = memo('ptight|' + mkey + (o.subj ? ':' + (o.subj.v || 0) : ''), () => { const big = Math.max(small.w, small.h), r = D.refine(pk.person, small, 0.012 * big, 0.002), q = new Float32Array(r.length); for (let i = 0; i < r.length; i++) q[i] = Math.min(1, Math.max(0, (r[i] - 0.4) / 0.35)); return LC.blur(q, small.w, small.h, 0.003 * big); });
      sm = Object.assign({}, sm, { focus: sm.mask, mask: tight, pk }); } }
    if (s.creative && s.creativeAmt > 0) {
      const amt = s.creativeAmt / 100, luts = D.creativeLUTs(s.creative, amt);
      cr = Object.assign({ amt, mask: sm.mask, frac: sm.frac }, luts);
    }
    // hand retouching by the AI: its dodge and burn strokes, painted as soft light (kept on the people when they are known)
    let brushAll = brush;
    if (s.aiStrokes && s.aiStrokes.length) { const st = memo('strokes|' + small.w + 'x' + small.h + '|' + hashStr(JSON.stringify(s.aiStrokes)) + '|' + mkey, () => strokeMap(s.aiStrokes, small.w, small.h, sm && (sm.exact || o.subj) ? sm.mask : null));
      brushAll = new Float32Array(small.w * small.h); for (let i = 0; i < brushAll.length; i++) brushAll[i] = (brush ? brush[i] : 0) + st[i]; }
    const mp = D.buildMaps(s, look, small, prep, brushAll, sky, cr);
    // Night rescue: dark photos are brought up the way a retoucher does it, by area and not by one global exposure push.
    // The light of each area (found with an edge-aware filter, so edges don't glow) is lifted in proportion to how dark it is;
    // highlights, lights and bright skies are left where they are, and the detail inside each area is kept.
    // person-only edits need to know where the person really is: found by Claude, or painted with the Subject brush. A colour guess is not good enough.
    const known = !!(sm && (sm.exact || o.subj));
    // Face light: a soft lift on each face, more where the face is dark, less where it is already bright
    if (s.faceLight > 0 && sm && sm.face) { const a = s.faceLight / 100 * 1.0 * Math.LN2, F = sm.face, rgb = small.rgb;
      for (let i = 0; i < mp.logG.length; i++) if (F[i] > 0.01) { const L = 0.299 * rgb[3 * i] + 0.587 * rgb[3 * i + 1] + 0.114 * rgb[3 * i + 2]; mp.logG[i] += a * F[i] * Math.max(0.15, Math.min(1, (0.8 - L) / 0.45)); } }
    // Studio light: a large soft light from one side, on the person, the background, or both
    const stMap = s.studioLight > 0 && s.studioWarm ? new Float32Array(small.w * small.h) : null;
    if (s.studioLight > 0) { const a = s.studioLight / 100 * 1.25 * Math.LN2, w = small.w, h = small.h, dir = s.studioDir || 'top', tgt = s.studioTarget || 'person', M = sm && known ? sm.mask : null;
      let cx = 0.5, cy = 0.4; if (M) { let sx = 0, sy = 0, st = 0; for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) { const m = M[y * w + x]; sx += x * m; sy += y * m; st += m; } if (st) { cx = sx / st / w; cy = sy / st / h; } }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const u = x / w, v = y / h, i = y * w + x;
        const t = dir === 'top' ? 1 - v : dir === 'bottom' ? v : dir === 'left' ? 1 - u : dir === 'right' ? u : dir === 'spot' ? Math.max(0, 1 - Math.hypot(u - (s.studioX ?? 500) / 1000, (v - (s.studioY ?? 300) / 1000) * 0.8) / 0.6) : Math.max(0, 1 - Math.hypot(u - cx, (v - cy) * 0.8) / 0.75);
        const fall = Math.pow(Math.max(0, t), 1.5), m = M ? (tgt === 'person' ? M[i] : tgt === 'background' ? 1 - M[i] : 1) : 1;
        mp.logG[i] += a * fall * m; if (stMap) stMap[i] = a * fall * m; } }
    if (s.dodgeBurn > 0 && sm) { const db = memo('db|' + mkey + (o.subj ? ':' + (o.subj.v || 0) : ''), () => D.dodgeBurnMaps(small, { mask: sm.focus, frac: sm.frac }, sm.pk, s.people && s.people.length ? faceSculpt(s.people, s, o.SW, o.SH, small.w, small.h) : null)), a = s.dodgeBurn / 100 * Math.LN2 * 1.4; for (let i = 0; i < mp.logG.length; i++) mp.logG[i] += a * ((known ? db.dodge[i] : 0) + db.burn[i]); mp.db = db; }
    // clean whites: read the dress / shirt on the people after the edit and take out any tint the light, the white balance or the look left in it
    if (known && s.cleanWhites !== false) { const M = sm.mask, SK = sm.pk.tight || sm.pk.people, wm = new Float32Array(M.length);
      const wk = (s.editStrength || 'balanced') === 'light' ? 0.45 : 1;   /* light touch: the dress keeps the warmth of the scene's light, only a tint is taken out */
      for (let i = 0; i < M.length; i++) wm[i] = M[i] * (1 - Math.min(1, SK[i] * 1.6)) * wk;
      mp.wh = { lut: memo('whiteLUT', () => LC.whiteTune(LC.identityLUT(), 0, 1.5)), mask: wm }; }   /* last step on the people's finished colour: near-whites (dress, shirt, veil) lose any pink, lavender or blue and sit at a clean, slightly warm white; skin, hair and the background are left alone */
    // skin: read this photo's skin after the edit, then bring its colour and brightness to the skin in the look's examples
    const slBase = s.subjLight > 0 ? s.subjLight / 100 * 1.5 : 0;
    /* skin, one person at a time: read their own skin (its type and its own undertone), then bring its colour and brightness to where
       that skin type looks its best. Brightness only goes up if their skin needs it, and comes down if the edit made it too bright. */
    const skinPass = (sk, skinMask, dp, key) => {
      let slA = slBase; const out = { slA, sk: null, info: null };
      if (!(sk && sk.length > (sm.exact ? 40 : small.w * small.h * 0.002))) return out;
      const k = s.skinMatch / 100 * (0.4 + 0.6 * Math.min(1, dp / 0.6)), t = [0, 0, 0], lab = [0, 0, 0], Ls = [], As = [], Bs = [];
      const eg = i => Math.exp(mp.logG[i]); /* face light, studio light and other local light already on the skin count too */
      for (let q = 0; q < sk.length; q++) { const i = sk[q]; LC.lutAt(lut, small.rgb[3 * i], small.rgb[3 * i + 1], small.rgb[3 * i + 2], t, 0); const g0 = eg(i); LC.rgb2lab(Math.min(1, t[0] * g0), Math.min(1, t[1] * g0), Math.min(1, t[2] * g0), lab); Ls.push(lab[0]); As.push(lab[1]); Bs.push(lab[2]); }
      const md = (a, f) => { a.sort((x, y) => x - y); return a[(a.length * f) | 0]; }, cur = { L: md(Ls, 0.45), a: md(As, 0.5), b: md(Bs, 0.5) };
      let ls = o.look ? LC.lookSkin(o.look) : null; if (ls && Math.hypot(ls.a, ls.b) < 14) ls = null;
      // the person's own undertone (as it reads after white balance) is kept; the skin type sets how rich it is; a look only nudges the hue
      const own = dp > 0.6 ? { a: 17, b: 28 } : dp < 0.35 ? { a: 13, b: 17 } : { a: 15, b: 23 }, oC = Math.hypot(own.a, own.b), typeH = Math.atan2(own.b, own.a);
      const curH = Math.atan2(cur.b, cur.a), selfH = Math.max(0.82, Math.min(1.12, curH));
      let tH = selfH + (typeH - selfH) * 0.4; if (ls) { const lH = Math.atan2(ls.b, ls.a); if (lH > 0.7 && lH < 1.15) tH += (lH - tH) * 0.2; }
      const curC = Math.hypot(cur.a, cur.b), typeC = Math.max(oC * 0.95, Math.min(oC * 1.15, ls ? Math.hypot(ls.a, ls.b) : oC));
      // how rich skin can be depends on how bright it is: skin in shadow or night light carries far less colour, so a fixed target turned it orange.
      // Colour is only added a little at a time from what the person really has, never painted on.
      const stC = s.editStrength || 'balanced', lF = Math.max(0.5, Math.min(1, cur.L / 48)), typeCL = typeC * lF, upC = stC === 'light' ? 1.15 : stC === 'bold' ? 1.45 : 1.28;
      const tC = curC > typeCL ? typeCL + (curC - typeCL) * 0.45 : Math.min(typeCL, Math.max(curC, curC * upC));   // very red or orange skin is calmed, not drained
      const tgt = { a: tC * Math.cos(tH), b: tC * Math.sin(tH) };
      const cl = (v, m) => Math.max(-m, Math.min(m, v));
      const rl = (ls ? ls.all : [{ L: 42 }, { L: 50 }, { L: 58 }]).map(x => x.L).filter(v => v > 30 && v < 70).sort((x, y) => x - y);
      let TL = rl.length ? rl[Math.min(rl.length - 1, (rl.length * (dp > 0.6 ? 0.3 : dp < 0.35 ? 0.75 : 0.5)) | 0)] : 50;
      TL = dp > 0.6 ? Math.max(40, Math.min(48, TL)) : dp < 0.35 ? Math.max(56, Math.min(66, TL)) : Math.max(47, Math.min(56, TL));
      // only as much light as the skin needs: a face in night light stays in its light, it is not pulled up to a studio level
      const stE = s.editStrength || 'balanced', upL = stE === 'light' ? (dp > 0.6 ? 4 : 5) : stE === 'bold' ? (dp > 0.6 ? 12 : 15) : (dp > 0.6 ? 7 : dp < 0.35 ? 10 : 9);
      if (cur.L < TL) TL = Math.min(TL, cur.L + upL);
      else if (cur.L < TL + 7) TL = cur.L;   // already close: leave it
      // never brighter than the camera original by more than the chosen strength allows, however exposure, face light and studio light were set:
      // a light-touch edit keeps the person's real light
      { const L0s = []; for (let q = 0; q < sk.length; q += 3) { const i = sk[q]; LC.rgb2lab(small.rgb[3 * i], small.rgb[3 * i + 1], small.rgb[3 * i + 2], lab); L0s.push(lab[0]); }
        const L0 = md(L0s, 0.45), maxUp = (stE === 'light' ? 6 : stE === 'bold' ? 18 : 10); if (TL > L0 + maxUp) TL = L0 + maxUp; }
      const enc = L => { const Y = Math.pow((L + 16) / 116, 3); return Y <= 0.0031308 ? Y * 12.92 : 1.055 * Math.pow(Y, 1 / 2.4) - 0.055; };
      const m1 = enc(cur.L), Tg = enc(TL);
      const hiL = md(Ls, 0.92), room = Math.max(0, Math.min(1, (82 - hiL) / 14));
      if (m1 < Tg - 0.005) slA += k * room * Math.min(3.2, (Tg - m1) / Math.max(1e-3, m1 * (1 - Tg)));
      else if (m1 > Tg + 0.02) slA = Math.min(slA, 0) - Math.min(0.7, Math.max(k, 0.6) * (m1 - Tg) / Math.max(1e-3, m1 * (1 - Tg)) * 0.85);
      const PP = s.pop > 0 ? s.pop / 100 : 0;
      const sim = L2 => { const a2 = [], b2 = []; for (let q = 0; q < sk.length; q += 2) { const i = sk[q]; LC.lutAt(L2, small.rgb[3 * i], small.rgb[3 * i + 1], small.rgb[3 * i + 2], t, 0); { const g0 = eg(i); t[0] *= g0; t[1] *= g0; t[2] *= g0; }
        const Lm = Math.max(1e-4, 0.299 * t[0] + 0.587 * t[1] + 0.114 * t[2]), Lc = Math.min(1, Lm), g = Lc * (1 + slA) / (1 + slA * Lc) / Lm; let r = t[0] * g, gg = t[1] * g, b = t[2] * g;
        if (PP > 0) { const L = Math.max(1e-4, 0.299 * r + 0.587 * gg + 0.114 * b), Lq = Math.min(1, L), pv = 0.3, L2 = Lq < pv ? pv * Math.pow(Lq / pv, 1 + 0.35 * PP) : 1 - (1 - pv) * Math.pow((1 - Lq) / (1 - pv), 1 + 0.6 * PP), sc = L2 / L, st = 1 + 0.32 * PP; r = L2 + (r * sc - L2) * st; gg = L2 + (gg * sc - L2) * st; b = L2 + (b * sc - L2) * st; }
        LC.rgb2lab(Math.min(1, Math.max(0, r)), Math.min(1, Math.max(0, gg)), Math.min(1, Math.max(0, b)), lab); a2.push(lab[1]); b2.push(lab[2]); } return [md(a2, 0.5), md(b2, 0.5)]; };
      const simL = aa => { const keep = slA; slA = aa; const Lv = []; for (let q = 0; q < sk.length; q += 3) { const i = sk[q]; LC.lutAt(lut, small.rgb[3 * i], small.rgb[3 * i + 1], small.rgb[3 * i + 2], t, 0); { const g0 = eg(i); t[0] *= g0; t[1] *= g0; t[2] *= g0; }
          const Lm = Math.max(1e-4, 0.299 * t[0] + 0.587 * t[1] + 0.114 * t[2]), Lc = Math.min(1, Lm), L1 = Lc * (1 + aa) / (1 + aa * Lc), pv = 0.3, L2 = PP > 0 ? (L1 < pv ? pv * Math.pow(L1 / pv, 1 + 0.35 * PP) : 1 - (1 - pv) * Math.pow((1 - L1) / (1 - pv), 1 + 0.6 * PP)) : L1; Lv.push(L2); } slA = keep; return md(Lv, 0.45); };
      // brightness lands on this skin's level after everything (Pop included): pull the light back if it overshoots
      if (simL(slA) > Tg + 0.01) { let lo = -0.6, hi = slA; for (let it = 0; it < 10; it++) { const mid = (lo + hi) / 2; if (simL(mid) > Tg) hi = mid; else lo = mid; } slA = (lo + hi) / 2; }
      else if (slA > 0 && simL(slA) < Tg - 0.03) { let lo = slA, hi = slA + 1.5; for (let it = 0; it < 8; it++) { const mid = (lo + hi) / 2; if (simL(mid) > Tg) hi = mid; else lo = mid; } slA = (lo + hi) / 2; }
      let da = 0, db2 = 0, tuned = lut;
      for (let it = 0; it < 7; it++) { const m = sim(tuned); da = cl(da + (tgt.a - m[0]) * k * 0.45, 14); db2 = cl(db2 + (tgt.b - m[1]) * k * 0.45, 16); tuned = LC.skinTune(lut, cur, da, db2, true); }
      const fin = sim(tuned), finL = simL(slA);
      out.slA = slA; out.sk = { lut: tuned, mask: skinMask, cap: dp > 0.6 ? 0.66 : dp < 0.35 ? 0.5 : 0.58, floor: dp > 0.6 ? 0.46 : dp < 0.35 ? 0.27 : 0.37 };
      out.info = { type: dp > 0.6 ? 'deep' : dp < 0.35 ? 'light' : 'medium', depth: +dp.toFixed(2), was: { L: +cur.L.toFixed(1), a: +cur.a.toFixed(1), b: +cur.b.toFixed(1) }, aim: { L: TL, a: +tgt.a.toFixed(1), b: +tgt.b.toFixed(1) }, got: { a: +fin[0].toFixed(1), b: +fin[1].toFixed(1), L: +(116 * Math.cbrt(Math.pow(finL <= 0.04045 ? finL / 12.92 : Math.pow((finL + 0.055) / 1.055, 2.4), 1)) - 16).toFixed(1) } };
      return out;
    };
    const liftOf = (skinMask, personMask, a, hair) => { const o2 = new Float32Array(skinMask.length);
      for (let i = 0; i < o2.length; i++) { const v = a < 0 || !sm.exact ? skinMask[i] : Math.max(0.8 * skinMask[i], 0.8 * personMask[i]) + 0.2 * skinMask[i]; o2[i] = hair ? v * (1 - 0.8 * hair[i]) : v; } return o2; };   /* hair keeps its own light */
    // all of a person's visible skin (face, shoulders, back, arms), not just the face: a turned-away face or a face in shadow must not decide the light for the whole body
    // hair that is close to skin colour (copper, auburn, blonde) is left out: body skin is only counted below the chin; the face itself comes from the face
    const allSkin = (facePx, tight, tag, face) => memo('allskin|' + tag + '|' + mkey, () => { const out = facePx ? facePx.slice() : []; if (tight) { const w = small.w; let yb = -1;
        if (face) for (let i = 0; i < face.length; i++) if (face[i] > 0.3) yb = Math.max(yb, (i / w) | 0);
        const ok = i => tight[i] > 0.7 && (yb < 0 || ((i / w) | 0) > yb);
        let c = 0; for (let i = 0; i < tight.length; i += 2) if (ok(i)) c++; const step = Math.max(2, Math.round(c / 6000) * 2); for (let i = 0; i < tight.length; i += step) if (ok(i)) out.push(i); } return out; });
    const noHair = (m, hair, tag) => !hair ? m : memo('nohair|' + tag + '|' + mkey, () => { const o2 = new Float32Array(m.length); for (let i = 0; i < m.length; i++) o2[i] = m[i] * (1 - 0.85 * hair[i]); return o2; });
    let slA = slBase; const skinInfo = [];
    if (known && s.skinMatch > 0) {
      if (sm.persons && sm.persons.length > 1) {
        const skl = [], sll = [];
        sm.persons.forEach((q, i) => { const r = skinPass(q.facePx && q.facePx.length > 40 ? q.facePx : allSkin(q.facePx, q.tight, 'p' + i, q.face), noHair(q.skin, q.hair, 'p' + i), q.depth, i); if (r.sk) skl.push(r.sk); if (r.info) skinInfo.push(r.info); if (r.slA !== 0) sll.push({ mask: memo('lift' + i + (r.slA < 0 ? 'n' : 'p') + '|' + mkey, () => liftOf(q.skin, q.person, r.slA, q.hair)), a: r.slA }); });
        if (skl.length) mp.skList = skl; if (sll.length) mp.slList = sll; slA = 0;
      } else {
        const sk = memo('skin|' + mkey, () => sm.facePx && sm.facePx.length > 40 ? sm.facePx : D.faceSkin(small, { mask: sm.focus }));
        const r = skinPass(sk, noHair(sm.pk.people, sm.pk.hair, 's'), s.skinDepth ?? 0.5, 0); slA = r.slA; if (r.sk) mp.sk = r.sk; if (r.info) skinInfo.push(r.info);
      }
    }
    if (s.pop > 0) mp.pp = { mask: known ? sm.mask : null, a: s.pop / 100 * (known ? 1 : 0.6) };
    // light the whole person (dress, suit, hair) about as much as their skin, so the face doesn't look spot-lit and whites come up clean
    if (slA !== 0 && known && !mp.slList) mp.sl = { mask: memo('lift' + (slA < 0 ? 'n' : 'p') + '|' + mkey + (o.subj ? ':' + (o.subj.v || 0) : ''), () => liftOf(sm.pk.people, sm.mask, slA, sm.pk.hair)), a: slA };
    // look on the background only: the subject gets a light version so skin and dress stay natural
    if (look && s.lookBg) { mp.sp = { lut: D.bake(Object.assign({}, s, { lookAmt: (s.lookAmt ?? 100) * 0.3 }), look), mask: sm.mask }; }
    const cb = D.clarityBase(lut, mp, small);
    if (cr) { cr.bloom = cr.P.bloom ? D.bloomMap(lut, small, mp, cr.P.bloomTint || [1, 1, 1]) : null; cr.part = D.particles(cr.P.particles, cw, ch, hashStr(o.id || 'x'), cr.amt); }
    const bgE = (s.bgEdit ?? 100) / 100, orig = bgE < 1 && sm && (sm.exact || o.subj || s.subjectOnly) ? new Uint8ClampedArray(img.data) : null;   /* 'subject only' with nobody found exactly still protects the background, using the best-guess outline */
    const gscale = o.full ? 1 : Math.min(1, cw / (o.fullW || cw));
    const CH = o.full ? Math.max(16, Math.floor(1.5e6 / cw)) : ch;
    for (let y = 0; y < ch; y += CH) { D.render(s, look, lut, mp, cb, img.data, cw, ch, y, Math.min(ch, y + CH), gscale, cr); if (o.full) { o.onProgress && o.onProgress(Math.min(1, (y + CH) / ch) * 0.9); await tick(); } }
    const before = o.wantBefore ? (() => { const b = document.createElement('canvas'); b.width = cw; b.height = ch; b.getContext('2d').drawImage(c, 0, 0); return b; })() : null;
    // noise is measured in the photo itself, so noise reduction is as strong as this photo needs; sharpening then only touches real edges, never the grain
    const nsc = o.full ? 1 : Math.min(1, cw / (o.fullW || cw));
    // the rescue light goes on after the colour work: brightness comes up fully, colour only partly, so lifted shadows look lit, not orange or neon
    // the studio light's colour: warm (tungsten, sunset) or cool (window, moonlight), only where that light falls
    if (stMap) { const mw = small.w, mh = small.h, d = img.data, wv = s.studioWarm / 100;
      for (let y = 0; y < ch; y++) { const fy = Math.min(mh - 1.001, Math.max(0, (y + 0.5) * mh / ch - 0.5)), y0 = fy | 0, uy = fy - y0;
        for (let x = 0; x < cw; x++) { const fx = Math.min(mw - 1.001, Math.max(0, (x + 0.5) * mw / cw - 0.5)), x0 = fx | 0, ux = fx - x0, i = y0 * mw + x0;
          const k = (stMap[i] * (1 - ux) + stMap[i + 1] * ux) * (1 - uy) + (stMap[i + mw] * (1 - ux) + stMap[i + mw + 1] * ux) * uy; if (k < 0.005) continue; const t = wv * Math.min(1, k * 1.2), p = 4 * (y * cw + x);
          d[p] *= 1 + 0.3 * t; d[p + 1] *= 1 + 0.06 * t; d[p + 2] *= 1 - 0.32 * t; } } }
    if (s.rescue > 0) { const d = img.data, amt = s.rescue / 100, sc = Math.min(1, 640 / Math.max(cw, ch)), mw = Math.max(8, Math.round(cw * sc)), mh = Math.max(8, Math.round(ch * sc)), n = mw * mh, lg = new Float32Array(n);
      // measured on the photo as edited so far, so a face that is already bright is never pushed further
      for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) { const q = 4 * (Math.min(ch - 1, ((y + 0.5) / sc) | 0) * cw + Math.min(cw - 1, ((x + 0.5) / sc) | 0)); lg[y * mw + x] = Math.log(Math.max(0.004, (0.299 * d[q] + 0.587 * d[q + 1] + 0.114 * d[q + 2]) / 255)); }
      const r = Math.max(3, 0.02 * Math.max(mw, mh)), eps = 0.05, L2 = new Float32Array(n); for (let i = 0; i < n; i++) L2[i] = lg[i] * lg[i];
      const m1 = LC.blur(lg, mw, mh, r), m2 = LC.blur(L2, mw, mh, r), A = new Float32Array(n), B = new Float32Array(n);
      for (let i = 0; i < n; i++) { const v = Math.max(0, m2[i] - m1[i] * m1[i]), a = v / (v + eps); A[i] = a; B[i] = m1[i] * (1 - a); }
      // the filter's coefficients are carried up to full size and applied to each pixel's own brightness, so the light follows every edge exactly (no halos)
      const mA = LC.blur(A, mw, mh, r), mB = LC.blur(B, mw, mh, r), pw = 1 / (1 + 1.2 * amt), LG3 = Math.log(3.2);
      for (let y = 0; y < ch; y++) { const fy = Math.min(mh - 1.001, Math.max(0, (y + 0.5) * sc - 0.5)), y0 = fy | 0, uy = fy - y0;
        for (let x = 0; x < cw; x++) { const fx = Math.min(mw - 1.001, Math.max(0, (x + 0.5) * sc - 0.5)), x0 = fx | 0, ux = fx - x0, i = y0 * mw + x0;
          const a = (mA[i] * (1 - ux) + mA[i + 1] * ux) * (1 - uy) + (mA[i + mw] * (1 - ux) + mA[i + mw + 1] * ux) * uy, bb = (mB[i] * (1 - ux) + mB[i + 1] * ux) * (1 - uy) + (mB[i + mw] * (1 - ux) + mB[i + mw + 1] * ux) * uy;
          const p = 4 * (y * cw + x), Y = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2], base = Math.exp(a * Math.log(Math.max(0.004, Y / 255)) + bb), wHi = Math.max(0, Math.min(1, (0.7 - base) / 0.4));
          const lg = Math.min(LG3, Math.max(0, (pw - 1) * Math.log(base))) * wHi; if (lg < 0.004) continue;
          const g = Math.exp(lg), cg = Math.exp(lg * 0.8), Y2 = Y * g;
          for (let c = 0; c < 3; c++) d[p + c] = Y2 + (d[p + c] - Y) * cg; } } }
    const nzA = Math.min(1, (s.noise || 0) / 100 + 0.4 * (s.rescue || 0) / 100);   /* lifted shadows carry more grain */
    if (nzA > 0) { denoise(img.data, cw, ch, nzA, nsc); if (orig) denoise(orig, cw, ch, nzA, nsc); }   /* grain is cleaned everywhere, the background too: 'subject only' keeps its colour and light, not its noise */
    if (s.sharpen > 0) { const pre = known ? new Uint8ClampedArray(img.data) : null; D.sharpen(img.data, cw, ch, o.full ? s.sharpen : s.sharpen * 0.6, Math.max(1.5, 3 * noiseSigma(img.data, cw, ch)));
      if (pre) { /* people are never sharpened: no crunchy skin, no halo where hair meets the background */ const M = LC.blur(sm.mask, small.w, small.h, 0.01 * Math.max(small.w, small.h)), mw = small.w, mh = small.h, d = img.data;
        for (let y = 0; y < ch; y++) { const my = Math.min(mh - 1, (y * mh / ch) | 0); for (let x = 0; x < cw; x++) { const m = Math.min(1, M[my * mw + Math.min(mw - 1, (x * mw / cw) | 0)] * 1.5); if (m < 0.01) continue; const p = 4 * (y * cw + x); for (let c = 0; c < 3; c++) d[p + c] += (pre[p + c] - d[p + c]) * m; } } } }
    const bt = (s.beautify || 0) / 100;
    if ((s.skinSmooth > 0 || bt > 0) && known) {
      const skm = memo('skm|' + mkey, () => { if (sm.exact) return sm.pk.tight; const { S } = D.skinMap(small, { mask: sm.focus }), b = LC.blur(S, small.w, small.h, 0.004 * Math.max(small.w, small.h)); for (let i = 0; i < b.length; i++) b[i] = Math.min(1, b[i] * 1.3); return b; });
      // Beautify adds even, pore-keeping skin on top of the Skin smoothing slider
      const evenA = Math.min(0.9, s.skinSmooth / 100 * 0.75 + 0.65 * bt), smA = Math.min(1, s.skinSmooth / 100 * 1.1 + 0.4 * bt);
      if (sm.exact) evenSkin(img.data, cw, ch, LC.blur(sm.pk.people, small.w, small.h, 0.006 * Math.max(small.w, small.h)), small.w, small.h, evenA);
      if (smA > 0) smoothSkin(img.data, cw, ch, skm, small.w, small.h, smA, sm.face || (sm.pk && sm.pk.face) || null);
    }
    if (s.fabric > 0 && known) { const P = sm.mask, T = sm.pk.tight || sm.pk.people, H = sm.pk.hair, FM = new Float32Array(P.length);
      for (let i = 0; i < FM.length; i++) FM[i] = Math.max(0, Math.min(1, P[i] * 1.2) - Math.min(1, T[i] * 2) - (H ? Math.min(1, H[i] * 2) : 0));
      fabricSmooth(img.data, cw, ch, LC.blur(FM, small.w, small.h, 0.003 * Math.max(small.w, small.h)), small.w, small.h, s.fabric / 100); }
    if (s.flyaways > 0 && known) hairTidy(img.data, cw, ch, sm.mask, small.w, small.h, s.flyaways / 100);
    if ((s.heal > 0 || s.shine > 0) && known && sm.face) { const FM = sm.face, T = sm.pk.tight || sm.pk.people, HM = new Float32Array(FM.length); for (let i = 0; i < HM.length; i++) HM[i] = Math.min(1, FM[i] * 1.4) * Math.min(1, T[i] * 1.3);
      healSkin(img.data, cw, ch, LC.blur(HM, small.w, small.h, 0.003 * Math.max(small.w, small.h)), small.w, small.h, (s.heal || 0) / 100, (s.shine || 0) / 100); }
    const eyA = (s.eyes || 0) / 100, thA = (s.teeth || 0) / 100;
    if ((bt > 0 || eyA > 0 || thA > 0) && known) { const F = s.people && s.people.length ? memo('feat|' + mkey + '|' + cw, () => faceFeatures(s.people, s, o.SW, o.SH, Math.min(cw, 1400), Math.round(Math.min(cw, 1400) * ch / cw))) : null;
      beautify(img.data, cw, ch, F, LC.blur(sm.pk.people, small.w, small.h, 0.004 * Math.max(small.w, small.h)), small.w, small.h, bt, eyA, thA);
      if (bt > 0) define(img.data, cw, ch, sm.mask, sm.pk.hair || null, small.w, small.h, bt, 4 * noiseSigma(img.data, cw, ch), sm.pk.tight || null); }
    if (s.bgBlur > 0 && known) bgBlur(img.data, cw, ch, sm.mask, small.w, small.h, s.bgBlur / 100);
    if (s.bokeh > 0 && known) bokehLights(img.data, cw, ch, sm.mask, small.w, small.h, s.bokeh / 100, hashStr((o.id || 'x').replace(/[spF]$/, '')));
    // noise reduction and sharpening happen before the background is put back, so 'subject only' leaves the background exactly as shot
    // person-only editing: outside the people, fade the edit back toward the untouched photo
    if (orig) {
      const pm = memo('bgfeather|' + mkey, () => LC.blur(sm.mask, small.w, small.h, 0.005 * Math.max(small.w, small.h)));   /* a soft edge, so the person never looks cut out and pasted onto the original background */
      const mw = small.w, mh = small.h, d = img.data;
      for (let y = 0; y < ch; y++) { const fy = Math.min(mh - 1.001, Math.max(0, (y + 0.5) * mh / ch - 0.5)), y0 = fy | 0, uy = fy - y0;
        for (let xx = 0; xx < cw; xx++) { const fx = Math.min(mw - 1.001, Math.max(0, (xx + 0.5) * mw / cw - 0.5)), x0 = fx | 0, ux = fx - x0, i = y0 * mw + x0;
          const m = (pm[i] * (1 - ux) + pm[i + 1] * ux) * (1 - uy) + (pm[i + mw] * (1 - ux) + pm[i + mw + 1] * ux) * uy, k = m + (1 - m) * bgE; if (k > 0.995) continue;
          const p = 4 * (y * cw + xx); d[p] = orig[p] + (d[p] - orig[p]) * k; d[p + 1] = orig[p + 1] + (d[p + 1] - orig[p + 1]) * k; d[p + 2] = orig[p + 2] + (d[p + 2] - orig[p + 2]) * k; } }
    }
    // (after the background is put back, so a curve meant for the background or the whole photo really reaches it)
    // Curve layer with a mask (like Photoshop): applied to each colour channel, on the people, the background, or everything
    if (s.glow > 0) glowFx(img.data, cw, ch, s.glow / 100);
    if (s.flare > 0) flareFx(img.data, cw, ch, s.flare / 100, (s.flareX ?? 850) / 1000, (s.flareY ?? 120) / 1000, s.flareWarm ?? 60);
    if (s.curve && Array.isArray(s.curve.pts)) { const f = D.curveFn(s.curve.pts), T = new Uint8ClampedArray(256); for (let k = 0; k < 256; k++) T[k] = Math.round(f[k] * 255);
      const tg = s.curve.target || 'subject', M = tg === 'whole' || !sm ? null : sm.mask, mw = small.w, mh = small.h, d = img.data;
      for (let y = 0; y < ch; y++) { const fy = Math.min(mh - 1.001, Math.max(0, (y + 0.5) * mh / ch - 0.5)), y0 = fy | 0, uy = fy - y0;
        for (let xx = 0; xx < cw; xx++) { const p4 = 4 * (y * cw + xx); let k = 1;
          if (M) { const fx = Math.min(mw - 1.001, Math.max(0, (xx + 0.5) * mw / cw - 0.5)), x0 = fx | 0, ux = fx - x0, i = y0 * mw + x0, m = (M[i] * (1 - ux) + M[i + 1] * ux) * (1 - uy) + (M[i + mw] * (1 - ux) + M[i + mw + 1] * ux) * uy; k = tg === 'background' ? 1 - m : m; if (k < 0.01) continue; }
          d[p4] += (T[d[p4]] - d[p4]) * k; d[p4 + 1] += (T[d[p4 + 1]] - d[p4 + 1]) * k; d[p4 + 2] += (T[d[p4 + 2]] - d[p4 + 2]) * k; } } }
    x.putImageData(img, 0, 0);
    return { canvas: c, small, cr, sky, sm, db: mp.db || null, skin: skinInfo, w: cw, h: ch };
  }
  /* AI dodge & burn strokes -> log-light map. A stroke: {mode: 'dodge'|'burn', pts: [[x, y], ...] (0-1000 of width and height), size (0-1000 of width), strength 0-100}.
     Each stroke lays down a soft, feathered band along its path; within one stroke the light doesn't build up where the path crosses itself. */
  function strokeMap(strokes, w, h, person) {
    const out = new Float32Array(w * h), one = new Float32Array(w * h);
    for (const st of strokes) { if (!st || !Array.isArray(st.pts) || !st.pts.length) continue;
      one.fill(0); const R = Math.max(1.2, (+st.size || 40) / 1000 * w), pts = st.pts.map(q => [q[0] / 1000 * w, q[1] / 1000 * h]), amt = Math.max(0, Math.min(100, +st.strength || 0)) / 100 * 0.75 * Math.LN2 * (st.mode === 'burn' ? -1 : 1);
      const dab = (cx, cy) => { const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(w - 1, Math.ceil(cx + R)), y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(h - 1, Math.ceil(cy + R));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (R * R); if (d2 >= 1) continue; const f = Math.exp(-2.6 * d2) * (1 - d2 * d2), i = y * w + x; if (f > one[i]) one[i] = f; } };
      if (pts.length === 1) dab(pts[0][0], pts[0][1]);
      for (let k = 1; k < pts.length; k++) { const [ax, ay] = pts[k - 1], [bx, by] = pts[k], L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(L / (R * 0.3))); for (let j = 0; j <= n; j++) dab(ax + (bx - ax) * j / n, ay + (by - ay) * j / n); }
      for (let i = 0; i < out.length; i++) if (one[i] > 0) out[i] += amt * one[i] * (person ? 0.1 + 0.9 * Math.min(1, person[i] * 1.2) : 1);
    }
    for (let i = 0; i < out.length; i++) out[i] = Math.max(-1.2, Math.min(1.2, out[i]));
    return LC.blur(out, w, h, 0.004 * Math.max(w, h));
  }
  function hashStr(t) { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  return { process, resample, boxMaps, faceSculpt, MAPLONG, clear: () => cache.clear() };
})();
window.Pipe = Pipe;
