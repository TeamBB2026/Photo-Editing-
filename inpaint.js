/* ===================== Content-aware fill (multi-scale PatchMatch, Wexler-style) ===================== */
const Inpaint = (() => {
  const R = 3, PS = 2 * R + 1; // 7x7 patches

  function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function down(img, mask, w, h) {
    const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1), o = new Float32Array(w2 * h2 * 3), m = new Uint8Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      let r = 0, g = 0, b = 0, c = 0, hole = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const xx = Math.min(w - 1, 2 * x + dx), yy = Math.min(h - 1, 2 * y + dy), i = yy * w + xx; if (mask[i]) { hole++; continue; } r += img[3 * i]; g += img[3 * i + 1]; b += img[3 * i + 2]; c++; }
      const j = y * w2 + x; m[j] = hole > 0 ? 1 : 0; if (c) { o[3 * j] = r / c; o[3 * j + 1] = g / c; o[3 * j + 2] = b / c; }
    }
    return { img: o, mask: m, w: w2, h: h2 };
  }
  /* rough fill by repeated averaging from the hole's edge */
  function diffuse(img, mask, w, h) {
    const known = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) known[i] = mask[i] ? 0 : 1;
    let left = 0; for (let i = 0; i < w * h; i++) if (!known[i]) left++;
    let guard = 0;
    while (left > 0 && guard++ < w + h) {
      const add = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; if (known[i]) continue; let r = 0, g = 0, b = 0, c = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const j = yy * w + xx; if (!known[j]) continue; r += img[3 * j]; g += img[3 * j + 1]; b += img[3 * j + 2]; c++; }
        if (c) add.push([i, r / c, g / c, b / c]);
      }
      for (const [i, r, g, b] of add) { img[3 * i] = r; img[3 * i + 1] = g; img[3 * i + 2] = b; known[i] = 1; left--; }
      if (!add.length) break;
    }
  }
  /* one scale: EM iterations of PatchMatch + voting; img holes already hold an initial guess */
  function solve(img, mask, w, h, iters, rand) {
    // valid source centres: whole patch inside the image and outside the hole
    const valid = new Uint8Array(w * h), dil = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (!mask[y * w + x]) continue; for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) dil[yy * w + xx] = 1; } }
    const vlist = [];
    for (let y = R; y < h - R; y++) for (let x = R; x < w - R; x++) { const i = y * w + x; if (!dil[i]) { valid[i] = 1; vlist.push(i); } }
    if (vlist.length < 8) return;
    // targets: patch centres whose patch touches the hole
    const tgt = []; for (let i = 0; i < w * h; i++) if (dil[i]) tgt.push(i);
    const nnf = new Int32Array(w * h).fill(-1), cost = new Float32Array(w * h);
    const dist = (t, s, best) => {
      const tx = t % w, ty = (t / w) | 0, sx = s % w, sy = (s / w) | 0; let d = 0, n = 0;
      for (let dy = -R; dy <= R; dy++) {
        const ty2 = ty + dy; if (ty2 < 0 || ty2 >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const tx2 = tx + dx; if (tx2 < 0 || tx2 >= w) continue;
          const a = 3 * (ty2 * w + tx2), b = 3 * ((sy + dy) * w + sx + dx);
          const e0 = img[a] - img[b], e1 = img[a + 1] - img[b + 1], e2 = img[a + 2] - img[b + 2];
          d += e0 * e0 + e1 * e1 + e2 * e2; n++;
        }
        if (d / n > best) return Infinity;
      }
      return d / Math.max(1, n);
    };
    for (const t of tgt) { const s = vlist[(rand() * vlist.length) | 0]; nnf[t] = s; cost[t] = dist(t, s, Infinity); }
    const acc = new Float32Array(w * h * 4);
    for (let it = 0; it < iters; it++) {
      // PatchMatch: propagation + random search, alternating scan direction
      for (let pass = 0; pass < 2; pass++) {
        const fwd = (pass + it) % 2 === 0, list = fwd ? tgt : tgt.slice().reverse(), dir = fwd ? -1 : 1;
        for (const t of list) {
          const tx = t % w, ty = (t / w) | 0;
          for (const [nx, ny] of [[tx + dir, ty], [tx, ty + dir]]) {
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const nb = nnf[ny * w + nx]; if (nb < 0) continue;
            const cx = (nb % w) - dir * (nx !== tx ? 1 : 0), cy = ((nb / w) | 0) - dir * (ny !== ty ? 1 : 0);
            if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue; const c = cy * w + cx; if (!valid[c] || c === nnf[t]) continue;
            const d = dist(t, c, cost[t]); if (d < cost[t]) { cost[t] = d; nnf[t] = c; }
          }
          let rad = Math.max(w, h); const bx = nnf[t] % w, by = (nnf[t] / w) | 0;
          while (rad >= 1) {
            const cx = Math.round(bx + (rand() * 2 - 1) * rad), cy = Math.round(by + (rand() * 2 - 1) * rad);
            if (cx >= R && cy >= R && cx < w - R && cy < h - R) { const c = cy * w + cx; if (valid[c]) { const d = dist(t, c, cost[t]); if (d < cost[t]) { cost[t] = d; nnf[t] = c; } } }
            rad >>= 1;
          }
        }
      }
      // voting: every hole pixel = weighted mean of the source pixels its covering patches propose
      acc.fill(0);
      for (const t of tgt) {
        const s = nnf[t], tx = t % w, ty = (t / w) | 0, sx = s % w, sy = (s / w) | 0, wt = Math.exp(-cost[t] / 0.004);
        for (let dy = -R; dy <= R; dy++) { const ty2 = ty + dy; if (ty2 < 0 || ty2 >= h) continue; for (let dx = -R; dx <= R; dx++) { const tx2 = tx + dx; if (tx2 < 0 || tx2 >= w) continue; const p = ty2 * w + tx2; if (!mask[p]) continue; const q = 3 * ((sy + dy) * w + sx + dx); acc[4 * p] += img[q] * wt; acc[4 * p + 1] += img[q + 1] * wt; acc[4 * p + 2] += img[q + 2] * wt; acc[4 * p + 3] += wt; } }
      }
      for (let p = 0; p < w * h; p++) if (mask[p] && acc[4 * p + 3] > 0) { const k = 1 / acc[4 * p + 3]; img[3 * p] = acc[4 * p] * k; img[3 * p + 1] = acc[4 * p + 1] * k; img[3 * p + 2] = acc[4 * p + 2] * k; }
      for (const t of tgt) cost[t] = dist(t, nnf[t], Infinity);
    }
  }
  function upsampleInto(dst, mask, w, h, src, w2, h2) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (!mask[i]) continue; const sx = Math.min(w2 - 1, x >> 1), sy = Math.min(h2 - 1, y >> 1), j = 3 * (sy * w2 + sx); dst[3 * i] = src[j]; dst[3 * i + 1] = src[j + 1]; dst[3 * i + 2] = src[j + 2]; }
  }
  /* fill: img Float32 rgb (w*h*3, 0..1), mask Uint8 (1 = remove). Returns filled img (in place). */
  function fill(img, mask, w, h, seed) {
    const rand = rng(seed || 7);
    const pyr = [{ img, mask, w, h }];
    while (pyr.length < 7) { const t = pyr[pyr.length - 1]; if (Math.max(t.w, t.h) < 40) break; let holes = 0; for (const v of t.mask) holes += v; if (holes < 12) break; pyr.push(down(t.img, t.mask, t.w, t.h)); }
    const top = pyr[pyr.length - 1]; diffuse(top.img, top.mask, top.w, top.h);
    for (let l = pyr.length - 1; l >= 0; l--) {
      const L = pyr[l];
      if (l < pyr.length - 1) { const U = pyr[l + 1]; upsampleInto(L.img, L.mask, L.w, L.h, U.img, U.w, U.h); }
      solve(L.img, L.mask, L.w, L.h, l === 0 ? 3 : l >= pyr.length - 2 ? 8 : 5, rand);
    }
    return img;
  }
  return { fill };
})();
window.Inpaint = Inpaint;
