/* ===================== Look Match Studio ===================== */
(() => {
  const LC = window.LookCore, D = window.Dev, P = window.Pipe;
  const $ = id => document.getElementById(id);
  const tick = () => new Promise(r => setTimeout(r, 0));
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k]; if (v == null || v === false) continue;
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e[k] = v; else if (k === 'style') e.style.cssText = v; else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  }
  const clone = o => JSON.parse(JSON.stringify(o));
  let uid = 0; const nid = () => Date.now().toString(36) + (uid++).toString(36);
  const slug = s => (s || 'look').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 50) || 'look';
  function toast(t, ms) { const e = $('toast'); e.textContent = t; e.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => e.hidden = true, ms || 3200); }

  /* ---------------- state ---------------- */
  const S = {
    photos: [], byId: new Map(), order: 0,
    sel: new Set(), active: null, anchor: null,
    mod: 'develop', filter: 'all', sort: 'time', cell: 170,
    looks: [], db: null, dl: null, sample: null,
    clip: null, compare: 'split', split: 0.5, tool: 'none',
    brushSize: 10, brushFlow: 35, hslTab: 0, busy: null,
  };
  const SAMPLE_ID = 'sample';
  S.looks = [{ id: SAMPLE_ID, name: 'Teal & amber', created: 0, look: LC.sampleLook(), sample: true }];
  const photo = id => S.byId.get(id);
  const activePhoto = () => photo(S.active);
  const lookById = id => S.looks.find(l => l.id === id);

  /* ---------------- persistence: edits + flags per file (IndexedDB) ---------------- */
  const IDB = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => { try { const r = indexedDB.open('lookmatch-studio', 1); r.onupgradeneeded = () => r.result.createObjectStore('photos'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }));
    const tx = async (mode, fn) => { try { const db = await open(); return await new Promise((res, rej) => { const t = db.transaction('photos', mode), st = t.objectStore('photos'), r = fn(st); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); } catch (e) { return null; } };
    return { get: k => tx('readonly', st => st.get(k)), put: (k, v) => tx('readwrite', st => st.put(v, k)) };
  })();
  const saveT = new Map();
  function persist(p) {
    clearTimeout(saveT.get(p.id));
    saveT.set(p.id, setTimeout(() => IDB.put(p.key, { s: p.s, pick: p.pick, rating: p.rating, eyes: p.eyes, brush: p.brush, subj: p.subj, rm: p.rm, agentNote: p.agentNote || null, aiSnap: p.aiSnap || null, at: Date.now() }), 400));
  }

  /* ---------------- capabilities ---------------- */
  async function initCaps() {
    let db = null, dl = null, sm = null, as = null;
    try { if (window.claude && claude.use) [db, dl, sm, as] = await Promise.all([claude.use('db'), claude.use('downloads'), claude.use('sample'), claude.use('assets')]); } catch (e) { }
    S.db = db; S.dl = dl; S.sample = sm; S.assets = as;
    if (db) { try { db.collection('prefs').doc('style').onSnapshot(d => { const v = d && d.exists !== false && d.data ? d.data() : null; if (v && v.n) { S.style = v; lsSet('lookmatch.style', JSON.stringify(v)); } }, () => { }); } catch (e) { } }
    if (db) { try { db.collection('prefs').doc('lessons').onSnapshot(d => { const v = d && d.exists !== false && d.data ? d.data() : null; if (v && v.keys) { S.lessons = v; renderRight(); } }, () => { }); } catch (e) { } }
    if (db) db.collection('looks').onSnapshot(snap => ingestLooks(snap.docs.map(d => Object.assign({ id: d.id }, d.data()))), () => toast('Saved looks could not load.'));
    else ingestLooks(lsLooks());
    render();
  }
  const LS = 'lookmatch.looks.v1';
  function lsLooks() { try { return JSON.parse(localStorage.getItem(LS) || '[]'); } catch (e) { return []; } }
  function lsWrite(a) { try { localStorage.setItem(LS, JSON.stringify(a)); return true; } catch (e) { return false; } }
  function ingestLooks(docs) {
    const list = [];
    for (const d of docs) { try { const prev = lookById(d.id); list.push({ id: d.id, name: d.name || 'Untitled look', created: d.created || 0, creative: !!d.creative, look: LC.deserialize(d), doc: d, rev: (prev ? (prev.rev || 0) : 0) + 1 }); } catch (e) { } }
    list.sort((a, b) => b.created - a.created);
    S.looks = list.concat(S.looks.filter(l => l.sample));
    renderLeft(); if (S.mod === 'develop') scheduleRender('final');
  }
  async function saveLook(doc) {
    if (S.db) return S.db.collection('looks').doc(doc.id).set(doc);
    const a = lsLooks().filter(d => d.id !== doc.id); a.push(doc); if (!lsWrite(a)) throw new Error('Browser storage is full, so this look was not saved.'); ingestLooks(a);
  }
  async function deleteLook(id) { if (S.db) return S.db.collection('looks').doc(id).delete(); const a = lsLooks().filter(d => d.id !== id); lsWrite(a); ingestLooks(a); }
  async function offerFile(filename, data) {
    if (S.dl) { try { await S.dl.save({ filename, data }); return true; } catch (e) { if (e && e.code === 'declined') return false; throw new Error(e && e.message ? e.message : 'The download could not start.'); } }
    const blob = data instanceof Blob ? data : new Blob([data]); const a = el('a', { href: URL.createObjectURL(blob), download: filename }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 8000); return true;
  }

  /* ---------------- decoding (JPEG/PNG/WebP + RAW via embedded full-size preview) ---------------- */
  const RAW_RE = /\.(cr2|cr3|crw|nef|nrw|arw|srf|sr2|dng|raf|orf|rw2|pef|srw|3fr|iiq|erf|kdc|mrw|x3f)$/i;
  const IMG_RE = /\.(jpe?g|png|webp|heic|heif|tiff?|avif|gif|bmp)$/i;
  function tiffOrient(dv, base) { try { const le = dv.getUint16(base) === 0x4949, g16 = o => dv.getUint16(base + o, le), g32 = o => dv.getUint32(base + o, le); const ifd = g32(4), n = g16(ifd); if (n > 400) return 1; for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (g16(e) === 0x0112) return g16(e + 8) || 1; } } catch (e) { } return 1; }
  function jpegOrient(u8) { let i = 2; const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); while (i + 8 < u8.length && u8[i] === 0xFF) { const m = u8[i + 1], len = dv.getUint16(i + 2); if (m === 0xE1 && u8[i + 4] === 0x45 && u8[i + 5] === 0x78) return tiffOrient(dv, i + 10); if (m === 0xDA) break; i += 2 + len; } return 0; }
  // ISO from a JPEG's EXIF (tag 0x8827), so noise reduction can be set automatically
  function isoFromExif(u8) { try { for (let i = 0; i < Math.min(u8.length - 12, 200000); i++) { if (u8[i] === 0x45 && u8[i + 1] === 0x78 && u8[i + 2] === 0x69 && u8[i + 3] === 0x66 && u8[i + 4] === 0 && u8[i + 5] === 0) { const b = i + 6, dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), le = dv.getUint16(b) === 0x4949, g16 = o => dv.getUint16(b + o, le), g32 = o => dv.getUint32(b + o, le);
      const scan = ifd => { const n0 = g16(ifd); for (let k = 0; k < n0; k++) { const e = ifd + 2 + k * 12, t = g16(e); if (t === 0x8827) return g16(e + 8); if (t === 0x8769) { const r = scan(g32(e + 8)); if (r) return r; } } return 0; };
      return scan(g32(4)) || null; } } } catch (e) { } return null; }
  async function decodeRaw(file) {
    const buf = await file.arrayBuffer(), u8 = new Uint8Array(buf), dv = new DataView(buf);
    let orient = 1;
    if ((u8[0] === 0x49 && u8[1] === 0x49) || (u8[0] === 0x4D && u8[1] === 0x4D)) orient = tiffOrient(dv, 0);
    else for (let i = 0; i < Math.min(u8.length - 8, 200000); i++) if (u8[i] === 0x43 && u8[i + 1] === 0x4D && u8[i + 2] === 0x54 && u8[i + 3] === 0x31) { orient = tiffOrient(dv, i + 4); break; }
    const starts = []; for (let i = 0; i < u8.length - 3; i++) if (u8[i] === 0xFF && u8[i + 1] === 0xD8 && u8[i + 2] === 0xFF) { starts.push(i); i += 3; }
    const segs = starts.map((st, k) => [st, (k + 1 < starts.length ? starts[k + 1] : u8.length) - st]).sort((a, b) => b[1] - a[1]).slice(0, 6);
    let best = null, bestPx = 0, seg = null;
    for (const [st, len] of segs) { try { const b = await createImageBitmap(new Blob([u8.subarray(st, st + len)], { type: 'image/jpeg' })); const px = b.width * b.height; if (px > bestPx) { if (best) best.close(); best = b; bestPx = px; seg = u8.subarray(st, Math.min(st + len, st + 300000)); } else b.close(); } catch (e) { } }
    if (!best || Math.max(best.width, best.height) < 1000) throw new Error(`${file.name}: no full-size preview inside this RAW file. Export it as a JPEG first.`);
    if (jpegOrient(seg) <= 1 && [3, 6, 8].includes(orient)) {
      const rot = orient !== 3, c = el('canvas'); c.width = rot ? best.height : best.width; c.height = rot ? best.width : best.height; const x = c.getContext('2d');
      if (orient === 3) { x.translate(c.width, c.height); x.rotate(Math.PI); } if (orient === 6) { x.translate(c.width, 0); x.rotate(Math.PI / 2); } if (orient === 8) { x.translate(0, c.height); x.rotate(-Math.PI / 2); }
      x.drawImage(best, 0, 0); best.close(); const out = await createImageBitmap(c); c.width = c.height = 0; return out;
    }
    return best;
  }
  /* ---- real RAW development (LibRaw, in a background worker): the full sensor data, not the small JPEG the camera tucks inside the file.
     Dark shots get their exposure from the 14-bit sensor data with the bright lights rolled off gently, so faces come up clean instead of noisy and blotchy. ---- */
  let LRmod = null, rawLock = Promise.resolve();
  const RAWDEV = new Map(), RAWISO = new Map();   // file key -> developed JPEG blob (the most recent few)
  async function rawEngine() { if (LRmod === false) return null; if (LRmod) return LRmod; try { LRmod = (await import('./raw/index.js')).default; } catch (e) { LRmod = false; } return LRmod || null; }
  function developRaw(file) {
    const key = keyOf(file);
    if (RAWDEV.has(key)) { const b = RAWDEV.get(key); RAWDEV.delete(key); RAWDEV.set(key, b); return Promise.resolve(b).then(bl => createImageBitmap(bl)); }
    const job = rawLock.then(async () => {   // one at a time: each development needs a lot of memory
      const LR = await rawEngine(); if (!LR) throw new Error('raw engine unavailable');
      const raw = new LR(); let d;
      try { await raw.open(new Uint8Array(await file.arrayBuffer()), { useCameraWb: true, outputBps: 16, gamm: [1, 1], noAutoBright: true, highlight: 2, userQual: 3, fbddNoiserd: 1 }); try { const md = await raw.metadata(); if (md && md.iso_speed) RAWISO.set(key, Math.round(md.iso_speed)); } catch (e) { } d = await raw.imageData(); }
      finally { try { raw.dispose(); } catch (e) { } }
      const W = d.width, H = d.height, src = d.data, n = W * H, mx = 65535;
      const lin = v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4), lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
      // learn the camera's own colour and tone (its picture style) from the preview JPEG inside the same file,
      // so the developed photo looks like your camera's colour, rich skin included, but with all the extra detail in the shadows and lights
      let M = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], hx = null, hy = null;
      try {
        const pv = await decodeRaw(file), sw = 300, sh2 = Math.round(sw * H / W), cv = el('canvas'); cv.width = sw; cv.height = sh2; const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.filter = 'blur(1px)'; cx.drawImage(pv, 0, 0, sw, sh2); pv.close && pv.close(); const J = cx.getImageData(0, 0, sw, sh2).data; cv.width = cv.height = 0;
        const S0 = [], T0 = [];
        for (let y = 2; y < sh2 - 2; y++) for (let x = 2; x < sw - 2; x++) {
          let r = 0, g = 0, b = 0, c = 0; const X0 = Math.floor(x * W / sw), Y0 = Math.floor(y * H / sh2), X1 = Math.floor((x + 1) * W / sw), Y1 = Math.floor((y + 1) * H / sh2);
          for (let yy = Y0; yy < Y1; yy += 3) for (let xx = X0; xx < X1; xx += 3) { const q = 3 * (yy * W + xx); r += src[q]; g += src[q + 1]; b += src[q + 2]; c++; }
          r /= c * mx; g /= c * mx; b /= c * mx; const p = 4 * (y * sw + x), jr = lin(J[p] / 255), jg = lin(J[p + 1] / 255), jb = lin(J[p + 2] / 255);
          if (Math.max(J[p], J[p + 1], J[p + 2]) > 245 || Math.max(r, g, b) > 0.95 || lum(r, g, b) < 2e-4) continue; S0.push([r, g, b]); T0.push([jr, jg, jb]); }
        if (S0.length > 2000) {
          // colour: a 3x3 matrix (least squares, on colour ratios so brightness doesn't dominate)
          const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Bm = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
          for (let k = 0; k < S0.length; k++) { const s3 = S0[k], t3 = T0[k], ws = 1 / Math.max(1e-3, lum(...s3)), wt = 1 / Math.max(1e-3, lum(...t3)); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { A[i][j] += s3[i] * ws * s3[j] * ws; Bm[i][j] += s3[i] * ws * t3[j] * wt; } }
          const inv = m => { const [a, b, c] = m[0], [d2, e, f] = m[1], [g, h, i] = m[2], det = a * (e * i - f * h) - b * (d2 * i - f * g) + c * (d2 * h - e * g); if (Math.abs(det) < 1e-12) return null;
            return [[(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det], [(f * g - d2 * i) / det, (a * i - c * g) / det, (c * d2 - a * f) / det], [(d2 * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d2) / det]]; };
          const Ai = inv(A);
          if (Ai) { const X = [0, 1, 2].map(i => [0, 1, 2].map(j => Ai[i][0] * Bm[0][j] + Ai[i][1] * Bm[1][j] + Ai[i][2] * Bm[2][j]));   // X[i][j]: input i -> output j
            const Mt = [0, 1, 2].map(j => [0, 1, 2].map(i => X[i][j])); const rs = Mt.map(row => row[0] + row[1] + row[2]); M = Mt.map((row, j) => row.map(v => v / Math.max(0.3, rs[j]) ));   // rows keep white neutral
            // tame extremes: a matrix that would swing colours wildly is blended back toward plain
            const off = Math.max(...M.flat().map((v, k) => Math.abs(v - (k % 4 === 0 ? 1 : 0)))); if (off > 0.9) { const t = 0.9 / off; M = M.map((row, j) => row.map((v, i) => (i === j ? 1 : 0) + (v - (i === j ? 1 : 0)) * t)); } }
          // tone: the camera's curve, as output brightness for each input brightness (after the colour matrix)
          const NB = 48, bins = Array.from({ length: NB }, () => []), lo = Math.log(2e-4), hi = 0;
          for (let k = 0; k < S0.length; k++) { const [r, g, b] = S0[k], Yi = lum(M[0][0] * r + M[0][1] * g + M[0][2] * b, M[1][0] * r + M[1][1] * g + M[1][2] * b, M[2][0] * r + M[2][1] * g + M[2][2] * b); if (Yi <= 0) continue;
            const bi = Math.max(0, Math.min(NB - 1, Math.floor((Math.log(Yi) - lo) / (hi - lo) * NB))); bins[bi].push(lum(...T0[k])); }
          hx = []; hy = []; for (let bi = 0; bi < NB; bi++) { if (bins[bi].length < 12) continue; bins[bi].sort((a, b) => a - b); hx.push(Math.exp(lo + (bi + 0.5) / NB * (hi - lo))); hy.push(bins[bi][(bins[bi].length / 2) | 0]); }
          for (let k = 1; k < hy.length; k++) hy[k] = Math.max(hy[k], hy[k - 1]);   // never reverses
          if (hx.length < 6) { hx = hy = null; }
        }
      } catch (e) { hx = hy = null; }
      const curve = Y => { if (!hx) return Y; if (Y <= hx[0]) return hy[0] * Y / hx[0]; const L = hx.length - 1;
        if (Y >= hx[L]) { const top = hy[L], slope = (hy[L] - hy[L - 1]) / Math.max(1e-6, Math.log(hx[L] / hx[L - 1])); return Math.min(0.98, top + (0.98 - top) * (1 - Math.exp(-slope * Math.log(Y / hx[L]) / Math.max(1e-3, 0.98 - top)))); }
        let a = 0, b = L; while (b - a > 1) { const m = (a + b) >> 1; if (hx[m] > Y) b = m; else a = m; } const t = Math.log(Y / hx[a]) / Math.log(hx[b] / hx[a]); return hy[a] + (hy[b] - hy[a]) * t; };
      // exposure: dark shots are brightened from the sensor data (up to 2 stops) before the camera's curve, so faces come up clean
      const Ls = []; for (let i = 0; i < n; i += 97) { const q = 3 * i; Ls.push(curve(lum(src[q] / mx, src[q + 1] / mx, src[q + 2] / mx))); } Ls.sort((a, b) => a - b);
      const p50 = Math.max(1e-4, Ls[(Ls.length * 0.5) | 0]);
      const gTarget = Math.max(1, Math.min(1.3, 0.09 / p50));   // close to how you exposed it: at most about 2/3 of a stop brighter for very dark shots
      const T = new Uint8ClampedArray(4097); for (let k = 0; k <= 4096; k++) { const v = k / 4096; T[k] = Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); }
      const CL = new Float32Array(4097); for (let k = 0; k <= 4096; k++) { const Y = Math.pow(k / 4096, 3) * 8; CL[k] = Y > 0 ? curve(Y) / Y : (hx ? hy[0] / hx[0] : 1); }   // curve as a fast lookup (cube-root spaced, inputs up to 8)
      const img = new ImageData(W, H), o = img.data, [m0, m1, m2] = M;
      for (let i = 0; i < n; i++) { const q = 3 * i, p = 4 * i, r0 = src[q] / mx * gTarget, g0 = src[q + 1] / mx * gTarget, b0 = src[q + 2] / mx * gTarget;
        let r = m0[0] * r0 + m0[1] * g0 + m0[2] * b0, gg = m1[0] * r0 + m1[1] * g0 + m1[2] * b0, b = m2[0] * r0 + m2[1] * g0 + m2[2] * b0; if (r < 0) r = 0; if (gg < 0) gg = 0; if (b < 0) b = 0;
        const Y = lum(r, gg, b), k = CL[Math.min(4096, Math.round(Math.cbrt(Math.min(8, Y) / 8) * 4096))]; r *= k; gg *= k; b *= k;
        const m3 = Math.max(r, gg, b); if (m3 > 1) { const Yc = lum(r, gg, b), t = Math.min(1, (m3 - 1) / Math.max(1e-4, m3 - Yc)); r -= (r - Yc) * t; gg -= (gg - Yc) * t; b -= (b - Yc) * t; }
        o[p] = T[Math.min(4096, (r * 4096) | 0)]; o[p + 1] = T[Math.min(4096, (gg * 4096) | 0)]; o[p + 2] = T[Math.min(4096, (b * 4096) | 0)]; o[p + 3] = 255; }
      const c = el('canvas'); c.width = W; c.height = H; c.getContext('2d').putImageData(img, 0, 0);
      const blob = await toBlob(c, 0.96); c.width = c.height = 0;
      RAWDEV.set(key, blob); while (RAWDEV.size > 6) RAWDEV.delete(RAWDEV.keys().next().value);
      return blob;
    });
    rawLock = job.catch(() => { });
    return job.then(bl => createImageBitmap(bl));
  }
  async function decode(file) {
    if (RAW_RE.test(file.name)) { if (S.rawMode !== 'preview') { try { return await developRaw(file); } catch (e) { if (!S.rawWarned) { S.rawWarned = true; setTimeout(() => toast('Couldn\'t develop the RAW data on this device, so the photo preview inside the file is used instead.', 6000), 0); } } } return decodeRaw(file); }
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { throw new Error(/\.(heic|heif)$/i.test(file.name) ? `This browser can't open ${file.name}. Export it as a JPEG.` : `Couldn't open ${file.name}.`); }
  }
  function scaled(src, W, H, long) { const k = Math.min(1, long / Math.max(W, H)), w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k)); const c = el('canvas'); c.width = w; c.height = h; const x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, w, h); return c; }
  const toBlob = (c, q) => new Promise(r => c.toBlob(r, 'image/jpeg', q));

  /* ---------------- import ---------------- */
  const Q = { list: [], running: 0, done: 0, total: 0, stop: false };
  function importFiles(files) {
    const list = Array.from(files).filter(f => /^image\//.test(f.type) || IMG_RE.test(f.name) || RAW_RE.test(f.name));
    if (!list.length) { toast('No photos found in what you chose.'); return; }
    // skip files already in the session
    const have = new Set(S.photos.map(p => p.key));
    const fresh = list.filter(f => !have.has(keyOf(f)));
    if (fresh.length < list.length) toast(`${list.length - fresh.length} already imported, skipped.`);
    for (const f of fresh) {
      const p = { id: nid(), file: f, name: f.name, key: keyOf(f), order: S.order++, time: null, W: 0, H: 0, thumb: null, editThumb: null, eyeBlob: null, an: null, flags: {}, pick: 0, rating: 0, eyes: null, s: D.defaults(), brush: null, subj: null, undo: [], redo: [], state: 'queued' };
      S.photos.push(p); S.byId.set(p.id, p); Q.list.push(p);
    }
    Q.total += fresh.length; Q.stop = false;
    if (!S.active && S.photos[0]) S.active = S.photos[0].id;
    render(); pump();
  }
  const keyOf = f => `${f.name}|${f.size}|${f.lastModified}`;
  async function pump() {
    while (Q.running < 2 && Q.list.length && !Q.stop) { const p = Q.list.shift(); Q.running++; ingest(p).finally(() => { Q.running--; Q.done++; progress(); pump(); }); }
    progress();
    if (!Q.running && !Q.list.length) { if (Q.total && !AG.busy) { corePhase('done'); AG.sayText = `${Q.total} photo${Q.total > 1 ? 's' : ''} ready. Pick one and press Edit.`; setAgent('idle', AG.sayText); } if (Q.total) { D.cull(S.photos); Q.total = 0; Q.done = 0; progress(); renderAll(); if (S.autoMode === 'import') { const fresh = S.photos.filter(isFresh); if (fresh.length) setTimeout(() => autoFix(activePhoto(), fresh), 50); } toast('Import finished. Similar frames, soft shots and exposure warnings are sorted into the Culling folders.', 5200); } }
  }
  function progress() {
    if (Q.total > 0 && (Q.running || Q.list.length) && !AG.busy) { if (AG.phase !== 'import') { corePhase('import'); setAgent('look', null); } const b = document.getElementById('agSay'); if (b) b.textContent = `Reading your photos: ${Q.done} of ${Q.total}…`; }
    const on = Q.total > 0 && (Q.running || Q.list.length) || S.busy;
    $('prog').hidden = !on;
    if (S.busy) { $('progText').textContent = S.busy.text; $('progBar').style.width = (S.busy.frac * 100).toFixed(1) + '%'; return; }
    if (on) { $('progText').textContent = `Importing ${Q.done} of ${Q.total}`; $('progBar').style.width = (Q.done / Q.total * 100).toFixed(1) + '%'; }
  }
  $('progStop').onclick = () => { if (S.busy) { S.busy.stop = true; return; } Q.stop = true; Q.list.forEach(p => { p.state = 'skipped'; }); Q.list = []; };
  async function ingest(p) {
    p.state = 'loading'; updateCell(p);
    try {
      const head = new Uint8Array(await p.file.slice(0, 600000).arrayBuffer());
      p.time = D.exifTime(head) ?? null;
      const bmp = await decode(p.file); p.W = bmp.width; p.H = bmp.height; p.iso = RAWISO.get(keyOf(p.file)) || isoFromExif(head) || null;
      const t = scaled(bmp, p.W, p.H, 400); p.thumb = URL.createObjectURL(await toBlob(t, 0.82));
      const e = scaled(bmp, p.W, p.H, 1024); p.eyeBlob = await toBlob(e, 0.85);
      const ex = e.getContext('2d', { willReadFrequently: true }); p.an = D.analyze(ex.getImageData(0, 0, e.width, e.height).data, e.width, e.height);
      t.width = t.height = e.width = e.height = 0; bmp.close && bmp.close();
      const saved = await IDB.get(p.key);
      // importing a photo again starts it fresh (unless "keep my last edit" is on); the people it found are kept so it doesn't have to look again
      if (saved && lsGet('lookmatch.keepEdits', '0') !== '1') { p.s = Object.assign(D.defaults(), { people: saved.s && saved.s.people || null, peopleDone: saved.s && saved.s.peopleDone }); p.pick = saved.pick || 0; p.rating = saved.rating || 0; persist(p); }
      else if (saved) { p.restored = true; p.s = Object.assign(D.defaults(), saved.s); p.pick = saved.pick || 0; p.rating = saved.rating || 0; p.eyes = saved.eyes || null; p.brush = saved.brush || null; p.subj = saved.subj || null; p.rm = saved.rm || null; p.agentNote = saved.agentNote || null; p.aiSnap = saved.aiSnap || null; if (isEdited(p)) queueThumb(p); }
      p.state = 'ready';
    } catch (err) { p.state = 'error'; p.err = err.message || String(err); }
    updateCell(p); if (p.id === S.active) renderRight();
  }
  // drop anywhere
  document.addEventListener('dragover', e => { if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', e => { if (e.target.closest && e.target.closest('.dropzone')) return; if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); importFiles(e.dataTransfer.files); } });
  $('importInput').onchange = e => { importFiles(e.target.files); e.target.value = ''; };
  $('importFolder').onchange = e => { importFiles(e.target.files); e.target.value = ''; };

  /* ---------------- filters ---------------- */
  const FOLDERS = [
    { id: 'all', name: 'All photos', ic: '▦', fn: p => true },
    { id: 'picks', name: 'Picks', ic: '⚑', fn: p => p.pick === 1 },
    { id: 'unflagged', name: 'Unflagged', ic: '○', fn: p => p.pick === 0 },
    { id: 'rejected', name: 'Rejected', ic: '✕', fn: p => p.pick === -1 },
    { id: 'rated', name: 'Rated 3★ and up', ic: '★', fn: p => p.rating >= 3 },
    { id: 'edited', name: 'Edited', ic: '◐', fn: p => isEdited(p) },
    { sep: 'Culling' },
    { id: 'best', name: 'Best of similar', ic: '◆', why: 'The strongest frame of each burst', fn: p => p.best || (p.an && !p.group) },
    { id: 'dup', name: 'Similar frames', ic: '⧉', why: 'Near-identical to a better frame', fn: p => p.flags.dup },
    { id: 'soft', name: 'Possibly soft', ic: '◌', why: 'Low detail; may be intentional', fn: p => p.flags.soft },
    { id: 'eyes', name: 'Eyes closed', ic: '◡', why: 'From the eyes check', fn: p => p.eyes && p.eyes.closed > 0 },
    { id: 'expo', name: 'Exposure warnings', ic: '◑', why: 'Blown highlights or very dark', fn: p => p.flags.blown || p.flags.dark },
  ];
  function visible() {
    const f = FOLDERS.find(x => x.id === S.filter) || FOLDERS[0];
    const l = S.photos.filter(p => f.fn(p));
    if (S.sort === 'time') l.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || a.order - b.order);
    else if (S.sort === 'name') l.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    else if (S.sort === 'sharp') l.sort((a, b) => ((b.an && b.an.sharp) || 0) - ((a.an && a.an.sharp) || 0));
    return l;
  }
  function isEdited(p) { const d = D.defaults(), s = p.s; for (const k in d) { if (k === 'hsl') { if (D.HSL_KEYS.some(h => s.hsl[h].some(v => v))) return true; continue; } if (k === 'v' || k === 'sharpen' || k === 'lookAmt' || k === 'pick' || k === 'creativeAmt' || k === 'aspect' || k === 'removals' || k === 'lookBg' || k === 'people' || s[k] === undefined) continue; if (JSON.stringify(s[k]) !== JSON.stringify(d[k])) return true; } return !!(p.brush || p.subj || p.rm || (p.s.removals || []).some(r => r.on)); }

  /* ---------------- module switching ---------------- */
  function setMod(m) {
    S.mod = m; document.querySelectorAll('[data-mod]').forEach(b => b.setAttribute('aria-current', b.dataset.mod === m));
    if (m !== 'develop') { S.tool = 'none'; }
    render();
  }
  document.querySelectorAll('[data-mod]').forEach(b => b.onclick = () => setMod(b.dataset.mod));
  function render() { renderLeft(); renderCenter(); renderRight(); renderStrip(); }
  function renderAll() { render(); }

  /* ================= LEFT PANEL ================= */
  function renderLeft() {
    const L = $('left'); L.innerHTML = '';
    if (S.mod === 'library' || S.mod === 'export') L.append(foldersPanel(), cullPanel());
    if (S.mod === 'develop' && S.manual) L.append(looksPanel(), creativePanel());
    document.body.classList.toggle('ai-mode', S.mod === 'develop' && !S.manual);
    if (S.mod === 'library') L.append(keysPanel());
  }
  function foldersPanel() {
    const box = el('div', { class: 'folders' });
    for (const f of FOLDERS) {
      if (f.sep) { box.append(el('div', { class: 'sec-h', style: 'margin-top:12px' }, el('h2', { text: f.sep }))); continue; }
      const n = S.photos.filter(p => f.fn(p)).length;
      box.append(el('button', { type: 'button', class: 'folder', 'aria-current': S.filter === f.id, onclick: () => { S.filter = f.id; render(); } },
        el('span', { class: 'ic', text: f.ic }), el('span', { class: 'nm' }, f.name, f.why ? el('span', { class: 'why', text: f.why }) : null), el('span', { class: 'ct', text: n })));
    }
    return el('section', { class: 'sec' }, el('div', { class: 'sec-h' }, el('h2', { text: 'Folders' })), box);
  }
  function cullPanel() {
    const n = S.photos.filter(p => p.an).length;
    const checked = S.photos.filter(p => p.eyes).length;
    return el('section', { class: 'sec' },
      el('div', { class: 'sec-h' }, el('h2', { text: 'Smart cull' })),
      el('p', { class: 'note', text: 'Nothing is rejected automatically. Each folder is a suggestion you can review and flag.' }),
      el('div', { class: 'row' },
        el('button', { class: 'btn sm', type: 'button', disabled: !n, onclick: () => { D.cull(S.photos); renderAll(); toast('Culling folders refreshed.'); } }, 'Re-run cull'),
        el('button', { class: 'btn sm primary', type: 'button', disabled: !n, onclick: openEyes }, 'Check eyes with Claude')),
      checked ? el('p', { class: 'note', text: `${checked} photo${checked > 1 ? 's' : ''} checked for closed eyes.` }) : null);
  }
  function keysPanel() {
    const k = [['P', 'Pick'], ['X', 'Reject'], ['U', 'Unflag'], ['1–5', 'Star rating'], ['0', 'Clear stars'], ['← →', 'Previous / next'], ['Space', 'Large view'], ['⇧ click', 'Select a range'], ['⌘/Ctrl A', 'Select all shown'], ['D', 'Edit in Develop']];
    return el('details', { class: 'sec' }, el('summary', { text: 'Keyboard' }), el('div', { class: 'keys' }, k.map(([a, b]) => [el('span', { class: 'kbd', text: a }), el('span', { text: b })])));
  }

  /* ================= CENTER ================= */
  let loupe = false;
  function renderCenter() {
    const C = $('center'); C.innerHTML = '';
    if (!S.photos.length) { C.append(emptyState()); return; }
    if (S.mod === 'library' && !loupe) C.append(gridBar(), gridView());
    else if (S.mod === 'export') C.append(exportView());
    else C.append(stageView());
  }
  function emptyState() {
    const d = el('div', { class: 'drop slim' },
      el('h3', { text: 'Add a photo for the AI to edit' }),
      el('p', { text: 'Drop photos here, or import them. JPEG and RAW. Your files stay on this device.' }),
      el('div', { class: 'row', style: 'justify-content:center' },
        el('span', { class: 'btn primary' }, 'Import photos', el('input', { type: 'file', multiple: true, accept: 'image/*,.cr2,.cr3,.nef,.arw,.dng,.raf,.orf,.rw2,.pef,.srw', 'aria-label': 'Import photos', onchange: e => importFiles(e.target.files) }))));
    d.ondragover = e => { e.preventDefault(); d.classList.add('drag'); }; d.ondragleave = () => d.classList.remove('drag');
    return el('div', { class: 'empty' }, d);
  }
  function gridBar() {
    const f = FOLDERS.find(x => x.id === S.filter), v = visible();
    const sel = S.sel.size;
    return el('div', { class: 'gridbar' },
      el('span', { class: 'title', text: f.name }), el('span', { class: 'count', text: `${v.length} photos${sel > 1 ? ` · ${sel} selected` : ''}` }),
      el('div', { class: 'grow' }),
      sel > 1 ? el('div', { class: 'row' },
        el('button', { class: 'btn sm', type: 'button', onclick: () => flagSel(1) }, 'Pick selected'),
        el('button', { class: 'btn sm', type: 'button', onclick: () => flagSel(-1) }, 'Reject selected')) : null,
      S.filter === 'dup' ? el('button', { class: 'btn sm', type: 'button', onclick: () => { let n = 0; for (const p of visible()) if (p.pick === 0) { p.pick = -1; persist(p); n++; } renderAll(); toast(`Rejected ${n} similar frames. The best of each burst is untouched.`); } }, 'Reject all similar frames') : null,
      el('label', { class: 'row', for: 'sortSel' }, el('span', { class: 'note', text: 'Sort' }),
        el('select', { class: 'text', id: 'sortSel', style: 'width:auto', onchange: e => { S.sort = e.target.value; renderCenter(); } },
          ...[['time', 'Capture time'], ['name', 'File name'], ['sharp', 'Sharpest first']].map(([v, t]) => el('option', { value: v, selected: S.sort === v, text: t })))),
      el('label', { class: 'row', for: 'cellSize' }, el('span', { class: 'note', text: 'Size' }), el('input', { type: 'range', id: 'cellSize', min: 110, max: 340, value: S.cell, style: 'width:90px', oninput: e => { S.cell = +e.target.value; $('grid').style.setProperty('--cell', S.cell + 'px'); } })));
  }
  function gridView() {
    const g = el('div', { class: 'grid', id: 'grid', style: `--cell:${S.cell}px` });
    for (const p of visible()) g.append(cellFor(p));
    return el('div', { class: 'gridscroll' }, g);
  }
  function cellFor(p) {
    const c = el('button', { type: 'button', class: 'cell', 'data-id': p.id, title: p.name });
    fillCell(c, p);
    c.onclick = e => clickPhoto(p, e);
    c.ondblclick = () => { S.active = p.id; if (S.mod === 'library') { loupe = true; render(); } };
    return c;
  }
  function fillCell(c, p) {
    c.innerHTML = '';
    c.classList.toggle('active', p.id === S.active); c.classList.toggle('sel', S.sel.has(p.id)); c.classList.toggle('rejected', p.pick === -1);
    const src = p.editThumb || p.thumb;
    if (src) c.append(el('img', { src, alt: p.name, loading: 'lazy', draggable: 'false' }));
    else c.append(el('span', { class: 'pending', text: p.state === 'error' ? 'Could not open' : 'Loading…' }));
    const b = el('div', { class: 'badges' });
    if (p.best) b.append(el('span', { class: 'badge best', text: 'Best' }));
    if (p.flags.dup) b.append(el('span', { class: 'badge dup', text: 'Similar' }));
    if (p.flags.soft) b.append(el('span', { class: 'badge soft', text: 'Soft?' }));
    if (p.eyes && p.eyes.closed > 0) b.append(el('span', { class: 'badge eyes', text: 'Eyes' }));
    if (p.flags.blown || p.flags.dark) b.append(el('span', { class: 'badge expo', text: p.flags.blown ? 'Bright' : 'Dark' }));
    c.append(b);
    if (p.pick === 1) c.append(el('span', { class: 'flag', text: '⚑', style: 'color:var(--pick)' }));
    if (p.pick === -1) c.append(el('span', { class: 'flag', text: '✕', style: 'color:var(--reject)' }));
    if (p.rating) c.append(el('span', { class: 'stars', text: '★'.repeat(p.rating) }));
    if (isEdited(p)) c.append(el('span', { class: 'edited', title: 'Edited' }));
  }
  function updateCell(p) { document.querySelectorAll(`.cell[data-id="${p.id}"]`).forEach(c => fillCell(c, p)); }
  function clickPhoto(p, e) {
    const vis = visible().map(x => x.id);
    if (e.shiftKey && S.anchor) { const a = vis.indexOf(S.anchor), b = vis.indexOf(p.id); if (a >= 0 && b >= 0) { S.sel = new Set(vis.slice(Math.min(a, b), Math.max(a, b) + 1)); } }
    else if (e.metaKey || e.ctrlKey) { if (S.sel.has(p.id)) S.sel.delete(p.id); else S.sel.add(p.id); S.anchor = p.id; }
    else { S.sel = new Set([p.id]); S.anchor = p.id; }
    const prev = S.active; S.active = p.id;
    if (S.mod === 'develop') { if (prev !== p.id) { S.tool = 'none'; } render(); }
    else { document.querySelectorAll('.cell').forEach(c => { const q = photo(c.dataset.id); if (q) { c.classList.toggle('active', q.id === S.active); c.classList.toggle('sel', S.sel.has(q.id)); } }); renderRight(); const gb = document.querySelector('.gridbar'); if (gb) gb.replaceWith(gridBar()); }
  }
  function flagSel(v) { const ids = S.sel.size ? [...S.sel] : [S.active]; for (const id of ids) { const p = photo(id); if (p) { p.pick = v; persist(p); updateCell(p); } } renderLeft(); renderRight(); }

  /* ---------------- stage (Develop + Library loupe) ---------------- */
  const V = { token: 0, last: null, before: null, srcCache: new Map(), drawing: false };
  function stageView() {
    const p = activePhoto(); const wrap = el('div', { style: 'display:flex;flex-direction:column;flex:1;min-height:0' });
    const bar = el('div', { class: 'stagebar' });
    if (S.mod === 'library') bar.append(el('button', { class: 'btn sm', type: 'button', onclick: () => { loupe = false; render(); } }, '← Grid'), el('span', { class: 'note', text: p ? p.name : '' }));
    bar.append(el('div', { class: 'seg', role: 'group', 'aria-label': 'Before and after' },
      ...[['split', 'Compare'], ['before', 'Before'], ['after', 'After']].map(([v, t]) => el('button', { type: 'button', 'aria-pressed': S.compare === v, onclick: () => { S.compare = v; applyCompare(); bar.querySelectorAll('[data-cmp]').forEach(b => b.setAttribute('aria-pressed', b.dataset.cmp === v)); }, 'data-cmp': v, text: t }))));
    bar.append(el('div', { class: 'grow' }));
    if (S.mod === 'develop' && p && !S.manual) bar.append(el('button', { class: 'btn ghost sm', type: 'button', title: 'Undo (⌘Z)', onclick: undo }, 'Undo'), el('button', { class: 'btn ghost sm', type: 'button', title: 'Redo (⇧⌘Z)', onclick: redo }, 'Redo'));
    if (S.mod === 'develop' && p && S.manual) {
      bar.append(el('div', { class: 'seg', role: 'group', 'aria-label': 'Tools' },
        ...[['none', 'View'], ['crop', 'Crop'], ['dodge', 'Dodge'], ['burn', 'Burn'], ['erase', 'Erase brush'], ['remove', 'Remove']].map(([v, t]) => el('button', { type: 'button', 'aria-pressed': S.tool === v, text: t, onclick: () => setTool(v) }))));
      if (['dodge', 'burn', 'erase', 'subj+', 'subj-', 'remove', 'unremove'].includes(S.tool)) bar.append(
        el('label', { class: 'row', for: 'bsz' }, el('span', { class: 'note', text: 'Size' }), el('input', { type: 'range', id: 'bsz', min: 2, max: 40, value: S.brushSize, style: 'width:80px', oninput: e => S.brushSize = +e.target.value })),
        el('label', { class: 'row', for: 'bfl' }, el('span', { class: 'note', text: 'Flow' }), el('input', { type: 'range', id: 'bfl', min: 5, max: 100, value: S.brushFlow, style: 'width:80px', oninput: e => S.brushFlow = +e.target.value })));
      bar.append(el('button', { class: 'btn ghost sm', type: 'button', title: 'Undo (⌘Z)', onclick: undo }, 'Undo'), el('button', { class: 'btn ghost sm', type: 'button', title: 'Redo (⇧⌘Z)', onclick: redo }, 'Redo'));
    }
    const stage = el('div', { class: 'stage', id: 'stage' });
    const frame = el('div', { class: 'frame', id: 'frame' },
      el('canvas', { id: 'cvA', 'aria-label': 'Edited photo' }), el('canvas', { id: 'cvB', class: 'cmp', 'aria-label': 'Original photo' }), el('canvas', { id: 'cvO', class: 'ov' }),
      el('div', { class: 'handle', id: 'handle', role: 'slider', tabindex: '0', 'aria-label': 'Compare position', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': Math.round(S.split * 100) }),
      el('div', { class: 'corner l', id: 'cornerL', text: 'Before' }), el('div', { class: 'corner r', id: 'cornerR', text: 'After' }));
    stage.append(frame, el('div', { class: 'cursor', id: 'cursor', hidden: true }), el('div', { class: 'loading', id: 'loading', hidden: true, text: 'Rendering…' }), el('div', { class: 'stage-msg', id: 'stageMsg' }));
    wrap.append(bar, stage);
    requestAnimationFrame(() => { wireStage(); scheduleRender('final'); });
    return wrap;
  }
  function setTool(v) {
    const p = activePhoto(); if (!p) return;
    if (S.tool === 'crop' && v !== 'crop') commitCrop();
    S.tool = v; if (v === 'crop') beginCrop();
    renderCenter(); if (S.mod === 'develop') renderRight();
  }
  const SM = new Map();
  async function smallSource(p) {
    if (SM.has(p.id)) { const v = SM.get(p.id); SM.delete(p.id); SM.set(p.id, v); return v; }
    const b = await createImageBitmap(p.eyeBlob); SM.set(p.id, b);
    while (SM.size > 12) { const k = SM.keys().next().value; const o = SM.get(k); o.close && o.close(); SM.delete(k); }
    return b;
  }
  async function previewSource(p) {
    if (V.srcCache.has(p.id)) { const v = V.srcCache.get(p.id); V.srcCache.delete(p.id); V.srcCache.set(p.id, v); return v; }
    const bmp = await decode(p.file); const k = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
    let src = bmp; if (k < 1) { src = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' }); bmp.close(); }
    const v = { src, SW: src.width, SH: src.height }; V.srcCache.set(p.id, v);
    while (V.srcCache.size > 6) { const k0 = V.srcCache.keys().next().value; const o = V.srcCache.get(k0); o.src.close && o.src.close(); V.srcCache.delete(k0); }
    return v;
  }
  let rTimer = null, rPending = null;
  /* one render at a time: while one is drawing, newer requests wait and the latest runs next. (Starting a new render on every slider tick and
     throwing away the unfinished one meant a slow device never showed anything until the slider stopped.) */
  let rBusy = false;
  function scheduleRender(q) {
    rPending = rPending === 'final' ? 'final' : q;
    if (rTimer || rBusy) return;
    rTimer = setTimeout(runRender, q === 'draft' ? 16 : 60);
  }
  async function runRender() { rTimer = null; if (rBusy || !rPending) return; const qq = rPending; rPending = null; rBusy = true;
    try { await drawStage(qq); } finally { rBusy = false; if (rPending && !rTimer) rTimer = setTimeout(runRender, 0); } }
  function renderIdle(ms) { const t0 = Date.now(); return new Promise(res => { const chk = () => (!rBusy && !rTimer && !rPending) || Date.now() - t0 > (ms || 5000) ? res() : setTimeout(chk, 40); chk(); }); }
  async function drawStage(q) {
    const p = activePhoto(), cvA = $('cvA'); if (!p || !cvA || p.state !== 'ready') { if (p && p.state !== 'ready' && cvA) setTimeout(() => scheduleRender('final'), 400); return; }
    const tok = ++V.token; $('loading').hidden = false;
    try {
      const fast = q === 'draft' || (S.mod === 'library');
      let srcInfo;
      if (fast && p.eyeBlob && (q === 'draft' || !V.srcCache.has(p.id))) { const sb = await smallSource(p); srcInfo = { src: sb, SW: sb.width, SH: sb.height, small: true }; }
      else srcInfo = await previewSource(p);
      if (tok !== V.token) return;
      const s = S.tool === 'crop' ? Object.assign(clone(p.s), { crop: null, removals: [] }) : p.s;
      const stg = $('stage'), dpr = Math.min(2, window.devicePixelRatio || 1);
      const maxLong = q === 'draft' ? (AG.dragging ? 800 : 1100) : Math.min(2400, Math.round(Math.max(stg.clientWidth, stg.clientHeight) * dpr));
      const L = s.look ? lookById(s.look) : null;
      const r = await P.process({ src: srcInfo.src, SW: srcInfo.SW, SH: srcInfo.SH, s, look: L ? L.look : null, lookKey: L ? L.id + ':' + (L.rev || 0) : '', id: p.id + (srcInfo.small ? 's' : 'p'), maxLong, fullW: Math.max(p.W, p.H), brush: S.tool === 'crop' ? null : p.brush, subj: p.subj, rm: S.tool === 'crop' ? null : p.rm });
      if (tok !== V.token) return;
      V.last = r;
      const W = r.w, H = r.h; cvA.width = W; cvA.height = H; cvA.getContext('2d').drawImage(r.canvas, 0, 0);
      const cvB = $('cvB'); cvB.width = W; cvB.height = H; const bx = cvB.getContext('2d'); bx.fillStyle = '#000'; bx.fillRect(0, 0, W, H); D.drawGeom(bx, srcInfo.src, srcInfo.SW, srcInfo.SH, s, W, H);
      const ov = $('cvO'); ov.width = W; ov.height = H;
      fitFrame(W, H); applyCompare(); drawOverlay();
      if (q !== 'draft' && S.mod === 'develop' && isEdited(p)) makeThumbFrom(p, r.canvas);
      if (q !== 'draft' && S.mod === 'develop' && L && !L.sample && L.doc && !L.doc.cover) setCover(L, p, false);
      const msg = $('stageMsg'); msg.innerHTML = '';
      if (p.s.creative && r.cr && r.cr.frac < 0.06) msg.append(el('div', { class: 'msg warn', text: 'No clear subject found (everything is equally sharp). Use the Subject brush to mark the couple.' }));
      if ((p.s.skyExp || p.s.skySat || p.s.skyTemp) && r.sky && !r.sky.frac) msg.append(el('div', { class: 'msg warn', text: 'No sky found in this photo.' }));
      if (q === 'draft' && S.mod === 'develop' && !AG.dragging) scheduleRender('final');
    } catch (e) { const m = $('stageMsg'); if (m) { m.innerHTML = ''; m.append(el('div', { class: 'msg err', text: e.message || String(e) })); } }
    finally { if (tok === V.token && $('loading')) $('loading').hidden = true; }
  }
  function fitFrame(W, H) {
    const stg = $('stage'), fr = $('frame'); if (!stg || !fr) return;
    const sw = stg.clientWidth - 24, sh = stg.clientHeight - 24, ar = W / H; let w = sw, h = w / ar; if (h > sh) { h = sh; w = h * ar; }
    fr.style.width = Math.floor(w) + 'px'; fr.style.height = Math.floor(h) + 'px';
  }
  new ResizeObserver(() => { const c = $('cvA'); if (c && c.width) fitFrame(c.width, c.height); }).observe($('center'));
  function applyCompare() {
    const cvB = $('cvB'), hd = $('handle'); if (!cvB) return;
    const crop = S.tool === 'crop', pct = (S.split * 100).toFixed(2);
    const mode = crop ? 'after' : S.compare;
    $('cornerL').hidden = mode === 'after'; $('cornerR').hidden = mode === 'before' || crop;
    if (mode === 'split') { cvB.hidden = false; cvB.style.clipPath = `inset(0 ${100 - pct}% 0 0)`; hd.hidden = false; hd.style.left = pct + '%'; }
    else if (mode === 'before') { cvB.hidden = false; cvB.style.clipPath = 'none'; hd.hidden = true; }
    else { cvB.hidden = true; hd.hidden = true; }
  }
  async function makeThumbFrom(p, canvas) {
    const t = scaled(canvas, canvas.width, canvas.height, 400), b = await toBlob(t, 0.8); t.width = t.height = 0;
    if (p.editThumb) URL.revokeObjectURL(p.editThumb); p.editThumb = URL.createObjectURL(b); updateCell(p);
  }
  /* background: refresh edited thumbnails for photos changed in bulk (uses the 1024px stand-in, so it's quick) */
  const TQ = []; let tRun = false;
  function queueThumb(p) { if (!TQ.includes(p)) TQ.push(p); if (!tRun) runThumbs(); }
  async function runThumbs() {
    tRun = true;
    while (TQ.length) {
      const p = TQ.shift(); if (!p.eyeBlob) continue;
      try { const sb = await smallSource(p); const L = p.s.look ? lookById(p.s.look) : null; const r = await P.process({ src: sb, SW: sb.width, SH: sb.height, s: p.s, look: L ? L.look : null, lookKey: L ? L.id + ':' + (L.rev || 0) : '', id: p.id + 's', maxLong: 420, fullW: Math.max(p.W, p.H), brush: p.brush, subj: p.subj, rm: p.rm }); await makeThumbFrom(p, r.canvas); }
      catch (e) { }
      await tick();
    }
    tRun = false;
  }

  /* ---------------- stage interaction: compare handle, brushes, crop ---------------- */
  function wireStage() {
    const hd = $('handle'), stg = $('stage'), fr = $('frame'); if (!hd) return;
    let drag = false;
    hd.onpointerdown = e => { drag = true; hd.setPointerCapture(e.pointerId); e.stopPropagation(); };
    hd.onpointermove = e => { if (!drag) return; const r = fr.getBoundingClientRect(); S.split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); applyCompare(); };
    hd.onpointerup = () => drag = false;
    hd.onkeydown = e => { if (e.key === 'ArrowLeft') { S.split = Math.max(0, S.split - 0.05); applyCompare(); e.stopPropagation(); } if (e.key === 'ArrowRight') { S.split = Math.min(1, S.split + 0.05); applyCompare(); e.stopPropagation(); } };
    // slide anywhere on the photo to move the before/after bar (when no brush or crop tool is active)
    const canSlide = () => S.compare === 'split' && (S.tool === 'none' || S.tool === 'view' || !S.tool);
    const setSplit = e => { const r = fr.getBoundingClientRect(); S.split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); hd.setAttribute('aria-valuenow', Math.round(S.split * 100)); applyCompare(); };
    let sliding = false;
    fr.addEventListener('pointerdown', e => { if (e.target === hd || !canSlide()) return; sliding = true; fr.setPointerCapture(e.pointerId); setSplit(e); });
    fr.addEventListener('pointermove', e => { fr.classList.toggle('slide', canSlide()); if (sliding) setSplit(e); });
    fr.addEventListener('pointerup', () => { sliding = false; }); fr.addEventListener('pointercancel', () => { sliding = false; });
    let painting = false, last = null;
    const pos = e => { const r = fr.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, r }; };
    stg.onpointerdown = e => {
      if (e.target === hd) return; const p = activePhoto(); if (!p) return;
      if (S.tool === 'crop') { cropDown(e, pos(e)); stg.setPointerCapture(e.pointerId); return; }
      if (!['dodge', 'burn', 'erase', 'subj+', 'subj-', 'remove', 'unremove'].includes(S.tool)) return;
      pushUndo(p); painting = true; last = null; stg.setPointerCapture(e.pointerId); stroke(p, pos(e));
    };
    stg.onpointermove = e => {
      if (S.tool === 'crop') { cropMove(e, pos(e)); return; }
      showCursor(e); if (painting) stroke(activePhoto(), pos(e));
    };
    stg.onpointerup = () => { if (S.tool === 'crop') { cropUp(); return; } if (painting) { painting = false; last = null; const p = activePhoto(); if (p.rm) p.rm.v = (p.rm.v || 0) + 1; persist(p); scheduleRender('final'); updateCell(p); } };
    stg.onpointerleave = () => { const c = $('cursor'); if (c) c.hidden = true; };
    function showCursor(e) {
      const c = $('cursor'); if (!c) return; if (!['dodge', 'burn', 'erase', 'subj+', 'subj-', 'remove', 'unremove'].includes(S.tool)) { c.hidden = true; return; }
      const p = pos(e), rad = S.brushSize / 100 * Math.max(p.r.width, p.r.height), sr = stg.getBoundingClientRect();
      c.hidden = false; c.style.left = (e.clientX - sr.left) + 'px'; c.style.top = (e.clientY - sr.top) + 'px'; c.style.width = c.style.height = 2 * rad + 'px';
      c.style.borderColor = S.tool === 'dodge' ? '#f3e7c8' : S.tool === 'burn' ? '#6f8fb8' : (S.tool === 'subj+' || S.tool === 'remove') ? '#e46a5a' : '#fff';
    }
    function stroke(p, q) {
      if (q.x < 0 || q.x > 1 || q.y < 0 || q.y > 1) return;
      const step = S.brushSize / 100 * 0.3;
      if (last) { const dx = q.x - last.x, dy = q.y - last.y, n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step)); for (let k = 1; k <= n; k++) dab(p, last.x + dx * k / n, last.y + dy * k / n); } else dab(p, q.x, q.y);
      last = q; if (S.tool === 'remove' || S.tool === 'unremove') drawOverlay(); else scheduleRender('draft');
    }
  }
  function maskDims(p) { const r = V.last; if (r && r.small) return [r.small.w, r.small.h]; return [768, 512]; }
  function dab(p, u, v) {
    if (S.tool === 'remove' || S.tool === 'unremove') {
      const [w, h] = maskDims(p);
      if (!p.rm || p.rm.w !== w || p.rm.h !== h) p.rm = { w, h, v: 0, data: p.rm ? P.resample(Float32Array.from(p.rm.data), p.rm.w, p.rm.h, w, h) : new Float32Array(w * h) };
      if (!(p.rm.data instanceof Float32Array)) p.rm.data = Float32Array.from(p.rm.data);
      const R = S.brushSize / 100 * Math.max(w, h), cx = u * w, cy = v * h, add = S.tool === 'remove';
      for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(h - 1, Math.ceil(cy + R)); y++) for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(w - 1, Math.ceil(cx + R)); x++) { if ((x - cx) ** 2 + (y - cy) ** 2 > R * R) continue; p.rm.data[y * w + x] = add ? 1 : 0; }
      return;
    }
    const subj = S.tool === 'subj+' || S.tool === 'subj-';
    const [w, h] = maskDims(p);
    let m = subj ? p.subj : p.brush;
    if (!m || m.w !== w || m.h !== h) { const old = m; m = { w, h, data: old ? P.resample(old.data instanceof Float32Array ? old.data : Float32Array.from(old.data), old.w, old.h, w, h) : new Float32Array(w * h) }; if (subj) p.subj = m; else p.brush = m; }
    if (!(m.data instanceof Float32Array)) m.data = Float32Array.from(m.data);
    const R = S.brushSize / 100 * Math.max(w, h), flow = S.brushFlow / 100, cx = u * w, cy = v * h;
    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(w - 1, Math.ceil(cx + R)), y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(h - 1, Math.ceil(cy + R));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (R * R); if (d2 > 1) continue; const f = Math.exp(-3 * d2) * (1 - d2), i = y * w + x;
      if (subj) m.data[i] = Math.max(-1, Math.min(1, m.data[i] + (S.tool === 'subj+' ? 1 : -1) * 0.25 * flow * f));
      else if (S.tool === 'erase') m.data[i] *= 1 - 0.35 * flow * f;
      else m.data[i] = Math.max(-1.6, Math.min(1.6, m.data[i] + (S.tool === 'dodge' ? 1 : -1) * 0.07 * flow * f));
    }
  }
  function drawOverlay() {
    const ov = $('cvO'); if (!ov) return; const x = ov.getContext('2d'), W = ov.width, H = ov.height; x.clearRect(0, 0, W, H);
    if (S.tool === 'crop' && CR.rect) {
      const r = CR.rect; x.fillStyle = 'rgba(0,0,0,.55)'; x.fillRect(0, 0, W, H); x.clearRect(r.x * W, r.y * H, r.w * W, r.h * H);
      x.strokeStyle = 'rgba(255,255,255,.95)'; x.lineWidth = Math.max(1.5, W / 700); x.strokeRect(r.x * W, r.y * H, r.w * W, r.h * H);
      x.strokeStyle = 'rgba(255,255,255,.35)'; x.lineWidth = 1; for (let k = 1; k < 3; k++) { x.beginPath(); x.moveTo((r.x + r.w * k / 3) * W, r.y * H); x.lineTo((r.x + r.w * k / 3) * W, (r.y + r.h) * H); x.moveTo(r.x * W, (r.y + r.h * k / 3) * H); x.lineTo((r.x + r.w) * W, (r.y + r.h * k / 3) * H); x.stroke(); }
      x.fillStyle = '#fff'; const hs = Math.max(8, W / 90); for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) x.fillRect((r.x + r.w * a) * W - hs / 2, (r.y + r.h * b) * H - hs / 2, hs, hs);
    }
    const p0 = activePhoto();
    if (p0 && (S.tool === 'remove' || S.tool === 'unremove' || S.showRm)) {
      if (p0.rm) { const w = p0.rm.w, h = p0.rm.h, c = el('canvas'); c.width = w; c.height = h; const cx = c.getContext('2d'), id = cx.createImageData(w, h); for (let i = 0; i < w * h; i++) { id.data[4 * i] = 228; id.data[4 * i + 1] = 70; id.data[4 * i + 2] = 60; id.data[4 * i + 3] = p0.rm.data[i] > 0.3 ? 120 : 0; } cx.putImageData(id, 0, 0); x.drawImage(c, 0, 0, W, H); }
      (p0.s.removals || []).forEach((r, i) => { const [bx, by, bw, bh] = r.box; x.setLineDash(r.on ? [] : [6, 4]); x.strokeStyle = r.on ? '#e46a5a' : 'rgba(255,255,255,.9)'; x.lineWidth = Math.max(2, W / 600); x.strokeRect(bx * W, by * H, bw * W, bh * H); x.setLineDash([]); const t = String(i + 1); x.font = `bold ${Math.max(12, W / 70)}px Manrope, sans-serif`; const tw = x.measureText(t).width + 10; x.fillStyle = r.on ? '#e46a5a' : 'rgba(0,0,0,.75)'; x.fillRect(bx * W, by * H, tw, Math.max(16, W / 55)); x.fillStyle = '#fff'; x.fillText(t, bx * W + 5, by * H + Math.max(12, W / 70)); });
    }
    if (S.showDB && V.last && V.last.db && S.tool !== 'crop') {
      const { dodge, burn } = V.last.db, w = V.last.small.w, h = V.last.small.h, c = el('canvas'); c.width = w; c.height = h; const cx = c.getContext('2d'), id = cx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) { const d = dodge[i] + burn[i], a = Math.min(1, Math.abs(d) * 2.6); if (d > 0) { id.data[4 * i] = 255; id.data[4 * i + 1] = 196; id.data[4 * i + 2] = 70; } else { id.data[4 * i] = 60; id.data[4 * i + 1] = 120; id.data[4 * i + 2] = 255; } id.data[4 * i + 3] = a * 190; }
      cx.putImageData(id, 0, 0); x.imageSmoothingEnabled = true; x.drawImage(c, 0, 0, W, H);
    }
    if ((S.tool === 'subj+' || S.tool === 'subj-') && V.last && V.last.cr) {
      const m = V.last.cr.mask, w = V.last.small.w, h = V.last.small.h, c = el('canvas'); c.width = w; c.height = h; const cx = c.getContext('2d'), id = cx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) { id.data[4 * i] = 228; id.data[4 * i + 1] = 90; id.data[4 * i + 2] = 80; id.data[4 * i + 3] = m[i] * 120; }
      cx.putImageData(id, 0, 0); x.imageSmoothingEnabled = true; x.drawImage(c, 0, 0, W, H);
    }
  }

  /* ---------------- crop tool ---------------- */
  const CR = { rect: null, drag: null };
  const ASPECTS = [['orig', 'Original'], ['free', 'Free'], ['1:1', '1 : 1'], ['4:5', '4 : 5'], ['5:7', '5 : 7'], ['2:3', '2 : 3'], ['16:9', '16 : 9']];
  function aspectVal(p) { const s = p.s; if (s.aspect === 'free') return null; const [OW, OH] = D.oriented(p.W, p.H, s); let land = OW >= OH; if (s.aspectFlip) land = !land; if (s.aspect === 'orig') return s.aspectFlip ? OH / OW : OW / OH; const [a, b] = s.aspect.split(':').map(Number); return land ? Math.max(a, b) / Math.min(a, b) : Math.min(a, b) / Math.max(a, b); }
  function beginCrop() { const p = activePhoto(); pushUndo(p); CR.rect = p.s.crop ? Object.assign({}, p.s.crop) : { x: 0, y: 0, w: 1, h: 1 }; }
  function fitAspect(p, r) {
    const a = aspectVal(p); if (!a) return r; const [OW, OH] = D.oriented(p.W, p.H, p.s);
    const cur = r.w * OW / (r.h * OH); const cx = r.x + r.w / 2, cy = r.y + r.h / 2; let w = r.w, h = r.h;
    if (cur > a) w = h * OH * a / OW; else h = w * OW / a / OH;
    if (w > 1) { h *= 1 / w; w = 1; } if (h > 1) { w *= 1 / h; h = 1; }
    return { x: Math.min(1 - w, Math.max(0, cx - w / 2)), y: Math.min(1 - h, Math.max(0, cy - h / 2)), w, h };
  }
  function cropDown(e, q) {
    const r = CR.rect; if (!r) return; const tol = 0.04;
    const near = (a, b) => Math.abs(a - b) < tol;
    let mode = 'move';
    for (const [cx, cy, m] of [[r.x, r.y, 'tl'], [r.x + r.w, r.y, 'tr'], [r.x, r.y + r.h, 'bl'], [r.x + r.w, r.y + r.h, 'br']]) if (near(q.x, cx) && near(q.y, cy)) mode = m;
    if (mode === 'move' && !(q.x > r.x && q.x < r.x + r.w && q.y > r.y && q.y < r.y + r.h)) mode = 'new';
    CR.drag = { mode, x0: q.x, y0: q.y, r0: Object.assign({}, r) };
  }
  function cropMove(e, q) {
    if (!CR.drag) return; const p = activePhoto(), d = CR.drag, r0 = d.r0; let r = Object.assign({}, r0);
    const dx = q.x - d.x0, dy = q.y - d.y0, cl = v => Math.min(1, Math.max(0, v));
    if (d.mode === 'move') { r.x = Math.min(1 - r.w, Math.max(0, r0.x + dx)); r.y = Math.min(1 - r.h, Math.max(0, r0.y + dy)); }
    else {
      let x1 = r0.x, y1 = r0.y, x2 = r0.x + r0.w, y2 = r0.y + r0.h;
      if (d.mode === 'new') { x1 = d.x0; y1 = d.y0; x2 = q.x; y2 = q.y; }
      if (d.mode === 'tl') { x1 = r0.x + dx; y1 = r0.y + dy; } if (d.mode === 'tr') { x2 = r0.x + r0.w + dx; y1 = r0.y + dy; }
      if (d.mode === 'bl') { x1 = r0.x + dx; y2 = r0.y + r0.h + dy; } if (d.mode === 'br') { x2 = r0.x + r0.w + dx; y2 = r0.y + r0.h + dy; }
      x1 = cl(x1); x2 = cl(x2); y1 = cl(y1); y2 = cl(y2);
      r = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.max(0.05, Math.abs(x2 - x1)), h: Math.max(0.05, Math.abs(y2 - y1)) };
      const a = aspectVal(p);
      if (a) { const [OW, OH] = D.oriented(p.W, p.H, p.s); const want = r.w * OW / a / OH; if (want <= 1 - r.y || d.mode === 'tl' || d.mode === 'tr') { const anchorTop = d.mode === 'tl' || d.mode === 'tr'; const nh = Math.min(want, anchorTop ? r.y + r.h : 1 - r.y); if (anchorTop) r.y = r.y + r.h - nh; r.h = nh; r.w = r.h * OH * a / OW; if (d.mode === 'tl' || d.mode === 'bl') r.x = (d.mode === 'tl' || d.mode === 'bl') ? Math.max(0, r0.x + r0.w - r.w) : r.x; } }
    }
    CR.rect = r; drawOverlay();
  }
  function cropUp() { CR.drag = null; }
  function commitCrop() {
    const p = activePhoto(); if (!p || !CR.rect) return;
    const r = CR.rect, full = r.x < 0.002 && r.y < 0.002 && r.w > 0.996 && r.h > 0.996;
    const before = JSON.stringify(p.s.crop);
    p.s.crop = full ? null : { x: +r.x.toFixed(4), y: +r.y.toFixed(4), w: +r.w.toFixed(4), h: +r.h.toFixed(4) };
    if (before !== JSON.stringify(p.s.crop) && (p.brush || p.subj || p.rm || (p.s.removals || []).length)) { p.brush = null; p.subj = null; p.rm = null; p.s.removals = []; toast('Brush work and removals were cleared because the crop changed. Run Find distractions again if needed.'); }
    CR.rect = null; persist(p); updateCell(p);
  }

  /* ---------------- undo / settings changes ---------------- */
  function pushUndo(p) { if (!p) return; p.undo.push(JSON.stringify({ s: p.s, brush: p.brush ? { w: p.brush.w, h: p.brush.h, data: Array.from(p.brush.data) } : null })); if (p.undo.length > 60) p.undo.shift(); p.redo = []; }
  function restore(p, snap) { const o = JSON.parse(snap); p.s = o.s; p.brush = o.brush ? { w: o.brush.w, h: o.brush.h, data: Float32Array.from(o.brush.data) } : null; }
  function undo() { const p = activePhoto(); if (!p || !p.undo.length) return; p.redo.push(JSON.stringify({ s: p.s, brush: p.brush ? { w: p.brush.w, h: p.brush.h, data: Array.from(p.brush.data) } : null })); restore(p, p.undo.pop()); afterChange(p, true); }
  function redo() { const p = activePhoto(); if (!p || !p.redo.length) return; p.undo.push(JSON.stringify({ s: p.s, brush: null })); restore(p, p.redo.pop()); afterChange(p, true); }
  function afterChange(p, rebuild) { persist(p); if (rebuild) renderRight(); renderLeftLight(); scheduleRender('final'); updateCell(p); }
  function renderLeftLight() { if (S.mod === 'develop') { const l = document.querySelectorAll('.look'); l.forEach(b => b.classList.toggle('on', b.dataset.id === (activePhoto() && activePhoto().s.look))); } }
  /* apply a settings change to the active photo (and the selection when asked) */
  function change(fn, opts) {
    const p = activePhoto(); if (!p) return;
    const targets = opts && opts.all ? opts.all : [p];
    for (const t of targets) { if (opts && opts.undo !== false) pushUndo(t); fn(t.s, t); persist(t); if (t !== p) { queueThumb(t); updateCell(t); } }
    scheduleRender(opts && opts.draft ? 'draft' : 'final'); updateCell(p);
  }

  /* ================= RIGHT PANEL ================= */
  /* the ideas, big, beside the photo: tap one to see it on the photo itself, then do it */
  function ideasDock() {
    const C = document.getElementById('center'); if (!C) return; let d = document.getElementById('ideasDock');
    const p = activePhoto(), on = AG.ideas && p && AG.ideasFor === p.id && S.mod === 'develop';
    if (!on) { if (d) d.remove(); ideaPeek(null); return; }
    if (d) d.remove();
    d = el('aside', { id: 'ideasDock', class: 'ideas-dock', 'aria-label': 'Ideas for this photo' },
      el('div', { class: 'dock-h' }, el('b', { text: `${AG.ideas.length} ideas` }), el('button', { type: 'button', class: 'btn sm', onclick: () => { AG.ideas = null; ideaPeek(null); ideasDock(); renderRight(); } }, 'Close')),
      el('p', { class: 'note', text: 'Tap an idea to see it on your photo.' }),
      ...AG.ideas.map(it => el('div', { class: 'dock-idea' + (AG.peek === it ? ' on' : '') },
        el('button', { type: 'button', class: 'dock-img', 'aria-pressed': AG.peek === it ? 'true' : 'false', 'aria-label': 'See ' + it.title + ' on the photo', onclick: () => { ideaPeek(AG.peek === it ? null : it); ideasDock(); } }, el('img', { src: it.url, alt: it.title })),
        el('b', { text: it.title }), it.s.look && lookById(it.s.look) ? el('span', { class: 'idea-look', text: 'Look: ' + lookById(it.s.look).name }) : null, el('span', { class: 'dock-why', text: it.why }),
        el('button', { class: 'btn sm primary', type: 'button', disabled: AG.busy || null, onclick: () => { ideaPeek(null); doIdea(p, it); } }, 'Do this edit'))));
    C.append(d); if (AG.peek && AG.ideas.includes(AG.peek)) ideaPeek(AG.peek);
  }
  function ideaPeek(it) {
    AG.peek = it || null; const fr = document.getElementById('frame'); if (!fr) return; let im = document.getElementById('peekImg');
    if (!it) { if (im) im.remove(); return; }
    if (!im) { im = el('img', { id: 'peekImg', class: 'peek-img', alt: '' }); fr.append(im); }
    im.src = it.url; im.alt = 'Preview: ' + it.title;
  }
  function renderRight() {
    setTimeout(ideasDock, 0);
    const R = $('right'); R.innerHTML = '';
    const p = activePhoto();
    if (S.mod === 'library') { R.append(infoPanel(p)); return; }
    if (S.mod === 'export') { R.append(exportHelp()); return; }
    if (!p) { R.append(agentPanel(null)); return; }
    if (S.tool === 'crop') { R.append(cropPanel(p)); return; }
    if (S.manual) R.append(agentPanel(p), actionsPanel(p), basicPanel(p), curvePanel(p), lightPanel(p), retouchPanel(p), hslPanel(p), skyPanel(p), removePanel(p), effectsPanel(p));
    else R.append(agentPanel(p), basicPanel(p), curvePanel(p), lightPanel(p), retouchPanel(p), hslPanel(p), skyPanel(p), effectsPanel(p));
  }
  function infoPanel(p) {
    const box = el('section', { class: 'sec' }, el('div', { class: 'sec-h' }, el('h2', { text: 'Photo' })));
    if (!p) { box.append(el('p', { class: 'note', text: 'Select a photo.' })); return box; }
    box.append(el('div', { class: 'row' },
      el('button', { class: 'btn sm', type: 'button', 'aria-pressed': p.pick === 1, onclick: () => { p.pick = p.pick === 1 ? 0 : 1; persist(p); updateCell(p); renderLeft(); renderRight(); } }, p.pick === 1 ? '⚑ Picked' : '⚑ Pick'),
      el('button', { class: 'btn sm', type: 'button', onclick: () => { p.pick = p.pick === -1 ? 0 : -1; persist(p); updateCell(p); renderLeft(); renderRight(); } }, p.pick === -1 ? '✕ Rejected' : '✕ Reject'),
      el('span', { class: 'row', style: 'gap:2px' }, ...[1, 2, 3, 4, 5].map(n => el('button', { class: 'btn ghost sm', type: 'button', 'aria-label': `${n} stars`, style: `padding:2px 3px;color:${p.rating >= n ? 'var(--star)' : 'var(--faint)'}`, onclick: () => { p.rating = p.rating === n ? 0 : n; persist(p); updateCell(p); renderLeft(); renderRight(); }, text: '★' })))));
    const tm = p.time ? new Date(p.time).toLocaleString() : 'Unknown';
    box.append(el('dl', { class: 'kv' }, el('dt', { text: 'File' }), el('dd', { text: p.name }), el('dt', { text: 'Size' }), el('dd', { text: p.W ? `${p.W} × ${p.H}` : '…' }), el('dt', { text: 'Captured' }), el('dd', { text: tm })));
    if (p.state === 'error') box.append(el('div', { class: 'msg err', text: p.err }));
    if (p.an) {
      const sh = S.photos.filter(q => q.an).map(q => q.an.sharp).sort((a, b) => a - b), rank = sh.findIndex(v => v >= p.an.sharp) / Math.max(1, sh.length - 1);
      const notes = [];
      if (p.best) notes.push(['Best of similar', 'Sharpest of its burst' + (p.eyes ? ' with eyes open' : '') + '.']);
      if (p.flags.dup) notes.push(['Similar frame', 'A near-identical frame looks stronger.']);
      if (p.flags.soft) notes.push(['Possibly soft', p.flags.softer ? 'Noticeably softer than similar frames.' : 'Less detail than most of this shoot. Ignore if the blur is intentional.']);
      if (p.flags.blown) notes.push(['Bright', `${Math.round(p.an.blown * 100)}% of the frame is pure white.`]);
      if (p.flags.dark) notes.push(['Dark', 'Much of the frame is near black.']);
      if (p.eyes) notes.push(['Eyes check', p.eyes.people ? `${p.eyes.people} face${p.eyes.people > 1 ? 's' : ''}; ${p.eyes.closed ? `${p.eyes.closed} with eyes closed` : 'eyes open'}${p.eyes.intentional ? `; ${p.eyes.intentional} closed on purpose` : ''}.${p.eyes.note ? ' ' + p.eyes.note : ''}` : 'No faces found.']);
      box.append(el('div', { class: 'callout' }, el('div', { class: 'row', style: 'justify-content:space-between' }, el('b', { text: 'Sharpness' }), el('span', { class: 'note', text: `sharper than ${Math.round(rank * 100)}% of this shoot` })), el('div', { class: 'meter' }, el('i', { style: `width:${Math.round(rank * 100)}%` })),
        ...notes.map(([a, b]) => el('div', null, el('b', { text: a + ': ' }), b))));
      if (p.group) {
        const g = S.photos.filter(q => q.group === p.group).sort((a, b) => (a.time ?? a.order) - (b.time ?? b.order));
        box.append(el('div', { class: 'sec' }, el('div', { class: 'sec-h' }, el('h2', { text: `Similar frames (${g.length})` })),
          el('div', { class: 'mini-thumbs' }, ...g.map(q => el('button', { type: 'button', class: q.id === p.id ? 'cur' : '', title: q.name, onclick: e => clickPhoto(q, e) }, el('img', { src: q.thumb, alt: q.name }), q.best ? el('span', { class: 'b', text: 'BEST' }) : null)))));
      }
    }
    box.append(el('button', { class: 'btn primary', type: 'button', onclick: () => setMod('develop') }, 'Edit in Develop'));
    return box;
  }
  /* AI mode: the left side only says which style the AI should work toward; the AI puts it on itself */
  function styleChooser() {
    const p = activePhoto(), box = el('section', { class: 'sec' });
    box.append(el('div', { class: 'sec-h' }, el('h2', { text: 'Style for the AI' })), el('p', { class: 'note', text: 'Pick the look the AI should edit toward. It puts the look on and fine-tunes it while you watch.' }));
    const pick = id => { AG.style = id; lsSet('lookmatch.agentStyle', id || ''); renderLeft(); };
    const list = el('div', { class: 'looks', role: 'radiogroup', 'aria-label': 'Style for the AI' });
    const card = (id, name, meta, art) => el('button', { type: 'button', class: 'look stylepick' + ((AG.style || null) === id ? ' on' : ''), role: 'radio', 'aria-checked': String((AG.style || null) === id), onclick: () => pick(id) }, art, el('div', { style: 'min-width:0' }, el('div', { class: 'nm', text: name }), el('div', { class: 'mt', text: meta })), el('span'));
    list.append(card(null, 'Your style notes only', 'No look, just what you wrote', el('div', { style: 'width:58px;height:34px;border-radius:6px;background:repeating-linear-gradient(45deg,#2c2d33 0 6px,#25262b 6px 12px)' })));
    for (const L of S.looks) { if (L.sample) continue; let cv; if (L.doc && L.doc.cover) cv = el('img', { src: L.doc.cover, alt: '', style: 'width:58px;height:34px;object-fit:cover;border-radius:6px;display:block' }); else { cv = el('canvas'); drawSwatch(cv, L.look); }
      const st = L.look.stats || {}; list.append(card(L.id, L.name, `${st.refs || st.pairs || 1} example${(st.refs || st.pairs || 1) > 1 ? 's' : ''}${L.creative ? ', creative' : ''}`, cv)); }
    box.append(list);
    if (p && p.s.look) box.append(slider(p, 'lookAmt', 'Look strength', 0, 150, { def: 100, fmt: v => v + '%' }));
    return box;
  }
  /* ================= AI editor: Claude looks at the photo, moves the sliders, looks at the result, and repeats ================= */
  const AG = { approveEach: (() => { try { return localStorage.getItem('lookmatch.approveEach') !== '0'; } catch (e) { return true; } })(), handRetouch: false /* dodge & burn paused: skin smoothing first */, busy: false, msg: null, text: '', refs: [], notMine: true, refLookId: null, building: false };
  const AGENT_KEYS = { temp: [-100, 100], tint: [-100, 100], ev: [-3, 3], subjLight: [0, 200], skinMatch: [0, 100], skinSmooth: [0, 100], beautify: [0, 100], bgEdit: [0, 100],
    contrast: [-100, 100], highlights: [-100, 100], shadows: [-100, 100], whites: [-100, 100], blacks: [-100, 100], vibrance: [-100, 100], saturation: [-100, 100],
    pop: [0, 100], dodgeBurn: [0, 100], clarity: [-100, 100], dehaze: [-100, 100], vignette: [-100, 100], grain: [0, 100], sharpen: [0, 100],
    bgBlur: [0, 100], bokeh: [0, 100], lookAmt: [0, 150], skyExp: [-100, 100], skySat: [-100, 100], skyTemp: [-100, 100], angle: [-15, 15], faceLight: [0, 100], studioLight: [0, 100], noise: [0, 100], heal: [0, 100], shine: [0, 100], faceSlim: [0, 100], jaw: [0, 100], eyesBig: [0, 100], bodySlim: [0, 100], faceRestore: [0, 100], eyes: [0, 100], teeth: [0, 100], fabric: [0, 100], flyaways: [0, 100], studioWarm: [-100, 100], studioX: [0, 1000], studioY: [0, 1000], rescue: [0, 100], glow: [0, 100], flare: [0, 100], flareX: [0, 1000], flareY: [0, 1000], flareWarm: [0, 100] };
  const CAT_KEYS = { studioDir: ['top', 'bottom', 'left', 'right', 'front', 'spot'], studioTarget: ['person', 'background', 'both'] };
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { } };
  S.manual = lsGet('lookmatch.manual', '0') === '1'; AG.style = lsGet('lookmatch.agentStyle', '') || null; AG.area = lsGet('lookmatch.area', 'gentle'); AG.strength = lsGet('lookmatch.strength', 'light');
  S.styleNotes = lsGet('lookmatch.styleNotes', 'Make the people pop and stand out: bright, glowing, even skin with its true colour (deep skin rich, never ashy or orange). Clean white dresses and shirts. Vibrant, clear, clean, smooth. Keep background lights golden, never blown to white or gray. No halos or glow around people.');
  const sleep0 = ms => new Promise(r => setTimeout(r, ms));
  // while the AI editor is paused, every one of its waits holds here, so it stops mid-move and carries on from the same spot
  async function waitPause() { if (!AG.paused) return; holoNote('PAUSED'); while (AG.paused && !(S.busy && S.busy.stop)) await sleep0(200); holoNote(''); }
  const sleep = async ms => { await sleep0(ms); if (AG.paused) await waitPause(); };
  function holoFace() {
    // the AI's presence: an original instrument-style core (rings, ticks and a voice line), calm and grown-up rather than a cartoon face
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 120 120'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'holo-svg core');
    let ticks = ''; for (let i = 0; i < 60; i++) { const a = i / 60 * Math.PI * 2, r1 = i % 5 ? 47 : 44.5, r2 = 49; ticks += `<line x1="${(60 + r1 * Math.cos(a)).toFixed(2)}" y1="${(60 + r1 * Math.sin(a)).toFixed(2)}" x2="${(60 + r2 * Math.cos(a)).toFixed(2)}" y2="${(60 + r2 * Math.sin(a)).toFixed(2)}"/>`; }
    let bars = ''; for (let i = 0; i < 9; i++) { const x = 45 + i * 3.75, h = [3, 6, 10, 14, 17, 14, 10, 6, 3][i]; bars += `<rect class="cw cw${i}" x="${(x - 0.9).toFixed(2)}" y="${(60 - h / 2).toFixed(2)}" width="1.8" height="${h}" rx=".9" style="--d:${(i * 0.07).toFixed(2)}s"/>`; }
    svg.innerHTML = `<defs><radialGradient id="cg" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#3fe0c5" stop-opacity=".22"/><stop offset=".6" stop-color="#8f7cff" stop-opacity=".08"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
        <linearGradient id="cl" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#bff6ec"/><stop offset="1" stop-color="#a99cff"/></linearGradient></defs>
      <circle cx="60" cy="60" r="56" fill="url(#cg)"/>
      <g class="core-ticks" stroke="#bff6ec" stroke-opacity=".55" stroke-width=".8">${ticks}</g>
      <g class="core-outer"><circle cx="60" cy="60" r="53" fill="none" stroke="url(#cl)" stroke-width="1.2" stroke-dasharray="26 7 4 7" stroke-opacity=".8"/></g>
      <g class="core-mid"><circle cx="60" cy="60" r="38" fill="none" stroke="#8f7cff" stroke-width="2.2" stroke-dasharray="40 18 10 18" stroke-opacity=".75"/></g>
      <g class="core-inner"><circle cx="60" cy="60" r="29" fill="none" stroke="#ffb45c" stroke-width="1.4" stroke-dasharray="14 168" stroke-linecap="round"/><circle cx="60" cy="60" r="29" fill="none" stroke="#3fe0c5" stroke-width=".7" stroke-opacity=".5"/></g>
      <g class="core-sweep"><path d="M60 60 L60 22 A38 38 0 0 1 86.9 33.1 Z" fill="#3fe0c5" fill-opacity=".10"/></g>
      <circle cx="60" cy="60" r="21" fill="#101217" fill-opacity=".85" stroke="#bff6ec" stroke-opacity=".35" stroke-width=".8"/>
      <g class="holo-pupils"><circle class="core-focus" cx="60" cy="60" r="2.2" fill="#ffd08a"/></g>
      <g class="core-wave" fill="url(#cl)">${bars}</g>`;
    return svg;
  }
  /* the core's colour shows where things stand: amber while photos are coming in, red while the AI is editing, green when it's ready / done */
  function corePhase(ph) { AG.phase = ph || null; const h = document.getElementById('agHolo'); if (h) { if (ph) h.dataset.phase = ph; else delete h.dataset.phase; } }
  function setAgent(state, text) {
    if (state) AG.state = state; if (text != null) AG.sayText = text;
    const h = document.getElementById('agHolo'); if (h) h.dataset.state = AG.state || 'idle';
    const b = document.getElementById('agSay'); if (b && text != null) { b.textContent = text; b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
    if (text && state === 'adjust') { AG.now = text.replace(/\. .*$/, ''); hudUpdate(); }
    if (text) holoLog(text);
    if (text) { AG.log = (AG.log || []).concat(text).slice(-6); const lg = document.getElementById('agLog'); if (lg) { lg.innerHTML = ''; for (const t of AG.log.slice(0, -1)) lg.append(el('li', { text: t })); } }
  }
  /* live status bar while the AI works: which step it is on, what it is moving right now, and buttons to watch the photo or the sliders */
  const HUD_STEPS = [['fix', 'Fix'], ['wb', 'White balance'], ['color', 'Color'], ['skin', 'Skin'], ['retouch', 'Retouch'], ['light', 'Light']].filter(([id]) => id !== 'retouch' || AG.handRetouch !== false);
  function hudShow(on) {
    let h = document.getElementById('agHud');
    if (!on) { if (h) h.remove(); return; }
    if (!h) {
      h = el('div', { id: 'agHud', class: 'ag-hud', role: 'status', 'aria-live': 'polite' },
        el('div', { class: 'hud-top' }, el('span', { class: 'hud-dot', 'aria-hidden': 'true' }), el('b', { id: 'hudStep', text: 'Starting' }), el('span', { class: 'hud-eta', id: 'hudEta' }),
          el('div', { class: 'hud-btns' }, el('button', { type: 'button', class: 'hud-b hud-pause', id: 'hudPause', onclick: () => { AG.paused = !AG.paused; hudBtns(); setAgent(AG.paused ? 'idle' : 'look', AG.paused ? 'Paused. Press Continue and I pick up right here.' : 'Carrying on.'); } }, 'Pause'),
            el('button', { type: 'button', class: 'hud-b hud-stop', id: 'hudStopB', onclick: () => { if (S.busy) S.busy.stop = true; AG.paused = false; hudBtns(); setAgent('talk', 'Stopping. Continue edit picks up from here.'); } }, 'Stop'),
            el('button', { type: 'button', class: 'hud-b', id: 'hudPhoto', onclick: () => { AG.follow = false; hudBtns(); const f = document.getElementById('stage') || document.getElementById('frame'); (f || document.body).scrollIntoView({ block: 'start', behavior: 'smooth' }); } }, 'Watch photo'),
            el('button', { type: 'button', class: 'hud-b', id: 'hudSliders', onclick: () => { AG.follow = true; hudBtns(); const r = document.querySelector('.sl.ai-touch') || document.querySelector('.right .agent'); r && r.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }, 'Watch sliders'))),
        el('ol', { class: 'hud-steps', id: 'hudSteps' }, ...HUD_STEPS.map(([id, n]) => el('li', { 'data-step': id, text: n }))),
        el('p', { class: 'hud-now', id: 'hudNow', text: '' }), el('div', { class: 'hud-approve', id: 'hudApprove', hidden: true }));
      document.body.append(h);
    }
    hudUpdate(); hudBtns();
  }
  function hudBtns() { const pz = document.getElementById('hudPause'); if (pz) { pz.textContent = AG.paused ? 'Continue' : 'Pause'; pz.setAttribute('aria-pressed', AG.paused ? 'true' : 'false'); } document.body.classList.toggle('ai-paused', !!AG.paused); const a = document.getElementById('hudPhoto'), b = document.getElementById('hudSliders'); if (a) a.setAttribute('aria-pressed', AG.follow === false ? 'true' : 'false'); if (b) b.setAttribute('aria-pressed', AG.follow === false ? 'false' : 'true'); }
  function hudUpdate() {
    const h = document.getElementById('agHud'); if (!h) return;
    const cur = AG.stageId, idx = HUD_STEPS.findIndex(x => x[0] === cur);
    const st = document.getElementById('hudStep'); if (st) st.textContent = AG.hudTitle || (idx >= 0 ? `Step ${idx + 1} of ${HUD_STEPS.length}: ${HUD_STEPS[idx][1]}` : 'Getting ready');
    h.querySelectorAll('.hud-steps li').forEach((li, i) => { li.classList.toggle('now', i === idx); li.classList.toggle('done', idx >= 0 && i < idx); if (i === idx) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
    const nw = document.getElementById('hudNow'); if (nw) nw.textContent = AG.now || '';
    const e = document.getElementById('hudEta'), src = document.getElementById('agEta'); if (e) e.textContent = src ? src.textContent : '';
  }
  function hudStage(id, title) { AG.stageId = id; AG.hudTitle = title || null; hudUpdate(); }
  /* the editor hands the photo back for approval, the way a hired retoucher would */
  function askApprove(p, i, n) { return new Promise(res => { const box = document.getElementById('hudApprove'); if (!box) return res('approve');
    corePhase('done'); holoStage('AWAITING APPROVAL'); hudStage(null, `Photo ${i + 1} of ${n}: ready for review`); setAgent('talk', `Photo ${i + 1} of ${n} is done. Take a look: approve it, or have me redo it.`);
    const done = v => { box.hidden = true; box.innerHTML = ''; corePhase('work'); res(v); };
    holoShow(false);
    box.innerHTML = ''; box.append(el('span', { text: `Photo ${i + 1} of ${n} ready for review` }),
      el('button', { type: 'button', class: 'hud-b', onclick: () => previewFull(p) }, 'Preview full size'),
      el('button', { type: 'button', class: 'hud-b', onclick: async e => { const b = e.target; b.disabled = true; b.textContent = 'Preparing…'; try { const c = await fullRender(p, 4096), bl = await toBlob(c, 0.92); c.width = c.height = 0; await offerFile(p.name.replace(/\.[^.]+$/, '') + '.jpg', bl); } catch (err) { toast('Could not prepare the download: ' + (err.message || err)); } b.disabled = false; b.textContent = 'Download'; } }, 'Download'),
      el('button', { type: 'button', class: 'hud-b hud-ok', onclick: () => done('approve') }, i + 1 < n ? 'Approve & next' : 'Approve'),
      el('button', { type: 'button', class: 'hud-b', onclick: () => done('redo') }, 'Redo this photo'),
      el('button', { type: 'button', class: 'hud-b hud-stop', onclick: () => done('stop') }, 'Stop here'));
    box.hidden = false; const f = document.getElementById('stage') || document.getElementById('frame'); f && f.scrollIntoView({ block: 'start', behavior: 'smooth' }); box.querySelector('.hud-ok').focus({ preventScroll: true }); }); }
  /* the finished photo at full quality, the way it will export */
  async function fullRender(p, long) { const bmp = await decode(p.file), L = p.s.look ? lookById(p.s.look) : null;
    const r = await P.process({ src: bmp, SW: bmp.width, SH: bmp.height, s: p.s, look: L ? L.look : null, lookKey: L ? L.id + ':' + (L.rev || 0) : '', id: p.id + 'F', maxLong: long, full: true, fullW: Math.max(bmp.width, bmp.height), brush: p.brush, subj: p.subj, rm: p.rm });
    bmp.close && bmp.close(); return r.canvas; }
  /* full-size preview before approving: fit or 100%, and hold to see the original */
  async function previewFull(p) {
    const ov = el('div', { class: 'pv-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Full size preview' }), close = () => { ov.remove(); document.removeEventListener('keydown', onk); }, onk = e => { if (e.key === 'Escape') close(); };
    const img = el('img', { class: 'pv-img', alt: 'Edited photo, full size' }), msg = el('p', { class: 'pv-msg', text: 'Rendering at full quality…' });
    const zoom = el('button', { type: 'button', class: 'hud-b', onclick: () => { ov.classList.toggle('zoom'); zoom.textContent = ov.classList.contains('zoom') ? 'Fit to screen' : 'View 100%'; } }, 'View 100%');
    const hold = el('button', { type: 'button', class: 'hud-b' }, 'Hold for original'); let edited = null, orig = null;
    const show = o => { if (o && orig) img.src = orig; else if (edited) img.src = edited; };
    hold.onpointerdown = () => show(true); hold.onpointerup = hold.onpointerleave = () => show(false);
    ov.append(el('div', { class: 'pv-bar' }, el('b', { text: p.name }), zoom, hold, el('button', { type: 'button', class: 'hud-b hud-ok', onclick: close }, 'Close')), el('div', { class: 'pv-scroll' }, msg, img));
    document.body.append(ov); document.addEventListener('keydown', onk);
    try { const c = await fullRender(p, 4096); edited = URL.createObjectURL(await toBlob(c, 0.92)); c.width = c.height = 0; show(false); msg.remove();
      const ob = await decode(p.file), oc = scaled(ob, ob.width, ob.height, 4096); orig = URL.createObjectURL(await toBlob(oc, 0.9)); oc.width = oc.height = 0; } catch (e) { msg.textContent = 'Could not render the preview.'; }
  }
  /* ---------- light up the part of the photo the editor is working on ---------- */
  const FOCUS = { skinSmooth: 'skin', beautify: 'skin', heal: 'skin', shine: 'face', skinMatch: 'skin', faceRestore: 'face', faceLight: 'face', faceSlim: 'face', jaw: 'face', eyesBig: 'eyes', eyes: 'eyes', teeth: 'mouth',
    subjLight: 'person', pop: 'person', dodgeBurn: 'person', studioLight: 'person', studioWarm: 'person', bodySlim: 'person', fabric: 'fabric', flyaways: 'hair', bgBlur: 'bg', bokeh: 'bg', bgEdit: 'bg',
    skyExp: 'sky', skySat: 'sky', skyTemp: 'sky', shadows: 'dark', blacks: 'dark', rescue: 'dark', noise: 'dark', highlights: 'bright', whites: 'bright', glow: 'bright', vignette: 'edges' };
  const FOCUS_NAME = { skin: 'SKIN', face: 'FACES', eyes: 'EYES', mouth: 'SMILE', person: 'SUBJECTS', fabric: 'CLOTHING', hair: 'HAIR EDGE', bg: 'BACKGROUND', sky: 'SKY', dark: 'SHADOWS', bright: 'HIGHLIGHTS', edges: 'FRAME EDGES', all: 'WHOLE IMAGE' };
  async function holoMasks(p) {
    const key = JSON.stringify(p.s.people || null); if (p._hm && p._hm.key === key) return p._hm;
    const sb = await smallSource(p), c = scaled(sb, sb.width, sb.height, 320), w = c.width, h = c.height, d = c.getContext('2d').getImageData(0, 0, w, h).data, small = D.smallFrom(d, w, h, 320), n = small.w * small.h, M = { w: small.w, h: small.h };
    const Y = new Float32Array(n); for (let i = 0; i < n; i++) Y[i] = 0.299 * small.rgb[3 * i] + 0.587 * small.rgb[3 * i + 1] + 0.114 * small.rgb[3 * i + 2];
    M.dark = Y.map(v => Math.max(0, Math.min(1, (0.3 - v) / 0.18))); M.bright = Y.map(v => Math.max(0, Math.min(1, (v - 0.6) / 0.2)));
    M.edges = new Float32Array(n); for (let y = 0; y < small.h; y++) for (let x = 0; x < small.w; x++) { const u = x / small.w - 0.5, v = y / small.h - 0.5; M.edges[y * small.w + x] = Math.max(0, Math.min(1, (Math.hypot(u, v) - 0.4) / 0.25)); }
    try { const sk = D.skyMask(small); M.sky = sk && sk.mask ? sk.mask : null; } catch (e) { M.sky = null; }
    if (p.s.people && p.s.people.length) { try { const pm = D.peopleMasks(small, P.boxMaps(p.s.people, null, sb.width, sb.height, small.w, small.h), null);
        M.person = pm.person; M.skin = pm.skinTight; M.face = pm.face; M.hair = pm.hair; M.bg = pm.person.map(v => 1 - v);
        M.fabric = pm.person.map((v, i) => Math.max(0, Math.min(1, v * 1.2) - Math.min(1, pm.skin[i] * 2) - (pm.hair ? Math.min(1, pm.hair[i] * 2) : 0)));
        const dots = k => { const a = new Float32Array(n); for (const q of p.s.people) { const pts = k === 'eyes' ? [q.lm && q.lm.le, q.lm && q.lm.re] : [q.lm && q.lm.m]; const fw = q.f ? (q.f[2] - q.f[0]) * small.w : 20;
            for (const t of pts) if (t) { const cx = t[0] * small.w, cy = t[1] * small.h, r = Math.max(3, (k === 'eyes' ? 0.13 : 0.22) * fw); for (let y = Math.max(0, cy - r | 0); y < Math.min(small.h, cy + r); y++) for (let x = Math.max(0, cx - r | 0); x < Math.min(small.w, cx + r); x++) { const dd = Math.hypot(x - cx, (y - cy) * (k === 'eyes' ? 1.6 : 1.4)) / r; if (dd < 1) a[y * small.w + x] = Math.max(a[y * small.w + x], 1 - dd * dd); } } } return a; };
        M.eyes = dots('eyes'); M.mouth = dots('mouth'); } catch (e) { } }
    M.key = key; p._hm = M; return M;
  }
  async function holoFocus(p, k) {
    const h = document.getElementById('holoLayer'); if (!h) return; let cv = document.getElementById('hlMask'); if (!cv) { cv = el('canvas', { id: 'hlMask', class: 'hl-mask' }); h.prepend(cv); }
    const lab = document.getElementById('hlTarget') || (() => { const e = el('div', { id: 'hlTarget', class: 'hl-target' }); h.append(e); return e; })();
    if (!k) { cv.classList.remove('on'); lab.classList.remove('on'); return; }
    if (p.s.crop || p.s.rot || p.s.angle || p.s.flipH) return;
    let kind = FOCUS[k] || 'all'; if (k === 'studioLight' && p.s.studioTarget === 'background') kind = 'bg'; else if (k === 'studioLight' && p.s.studioTarget === 'both') kind = 'all';
    lab.textContent = 'WORKING ON: ' + FOCUS_NAME[kind]; lab.classList.add('on');
    if (kind === 'all') { cv.classList.remove('on'); holoStage(AG.hudTitle || ''); return; }
    let M; try { M = await holoMasks(p); } catch (e) { return; } const m = M[kind]; if (!m) { cv.classList.remove('on'); return; }
    cv.width = M.w; cv.height = M.h; const x = cv.getContext('2d'), id = x.createImageData(M.w, M.h);
    for (let i = 0; i < m.length; i++) { const v = Math.max(0, Math.min(1, m[i])); id.data[4 * i] = 95; id.data[4 * i + 1] = 246; id.data[4 * i + 2] = 255; id.data[4 * i + 3] = Math.round(v * 120); }
    x.putImageData(id, 0, 0); cv.classList.remove('on'); void cv.offsetWidth; cv.classList.add('on');
  }
  /* ---------- the holographic layer over the photo while the AI works ---------- */
  function holoShow(on, p) {
    let h = document.getElementById('holoLayer'); const fr = document.getElementById('frame');
    if (!on) { if (h) h.remove(); return; } if (!fr) return;
    if (!h) { h = el('div', { id: 'holoLayer', class: 'holo-layer', 'aria-hidden': 'true' },
        el('i', { class: 'hl-corner tl' }), el('i', { class: 'hl-corner tr' }), el('i', { class: 'hl-corner bl' }), el('i', { class: 'hl-corner br' }),
        el('div', { class: 'hl-grid' }), el('div', { class: 'hl-sweep' }), el('div', { class: 'hl-faces', id: 'hlFaces' }),
        el('div', { class: 'hl-panel' }, el('div', { class: 'hl-title', id: 'hlStage', text: 'INITIALISING' }), el('ul', { class: 'hl-log', id: 'hlLog' })),
        el('div', { class: 'hl-note', id: 'hlNote' }), el('div', { class: 'hl-ticks' })); }
    if (h.parentNode !== fr) fr.append(h);
    const fc = h.querySelector('#hlFaces'); fc.innerHTML = '';
    if (p && p.s.people && !p.s.crop && !p.s.rot && !p.s.angle && !p.s.flipH) p.s.people.forEach((q, k) => { if (!q.f) return; const [a, b, c, d] = q.f;
      fc.append(el('div', { class: 'hl-face', style: `left:${a * 100}%;top:${b * 100}%;width:${(c - a) * 100}%;height:${(d - b) * 100}%;animation-delay:${k * 0.25}s` }, el('span', { text: `SUBJECT ${String(k + 1).padStart(2, '0')}` }))); });
  }
  function holoStage(t) { const e = document.getElementById('hlStage'); if (e) e.textContent = String(t || '').toUpperCase(); const h = document.getElementById('holoLayer'); if (h) { h.classList.remove('scan'); void h.offsetWidth; h.classList.add('scan'); } }
  function holoLog(t) { const ul = document.getElementById('hlLog'); if (!ul) return; const li = el('li', { text: '› ' + String(t).replace(/\. .*$/, '').slice(0, 64) }); ul.prepend(li); while (ul.children.length > 5) ul.lastChild.remove(); }
  function holoNote(t) { const e = document.getElementById('hlNote'); if (e) { e.textContent = t; e.classList.toggle('on', !!t); } }
  // a person scrolling the page takes over: the AI stops pulling the screen to its sliders until they press "Watch sliders"
  { const off = () => { if (AG.busy && !AG.autoScrolling) { if (AG.follow !== false) { AG.follow = false; hudBtns(); } } };
    window.addEventListener('touchmove', off, { passive: true }); window.addEventListener('wheel', off, { passive: true }); }
  function lookAt(x, y) {   // the hologram's eyes follow its hand
    const h = document.getElementById('agHolo'); if (!h) return; const r = h.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height * 0.5;
    const dx = x - cx, dy = y - cy, d = Math.max(1, Math.hypot(dx, dy)); h.style.setProperty('--lx', (dx / d * 12).toFixed(2) + 'px'); h.style.setProperty('--ly', (dy / d * 12).toFixed(2) + 'px');
  }
  function ghost() { let g = document.getElementById('agHand'); if (!g) { g = el('div', { id: 'agHand', class: 'ag-hand', 'aria-hidden': 'true' }); g.innerHTML = '<svg class="hand-svg" viewBox="0 0 64 64"><path d="M22 34V12a4 4 0 0 1 8 0v16-6a4 4 0 0 1 8 0v6-3a4 4 0 0 1 8 0v4-1a4 4 0 0 1 8 0v14c0 9-6 16-16 16h-4c-6 0-10-3-13-8l-7-12a4 4 0 0 1 7-4z"/></svg><i class="hand-ring"></i><i class="hand-brush"></i>'; document.body.append(g); } return g; }
  async function handTo(x, y, ms) { const g = ghost(); g.classList.add('on'); g.style.transitionDuration = (ms || 450) + 'ms'; g.style.transform = `translate(${x}px, ${y}px)`; lookAt(x, y); await sleep((ms || 450) + 40); }
  function handOff() { const g = document.getElementById('agHand'); if (g) g.classList.remove('on', 'press', 'brush'); const h = document.getElementById('agHolo'); if (h) { h.style.setProperty('--lx', '0px'); h.style.setProperty('--ly', '0px'); } }
  /* move one slider on screen, the way a person would drag it; the photo re-renders as it moves */
  const SLIDER_NAMES = { faceSlim: 'Slim face', jaw: 'Jawline', eyesBig: 'Bigger eyes', bodySlim: 'Slim body', faceRestore: 'Face restore', eyes: 'Eyes', teeth: 'Teeth', fabric: 'Fabric wrinkles', flyaways: 'Flyaway hair', studioWarm: 'Light colour', studioX: 'Light across', studioY: 'Light height', heal: 'Blemish heal', shine: 'Shine control', rescue: 'Night rescue', glow: 'Glow', flare: 'Sun flare', flareX: 'Flare across', flareY: 'Flare height', flareWarm: 'Flare warmth', skinSmooth: 'Skin smoothing', ev: 'Exposure', faceLight: 'Face light', studioLight: 'Studio light', noise: 'Noise reduction', temp: 'Temperature', tint: 'Tint', subjLight: 'Subject light', skinMatch: 'Skin match', skinSmooth: 'Skin smoothing', beautify: 'Beautify', bgEdit: 'Background edit', contrast: 'Contrast', highlights: 'Highlights', shadows: 'Shadows', whites: 'Whites', blacks: 'Blacks', vibrance: 'Vibrance', saturation: 'Saturation', pop: 'Pop', dodgeBurn: 'Dodge & burn', clarity: 'Clarity', dehaze: 'Dehaze', vignette: 'Vignette', grain: 'Grain', sharpen: 'Sharpening', bgBlur: 'Background blur', bokeh: 'Bokeh lights', lookAmt: 'Look strength', skyExp: 'Sky brightness', skySat: 'Sky saturation', skyTemp: 'Sky warmth', angle: 'Straighten' };
  async function dragSlider(p, key, target, opts) {
    opts = opts || {};
    let inp = document.getElementById(opts.id || 'sl-' + key);
    if (!inp) { change(s => { if (opts.set) opts.set(s, target); else s[key] = target; }, { all: [p] }); return; }
    const det = inp.closest('details'); if (det && !det.open) { det.open = true; await sleep(120); }
    const follow = AG.follow !== false;
    if (follow) { AG.autoScrolling = true; inp.scrollIntoView({ block: 'center', behavior: 'smooth' }); await sleep(380); AG.autoScrolling = false; }
    else { const r0 = inp.getBoundingClientRect(); if (r0.bottom < 0 || r0.top > innerHeight) { /* off screen: the value still moves (the photo updates live), just without the hand */
        const min = +inp.min, max = +inp.max, from = +inp.value, to = Math.max(min, Math.min(max, target)), dur = 700, t0 = performance.now();
        AG.dragging = true; try { for (let i = 1; i <= 4; i++) { inp.value = from + (to - from) * i / 4; inp.dispatchEvent(new Event('input', { bubbles: true })); await sleep(90); await renderIdle(3000); } } finally { AG.dragging = false; }
        inp.value = to; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); await renderIdle(6000); return; } }
    const row = inp.closest('.sl'); row && row.classList.add('ai-touch'); if (AG.busy) holoFocus(p, key);
    const min = +inp.min, max = +inp.max, from = +inp.value, to = Math.max(min, Math.min(max, target));
    const pos = v => { const r = inp.getBoundingClientRect(); return [r.left + 7 + (v - min) / (max - min) * (r.width - 14), r.top + r.height / 2]; };
    let [x0, y0] = pos(from); await handTo(x0, y0, 420); ghost().classList.add('press'); await sleep(140);
    // moved in steps, and each step waits until the photo has redrawn, so the change is visible on the photo as it happens (also on a slow phone)
    AG.dragging = true; const N = Math.max(3, Math.min(5, Math.round(2 + Math.abs(to - from) / (max - min) * 10)));
    try { for (let i = 1; i <= N; i++) { const t = i / N, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2, v = from + (to - from) * e;
        const g = ghost(), [x, y] = pos(v); g.style.transitionDuration = '220ms'; g.style.transform = `translate(${x}px, ${y}px)`; lookAt(x, y);
        inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true })); await sleep(90); await renderIdle(1800); } }
    finally { AG.dragging = false; }
    inp.value = to; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
    ghost().classList.remove('press'); await renderIdle(6000); await sleep(200); row && row.classList.remove('ai-touch');
  }
  /* what the AI may change: the subject only (background stays exactly as shot), the subject with the background kept close to as shot, or the whole photo */
  const AREA_TEXT = { subject: 'SUBJECT ONLY: edit the people only. The background must stay exactly as shot: bgEdit is fixed at 0, no background blur, no bokeh, studio light on the person only.',
    gentle: 'SUBJECT FIRST: the people get the edit; keep the background close to how it was shot. bgEdit at most 30, bokeh at most 15. Never brighten background lights or make them bigger.',
    whole: 'WHOLE PHOTO: you may edit the background as much as the style needs, but background lights should never overpower the people.' };
  function areaFix(o) { const m = AG.area || 'gentle';
    if (m === 'subject') { if ('bgEdit' in o) o.bgEdit = 0; for (const k of ['bgBlur', 'bokeh']) if (k in o) o[k] = 0; if ('studioTarget' in o) o.studioTarget = 'person'; }
    else if (m === 'gentle') { if ('bgEdit' in o) o.bgEdit = Math.min(30, o.bgEdit); if ('bokeh' in o) o.bokeh = Math.min(15, o.bokeh); if (o.studioTarget === 'background' || o.studioTarget === 'both') o.studioTarget = 'person'; }
    return o; }
  /* how hard the AI may push: Light touch keeps the photo's own light and mostly smooths and evens (like a beauty filter); Balanced; Bold */
  const STRENGTH = { light: { sharpen: [0, 0], grain: [0, 0], skinSmooth: [55, 85], glow: [0, 20], flare: [0, 25], faceSlim: [0, 30], jaw: [0, 30], eyesBig: [0, 25], bodySlim: [0, 30], faceRestore: [0, 20], noise: [30, 100], ev: [-0.5, 0.25], subjLight: [0, 10], pop: [0, 12], dodgeBurn: [0, 0], clarity: [-25, 0], dehaze: [-20, 5], contrast: [-15, 15], highlights: [-30, 20], shadows: [-20, 20], whites: [-20, 15], blacks: [-20, 10], vibrance: [-15, 12], saturation: [-10, 8], vignette: [-15, 10], skinMatch: [0, 35], beautify: [0, 30], faceLight: [0, 15], studioLight: [0, 10], bokeh: [0, 10], bgBlur: [0, 15] },
    balanced: { sharpen: [0, 6], grain: [0, 0], skinSmooth: [45, 85], glow: [0, 35], flare: [0, 45], faceRestore: [0, 35], noise: [20, 100], ev: [-1, 0.8], subjLight: [0, 30], faceLight: [0, 35], studioLight: [0, 25], pop: [0, 35], dodgeBurn: [0, 0], clarity: [-30, 6], dehaze: [-30, 20], contrast: [-30, 25], highlights: [-60, 40], vibrance: [-30, 20], saturation: [-20, 12], vignette: [-30, 15] }, bold: { sharpen: [0, 30], dodgeBurn: [0, 0] } };
  const STRENGTH_TEXT = { light: 'LIGHT TOUCH: work like a high-end beauty filter. Keep the photo\'s own light, brightness and mood. Smooth and even the skin properly (skinSmooth 50-70 and beautify 30-45 for portraits: no grain or rough texture left on skin), no sharpening (0), clean up colour, and only fix what is actually wrong. Do not raise exposure for dim faces: give them a little faceLight and a soft studioLight on the person instead, so only the people brighten.',
    balanced: 'BALANCED: a clear, polished edit, but natural (smooth skin: skinSmooth 45-70; sharpening 0-6): correct light and colour, flatter the people, nothing that looks processed.', bold: 'BOLD: a strong, stylised edit is fine where the style calls for it, but skin must stay true to each person.' };
  function strengthFix(o) { const L = STRENGTH[AG.strength || 'light'] || {}; for (const k in L) if (k in o && typeof o[k] === 'number') o[k] = Math.max(L[k][0], Math.min(L[k][1], o[k])); if ('editStrength' in o || o.v) o.editStrength = AG.strength || 'light'; return o; }
  async function moveSettings(p, changes, hsl, why) {
    areaFix(changes); strengthFix(changes);
    const keys = Object.keys(changes);
    for (const k of keys) {
      const now = p.s[k] ?? 0, to = changes[k]; if (Math.abs(to - now) < (k === 'ev' || k === 'angle' ? 0.01 : 0.5)) continue;
      setAgent('adjust', `${SLIDER_NAMES[k] || k}: ${fmtV(k, now)} → ${fmtV(k, to)}${why ? '. ' + why : ''}`);
      if (k === 'angle') { change(s => { s.angle = to; }, { all: [p] }); await sleep(700); continue; }
      await dragSlider(p, k, to);
    }
    if (hsl) for (const b of D.HSL_KEYS) { const v = hsl[b]; if (!v) continue;
      for (let t = 0; t < 3; t++) { if (v[t] === p.s.hsl[b][t]) continue;
        if (S.hslTab !== t) { S.hslTab = t; renderRight(); await sleep(150); }
        setAgent('adjust', `${b[0].toUpperCase() + b.slice(1)} ${['hue', 'saturation', 'brightness'][t]}: ${p.s.hsl[b][t]} → ${v[t]}`);
        await dragSlider(p, null, v[t], { id: 'sl-hsl-' + b + t, set: (s, x) => { s.hsl[b][t] = x; } }); } }
  }
  const fmtV = (k, v) => k === 'ev' ? (v > 0 ? '+' : '') + (+v).toFixed(2) : k === 'angle' ? (+v).toFixed(1) + '°' : (v > 0 && AGENT_KEYS[k] && AGENT_KEYS[k][0] < 0 ? '+' : '') + Math.round(v);
  async function renderForAgent(p) {
    const sb = await smallSource(p), L = p.s.look ? lookById(p.s.look) : null;
    const r = await P.process({ src: sb, SW: sb.width, SH: sb.height, s: p.s, look: L ? L.look : null, lookKey: L ? L.id + ':' + (L.rev || 0) : '', id: p.id + 'A', maxLong: 1024, full: true, fullW: Math.max(p.W, p.H), brush: p.brush, subj: p.subj, rm: p.rm });
    p.skinReport = r.skin || null;
    return toBlob(r.canvas, 0.86);
  }
  async function refImages(L, p) {
    if (!L || !L.look || !L.look.refs) return [];
    const refs = L.look.refs; let order = refs.map((_, i) => i);
    try { if (p) { const sb = await smallSource(p), c = scaled(sb, sb.width, sb.height, 400), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, small = D.smallFrom(d, c.width, c.height, 400); c.width = c.height = 0; order = LC.rankRefs(L.look, LC.prepare(small)); } } catch (e) { }
    const out = [];
    for (const i of order) { const r = refs[i], src = r && (r.img || r.thumb); if (!src || out.length >= 3) continue; try { const b = await (await fetch(src)).blob(); if (b && b.size) out.push(b); } catch (e) { } }
    return out;
  }
  /* the editor works in order, one job at a time, and each step may only touch its own settings */
  const STAGES = [
    { id: 'fix', name: 'Fix the image', keys: ['rescue', 'ev', 'highlights', 'shadows', 'whites', 'blacks', 'contrast', 'dehaze', 'angle', 'noise'],
      goal: 'DARK PHOTOS FIRST: if the photo (or the people in it) is very dark, underexposed or a night shot, use rescue (30-80; the darker, the higher) to bring it up by area: it lifts the dark parts and leaves lights, skies and highlights alone, so it stays polished where exposure would wash it out. Keep ev for small overall corrections. Correct the basic exposure only (plus noise reduction if the photo is grainy from high ISO): overall brightness, recover blown highlights, open crushed shadows, set a clean black and white point, remove haze, level a crooked horizon (angle in degrees, only if clearly tilted). Do NOT change colour, white balance, skin or add local light here.' },
    { id: 'wb', name: 'White balance', keys: ['temp', 'tint'],
      goal: 'Set white balance only, for the SKIN: warm, rich and true to its type (deep skin never gray or ashy). The app cleans whites on the people by itself, so do not cool the photo just to whiten the dress. Keep the warmth of the scene if the references are warm.' },
    { id: 'color', name: 'Colour', keys: ['hsl', 'vibrance', 'saturation', 'lookAmt', 'skinMatch', 'skySat', 'skyTemp'],
      goal: 'Colour only: hue, saturation and luminance of each colour family (colour mixer), overall vibrance and saturation, the look strength, and skin colour (skinMatch). Match the colour palette and saturation of the reference photos. Do not change brightness or white balance here.' },
    { id: 'skin', name: 'Skin', keys: ['skinSmooth', 'beautify', 'heal', 'shine', 'eyes', 'teeth', 'fabric', 'flyaways', 'faceRestore', 'faceSlim', 'jaw', 'eyesBig', 'bodySlim', 'blemishes'], skin: true,
      goal: 'Skin, face and finishing retouch only. faceRestore ONLY when a face is clearly out of focus or motion-blurred (then 15-35); leave it at 0 on any face that already looks sharp - this photographer wants smooth, never crisp. Shaping (faceSlim, jaw, eyesBig, bodySlim) changes how a person looks: use it ONLY when the photographer asks for it, and then subtly (10-35). eyes (20-50) clears red in the whites and adds sparkle when eyes are visible; teeth (20-50) when teeth show; fabric (30-70) smooths creases in the dress, suit or shirt when they are visibly wrinkled; flyaways (20-50) only for stray hairs sticking out against a plain or soft background, never on curly or textured hair styles. Use heal (40-80 on portraits) to clear small spots, pimples and red marks on faces, and shine (30-60) when foreheads, noses or cheeks look oily or hot. Set beautify for a polished portrait finish (even skin that keeps its pores, clearer eyes, lifted under-eyes, whiter teeth, soft glow): 40-70 for portraits and close-ups, 20-40 for wider shots, less for men who want a rugged look. Use skinSmooth for extra softness only when the skin is rough (natural, never plastic). List blemishes to remove: small spots, pimples or marks on visible skin only. Touch nothing else.' },
    { id: 'light', name: 'Light', keys: ['faceLight', 'studioLight', 'studioDir', 'studioTarget', 'studioWarm', 'studioX', 'studioY', 'subjLight', 'dodgeBurn', 'pop', 'vignette', 'clarity', 'skyExp', 'bgEdit', 'bgBlur', 'bokeh', 'glow', 'flare', 'flareX', 'flareY', 'flareWarm'],
      goal: 'Light and finish (if hand dodge & burn strokes were already painted, keep dodgeBurn at 20 or less). glow is a soft dreamy bloom on bright areas (0-25 for a light, airy or romantic feel; 0 otherwise). flare adds a sun flare: use it ONLY when the photographer asks for it or a golden-hour backlit shot clearly calls for it; put flareX/flareY (0-1000 of width/height) at or just outside the frame where the sun or main light really is, and flareWarm 40-80 for sunset light. FACE LIGHT FIRST: whenever a face is darker than it should be or lit flat (night, indoor, no flash, backlit, shade), use faceLight (usually 10-30) and a soft studioLight (usually 8-20, studioTarget person, from the side the existing light comes from or front) INSTEAD of raising exposure: they only touch the people, so the background and the mood stay as shot. Only leave them at 0 when the faces are already well lit. Then: studioLight (with studioDir top, bottom, left, right or front, and studioTarget person, background or both) to add a natural soft light; add light on the people where needed (subjLight), sculpt with dodgeBurn, make them stand out (pop), vignette and clarity, sky brightness. Use bgEdit 0 only if editing the background hurts it. Use bgBlur or bokeh only if the reference photos have that look or the photographer asked. Match how bright and glowing the people are in the reference photos.' }];
  const KEY_HELP = { ev: 'exposure in stops, whole photo', highlights: 'bright areas', shadows: 'dark areas', whites: 'white point', blacks: 'black point', contrast: 'contrast', dehaze: 'haze', angle: 'straighten in degrees',
    temp: 'white balance blue to yellow', tint: 'white balance green to magenta', vibrance: 'saturation of muted colours', saturation: 'all colours', lookAmt: 'look strength %', skinMatch: 'pull skin colour toward the look', skySat: 'sky saturation', skyTemp: 'sky warmth',
    skinSmooth: 'even skin tone and texture', beautify: 'portrait finish: even skin with pores kept, clearer eyes, lifted under-eyes, whiter teeth, glow', subjLight: 'extra light on the people only', dodgeBurn: 'sculpt light on the people with a soft vignette', pop: 'depth and colour on the people, background set back', vignette: 'edge darkening (negative darkens)', rescue: 'night rescue: lifts dark areas by area, keeps highlights', eyes: 'clear red eye whites, add sparkle', faceRestore: 'restore focus on soft or slightly blurry faces (eyes, lips, hairline)', faceSlim: 'slim the lower face', jaw: 'tighten the line under the chin', eyesBig: 'open the eyes a little', bodySlim: 'slim waist and arms', teeth: 'whiter teeth', fabric: 'smooth dress and suit wrinkles', flyaways: 'remove stray hairs at the outline', studioWarm: 'studio light colour: negative cool, positive warm', studioX: 'spot light position across 0-1000 (studioDir spot)', studioY: 'spot light position down 0-1000 (studioDir spot)', heal: 'remove small spots and red marks on faces', shine: 'tone down oily hot spots on faces', glow: 'soft bloom on bright areas', flare: 'sun flare strength', flareX: 'flare position across, 0-1000', flareY: 'flare position down, 0-1000', flareWarm: 'flare warmth 0-100',
    clarity: 'midtone contrast', faceLight: 'brighten the faces', studioLight: 'add a big soft light', noise: 'high-ISO noise reduction', studioDir: 'where the studio light comes from: top, bottom, left, right, front, or spot (a light placed at studioX, studioY)', studioTarget: 'what the studio light falls on: person, background, both', skyExp: 'sky brightness', bgEdit: '100 edits everything, 0 only the people', bgBlur: 'blur behind the people', bokeh: 'soft light discs behind the people' };
  function agentPrompt(p, stage, round, nRefs, instruction, target) {
    const L = p.s.look ? lookById(p.s.look) : null, ls = L && L.look.kind === 'ref' ? LC.lookSkin(L.look) : null;
    const others = Object.keys(AGENT_KEYS).filter(k => !stage.keys.includes(k)).map(k => `${k} ${p.s[k] ?? 0}`).join(', ');
    const mine = stage.keys.filter(k => AGENT_KEYS[k] || CAT_KEYS[k]).map(k => CAT_KEYS[k] ? `${k}: "${p.s[k]}" (one of ${CAT_KEYS[k].join(', ')}) ${KEY_HELP[k] || ''}` : `${k}: ${p.s[k] ?? 0} [${AGENT_KEYS[k].join(', ')}] ${KEY_HELP[k] || ''}`).join('\n');
    const nPeople = p.s.people && p.s.people.length;
    return `You are the retoucher inside a wedding photographer's editing app. You edit by moving the app's settings, see the result, and adjust.
You work in a fixed order: 1 fix the image, 2 white balance, 3 colour, 4 skin, 5 light. NOW: step ${STAGES.indexOf(stage) + 1}, "${stage.name}", round ${round} of 2.
${stage.goal}

THE PHOTOGRAPHER'S STYLE (always follow):
${S.styleNotes || '(none given)'}${lessonsPrompt()}
${instruction ? `\nWHAT THEY ASKED FOR ON THIS PHOTO (only the parts that belong to this step):\n${instruction}\n` : ''}
IMAGES: image 1 is the photo straight from the camera. Image 2 is how it looks right now.${nRefs ? ` Images 3${nRefs > 1 ? '-' + (2 + nRefs) : ''} are ${target ? 'the REFERENCE photos the photographer chose' : `finished examples of the look "${L.name}"`}. Match their style for this step as closely as you can; the scenes differ, so match the edit, not the content.` : ''}
${ls ? `Skin in the look's examples measures about L ${ls.L.toFixed(0)}, a ${ls.a.toFixed(0)}, b ${ls.b.toFixed(0)} (Lab).` : ''}
${p.iso ? `ISO: ${p.iso}${p.iso >= 3200 ? ' (high: keep noise reduction on, roughly ' + (p.iso >= 12800 ? 50 : p.iso >= 6400 ? 38 : 26) + ')' : ''}.\n` : ''}PEOPLE FOUND: ${nPeople ? nPeople + ' (skin and person edits follow them exactly)' : 'none, so skin and person-only settings do nothing'}.${p.skinReport && p.skinReport.length ? `
SKIN, PER PERSON (the app reads each person's own skin and keeps it true to its type; Lab values, L = brightness): ${p.skinReport.map((k, i) => `person ${i + 1} (left to right as found): ${k.type} skin, ${k.L == null ? '' : ''}now L ${k.got.L} a ${k.got.a} b ${k.got.b}, aiming for L ${k.aim.L}`).join('; ')}.${p.skinReport.length > 1 ? ' These people have different skin, so they are edited separately: never judge one person\'s brightness or colour by another\'s.' : ''} If someone's skin looks too bright, gray or not like their own complexion, bring exposure or light DOWN rather than up.` : ''}

SETTINGS YOU MAY CHANGE IN THIS STEP (name: value [min, max] meaning):
${mine}${stage.keys.includes('hsl') ? `\nhsl: colour mixer, bands red, orange, yellow, green, aqua, blue, purple, magenta, each [hue, saturation, luminance] from -100 to 100. Current: ${JSON.stringify(Object.fromEntries(Object.entries(p.s.hsl).filter(([k, v]) => v.some(x => x))))}` : ''}${stage.skin ? `\nblemishes: boxes [x0, y0, x1, y1] (0-1000 of image 2's width and height) around small spots to heal on SKIN only, each at most 40 wide and tall. Already marked: ${(p.s.removals || []).filter(r => r.kind === 'blemish').length}.` : ''}
Already set by other steps (leave alone): ${others}.

EDIT STRENGTH: ${STRENGTH_TEXT[AG.strength || 'light']}
WHERE TO EDIT: ${AREA_TEXT[AG.area || 'gentle']}
SKIN TYPES: read this person's skin and keep it true to its type. Deep skin is rich, warm brown with red-gold undertones and some shine: never gray, ashy, chalky or lifted so bright it looks washed. Medium skin is golden and warm. Light skin is soft peach, never orange or red. If the skin looks gray or dull, that is wrong: add warmth (temp up) or bring brightness down rather than lifting it further.
WHITE DRESS VS SKIN: do not cool the whole photo (temp far below 0) to get a white dress: that turns deep skin ashy. The app cleans whites on the people by itself, so set white balance for the SKIN first.
ALWAYS TRUE, whatever the style: the white dress and shirts stay neutral white (never lavender, pink, blue or yellow); keep a real black point so the photo never looks hazy or gray; skin keeps its true colour and stays smooth and even, with no blotches or patches; light and shadow on a face must look natural, never like painted spots.
Move only this step's settings, in moderate amounts (each at most 50, exposure at most 1 stop per round). If this step already looks right, return done true with no changes.
Reply with JSON only:
{"done": false, "note": "one short sentence on what you changed and why", "changes": {"setting": value}${stage.keys.includes('hsl') ? ', "hsl": {"orange": [0, 0, 0]}' : ''}${stage.skin ? ', "blemishes": [[0, 0, 0, 0]]' : ''}}`;
  }
  /* ---- time estimate and the done alert ---- */
  // Claude takes a limited number of pictures per question (4 here): the most important ones go first, extras are left out rather than failing
  async function imageLimit() { if (S.imgMax) return S.imgMax; try { const l = await S.sample.limits(); const v = l && l.images; S.imgMax = (v && (v.maxPerRequest || v.max || v.perRequest)) || (typeof v === 'number' ? v : 4); } catch (e) { S.imgMax = 4; } S.imgMax = Math.max(1, Math.min(S.imgMax, 8)); return S.imgMax; }
  async function timedCall(prompt, images) { const t = performance.now(); const mx = await imageLimit(); if (images && images.length > mx) images = images.slice(0, mx); const out = await S.sample.json(prompt, { images, modelTier: 'complex' }); const sec = (performance.now() - t) / 1000; AG.avgCall = AG.avgCall ? AG.avgCall * 0.6 + sec * 0.4 : sec; return out; }
  function etaShow() { const e = document.getElementById('agEta'); if (!e || !AG.eta) { if (e) e.textContent = ''; return; } const left = Math.max(0, AG.eta.end - Date.now()) / 1000;
    e.textContent = left < 45 ? 'Almost done' : left < 90 ? 'About a minute left' : `About ${Math.round(left / 60)} minutes left`; hudUpdate(); }
  function etaStart(sec) { AG.eta = { end: Date.now() + sec * 1000 }; clearInterval(AG.etaT); AG.etaT = setInterval(etaShow, 2000); etaShow(); }
  function etaSet(sec) { if (AG.eta) { AG.eta.end = Date.now() + sec * 1000; etaShow(); } }
  function etaTick() { if (AG.eta && AG.eta.end < Date.now() + 20000) AG.eta.end = Date.now() + 30000; etaShow(); }
  function etaStop() { clearInterval(AG.etaT); AG.eta = null; etaShow(); }
  function askNotify() { try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission().catch(() => { }); } catch (e) { } }
  function notifyDone(text) {
    toast('✓ ' + text, 6000);
    try { const C = window.AudioContext || window.webkitAudioContext; if (C) { const c = new C(), t = c.currentTime; [[660, 0], [880, 0.14], [1320, 0.28]].forEach(([f, d]) => { const o = c.createOscillator(), g = c.createGain(); o.frequency.value = f; g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.12, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.5); o.connect(g); g.connect(c.destination); o.start(t + d); o.stop(t + d + 0.55); }); } } catch (e) { }
    try { if (window.Notification && Notification.permission === 'granted' && document.hidden) new Notification('Look Match Studio', { body: text }); } catch (e) { }
    if (document.hidden) { const t0 = document.title; let k = 0; const iv = setInterval(() => { document.title = k++ % 2 ? t0 : '✓ ' + text; if (!document.hidden || k > 40) { clearInterval(iv); document.title = t0; } }, 1000); }
  }

  /* ---- Ideas: the AI proposes a few finished edits, shows each as a preview; you pick one and it does that edit while you watch ---- */
  const ALL_KEYS = () => Object.keys(AGENT_KEYS).concat(Object.keys(CAT_KEYS));
  function ideaSettings(p, base, idea) {
    const s = Object.assign(D.defaults(), clone(base)); s.people = p.s.people; s.peopleDone = p.s.peopleDone; s.crop = p.s.crop; s.angle = p.s.angle; s.rot = p.s.rot; s.flipH = p.s.flipH; s.removals = clone(p.s.removals || []);
    const ch = idea.settings || {};
    for (const k in ch) { if (AGENT_KEYS[k]) { const R = AGENT_KEYS[k], v = +ch[k]; if (isFinite(v)) s[k] = k === 'ev' || k === 'angle' ? +Math.max(R[0], Math.min(R[1], v)).toFixed(2) : Math.round(Math.max(R[0], Math.min(R[1], v))); } else if (CAT_KEYS[k] && CAT_KEYS[k].includes(ch[k])) s[k] = ch[k]; }
    if (idea.hsl) for (const b of D.HSL_KEYS) { const v = idea.hsl[b]; if (Array.isArray(v) && v.length === 3 && v.every(x => isFinite(+x))) s.hsl[b] = v.map(x => Math.round(Math.max(-100, Math.min(100, +x)))); }
    const L = idea.look ? S.looks.find(l => !l.sample && l.name.toLowerCase() === String(idea.look).replace(/\s*\(creative\)\s*$/i, '').trim().toLowerCase()) : null;
    s.look = L ? L.id : null; s.pick = 'auto'; s.autoDone = true; if (AG.area === 'subject') { s.bgEdit = 0; s.bgBlur = 0; s.bokeh = 0; s.studioTarget = 'person'; s.subjectOnly = true; } else areaFix(s); strengthFix(s); s.editStrength = AG.strength || 'light'; return s;
  }
  async function renderSettings(p, s, long, tag) {
    const ps = await previewSource(p), L = s.look ? lookById(s.look) : null;
    const r = await P.process({ src: ps.src, SW: ps.SW, SH: ps.SH, s, look: L ? L.look : null, lookKey: L ? L.id + ':' + (L.rev || 0) : '', id: p.id + tag, maxLong: long, full: true, fullW: Math.max(p.W, p.H), brush: p.brush, subj: p.subj, rm: p.rm });
    return r.canvas;
  }
  /* how different two renders look, as average colour difference (Lab); under ~2 is hard to see */
  function colourGap(a, b) {
    const w = 160, h = Math.round(160 * a.height / a.width), ca = el('canvas'), cb = el('canvas'); ca.width = cb.width = w; ca.height = cb.height = h;
    ca.getContext('2d').drawImage(a, 0, 0, w, h); cb.getContext('2d').drawImage(b, 0, 0, w, h);
    const da = ca.getContext('2d').getImageData(0, 0, w, h).data, db = cb.getContext('2d').getImageData(0, 0, w, h).data, x = [0, 0, 0], y = [0, 0, 0]; let t = 0;
    for (let i = 0; i < w * h; i++) { LC.rgb2lab(da[4 * i] / 255, da[4 * i + 1] / 255, da[4 * i + 2] / 255, x); LC.rgb2lab(db[4 * i] / 255, db[4 * i + 1] / 255, db[4 * i + 2] / 255, y); t += Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); }
    return t / (w * h);
  }
  async function lookExamples(n) {
    const out = [], order = S.looks.filter(l => !l.sample).sort((a, b) => (b.id === AG.style) - (a.id === AG.style));
    for (const L of order) { if (out.length >= n) break; const r = (L.look.refs || []).find(r => r.img || r.thumb); if (!r) continue; try { const bl = await (await fetch(r.img || r.thumb)).blob(); if (bl.size) out.push({ name: L.name, blob: bl }); } catch (e) { } }
    return out;
  }
  async function makeIdeas(p, instruction) {
    if (!S.sample || AG.busy || !p || !p.eyeBlob) return;
    learnSweep(); askNotify(); AG.busy = true; AG.follow = true; AG.now = ''; AG.msg = null; AG.ideas = null; document.body.classList.add('ai-busy'); renderRight(); hudShow(true); corePhase('work'); hudStage(null, 'Coming up with ideas');
    S.busy = { text: 'AI editor: coming up with ideas', frac: 0 }; progress(); etaStart(3 * (AG.avgCall || 25) + 30);
    try {
      setAgent('look', 'Looking for the people and their faces.'); await detectPeople([p], true); P.clear();
      setAgent('look', 'Reading the photo: light, faces, colour.');
      const base = await autoValues(p); base.autoDone = true;
      const mxI = await imageLimit(), nRef = Math.min(AG.refs.length, Math.max(0, mxI - 1)), ex = await lookExamples(Math.max(0, mxI - 1 - nRef)), refs = AG.refs.length ? await Promise.all(AG.refs.slice(0, nRef).map(async r => { const bmp = await decode(r.file), c = scaled(bmp, bmp.width, bmp.height, 768), bl = await toBlob(c, 0.86); c.width = c.height = 0; return bl; })) : [];
      const looks = S.looks.filter(l => !l.sample).map(l => l.name + (l.creative ? ' (creative)' : ''));
      const keys = ALL_KEYS().map(k => CAT_KEYS[k] ? `${k} (${CAT_KEYS[k].join('|')})` : `${k} [${AGENT_KEYS[k].join(', ')}]`).join(', ');
      setAgent('talk', 'Thinking up a few different ways this photo could look.');
      const prompt = `You are the retoucher in a wedding photographer's editing app. Propose 3 clearly different FINISHED edits of image 1 that the photographer could choose from.
THE PHOTOGRAPHER'S STYLE: ${S.styleNotes || '(none)'}${lessonsPrompt()}
${instruction ? 'WHAT THEY ASKED FOR: ' + instruction + '\n' : ''}${refs.length ? `Images 2-${1 + refs.length} are reference photos they want to match. ` : ''}${ex.length ? `Images ${2 + refs.length}-${1 + refs.length + ex.length} are examples of their saved looks, in this order: ${ex.map(e => e.name).join(', ')}.` : ''}
THEIR SAVED LOOKS: ${looks.join(', ') || 'none'}.
RECOMMEND LOOKS: you are recommending which of their saved looks suits THIS photo. ${refs.length ? 'Idea 1 matches the reference photos (look null, settings only). Ideas 2 and 3 each use' : 'Each idea uses'} a DIFFERENT one of their saved looks (the exact name in "look"), the ones that best fit this photo's light, setting and skin tones; tune the settings so the look sits well on this photo. In "why", say which look and why it suits this photo.${AG.style && lookById(AG.style) ? ` They chose "${lookById(AG.style).name}" as the style to work toward; one idea must use it.` : ''}${looks.length ? '' : ' (They have no saved looks yet, so use look null.)'}
The photo already has a starting point (exposure set for the faces, white balance from the whites): ${JSON.stringify(Object.fromEntries(Object.entries(base).filter(([k, v]) => typeof v === 'number' && AGENT_KEYS[k])))}.
People found: ${p.s.people && p.s.people.length ? p.s.people.length : 'none'}. If it was shot dark without flash, use faceLight and studioLight to add natural light, and noise for high-ISO grain.
Settings you can use: ${keys}. hsl: {band: [hue, saturation, luminance]} for red, orange, yellow, green, aqua, blue, purple, magenta, each -100 to 100.
Always: whites stay neutral white, keep a real black point (never hazy), skin true to colour and even, light on faces natural, dodge & burn that sculpts the face.
Make the 3 ideas genuinely different, each one a polished final edit.
${AREA_TEXT[AG.area || 'gentle']}
EDIT STRENGTH: ${STRENGTH_TEXT[AG.strength || 'light']}
Reply with JSON only: {"ideas": [{"title": "2-4 words", "why": "one sentence: which look and why it suits this photo", "look": "exact saved look name or null", "settings": {"setting": value}, "hsl": {}}]}`;
      const out = await timedCall(prompt, [p.eyeBlob, ...refs, ...ex.map(e => e.blob)]); etaTick();
      const list = (out && Array.isArray(out.ideas) ? out.ideas : []).filter(i => i && typeof i === 'object').slice(0, 3);
      if (!list.length) throw new Error('The AI did not come back with ideas. Try again.');
      const ideas = [];
      for (const [i, idea] of list.entries()) {
        setAgent('adjust', `Building idea ${i + 1}: ${String(idea.title || '').slice(0, 40)}`);
        const s = ideaSettings(p, base, idea), cv = await renderSettings(p, s, 900, 'I' + i);
        ideas.push({ title: String(idea.title || 'Idea ' + (i + 1)).slice(0, 40), why: String(idea.why || '').slice(0, 200), s, cv, url: URL.createObjectURL(await toBlob(cv, 0.86)) });
      }
      // look over its own ideas before showing them, and fix anything off
      setAgent('look', 'Checking each idea before I show you.');
      const chk = await timedCall(`These are ${ideas.length} edits of the same wedding photo (image 1 is the camera original, images 2-${1 + ideas.length} are the edits, in order: ${ideas.map(i => i.title).join(', ')}).
For each edit, check it as a demanding retoucher: faces bright and natural, skin even with no blotches or patches, no halos, whites neutral, real blacks, nothing over-processed. If an edit needs fixing, give the setting changes that fix it (same setting names as before: ${keys}).
Current settings per edit: ${JSON.stringify(ideas.map(i => Object.fromEntries(ALL_KEYS().map(k => [k, i.s[k]]))))}
Reply with JSON only: {"fixes": [{"idea": 1, "ok": true, "changes": {}}]}`, [p.eyeBlob, ...await Promise.all(ideas.map(i => toBlob(i.cv, 0.86)))]); etaTick();
      for (const f of (chk && Array.isArray(chk.fixes) ? chk.fixes : [])) { const it = ideas[(f.idea | 0) - 1]; if (!it || f.ok || !f.changes || !Object.keys(f.changes).length) continue;
        setAgent('adjust', `Fixing "${it.title}".`); it.s = ideaSettings(p, it.s, { settings: f.changes, look: it.s.look ? lookById(it.s.look).name : null, hsl: f.hsl || it.s.hsl }); it.cv = await renderSettings(p, it.s, 900, 'J' + f.idea); URL.revokeObjectURL(it.url); it.url = URL.createObjectURL(await toBlob(it.cv, 0.86)); }
      AG.ideas = ideas; AG.ideasFor = p.id; setAgent('talk', `Here are ${ideas.length} ideas. Pick one and I will do that edit while you watch.`);
      notifyDone('Your ideas are ready.');
    } catch (e) { AG.msg = ['err', e && e.message || String(e)]; setAgent('idle', AG.msg[1]); }
    etaStop(); S.busy = null; progress(); AG.busy = false; AG.paused = false; document.body.classList.remove('ai-busy'); handOff(); hudShow(false); holoShow(false); if (AG.resume) AG.msg = ['ok', `Stopped. Press Continue edit to pick up where it left off (${AG.resume.ids.length} photo${AG.resume.ids.length > 1 ? 's' : ''} to go).`]; corePhase(AG.msg && AG.msg[0] === 'err' ? null : 'done'); AG.stageId = null; renderRight();
  }
  /* do the chosen idea on screen, then check the result against the idea's preview and keep tweaking until they match */
  async function doIdea(p, idea) {
    if (!S.sample || AG.busy) return; askNotify(); AG.busy = true; AG.follow = true; AG.now = ''; AG.msg = null; document.body.classList.add('ai-busy'); renderRight(); hudShow(true); corePhase('work'); hudStage(null, 'Doing the edit you picked');
    S.busy = { text: 'AI editor: doing the edit', frac: 0 }; progress();
    const moves = ALL_KEYS().filter(k => JSON.stringify(idea.s[k]) !== JSON.stringify(p.s[k])).length; etaStart(moves * 2.2 + 2 * (AG.avgCall || 25) + 20);
    try {
      if (p.id !== S.active) { S.active = p.id; render(); await sleep(600); }
      if (idea.s.look !== p.s.look) { setAgent('adjust', idea.s.look ? `Putting on ${lookById(idea.s.look).name}.` : 'Taking the look off.'); change(s => { s.look = idea.s.look; s.pick = 'auto'; }, { all: [p] }); await sleep(1200); }
      for (const stage of STAGES) {
        hudStage(stage.id);
        const tgt = {}; for (const k of stage.keys) if (AGENT_KEYS[k] && idea.s[k] !== p.s[k]) tgt[k] = idea.s[k];
        const cats = stage.keys.filter(k => CAT_KEYS[k] && idea.s[k] !== p.s[k]), hv = stage.keys.includes('hsl') ? Object.fromEntries(D.HSL_KEYS.filter(b => JSON.stringify(idea.s.hsl[b]) !== JSON.stringify(p.s.hsl[b])).map(b => [b, idea.s.hsl[b]])) : {};
        if (!Object.keys(tgt).length && !cats.length && !Object.keys(hv).length) continue;
        setAgent('talk', `Step ${HUD_STEPS.findIndex(x => x[0] === stage.id) + 1} of ${HUD_STEPS.length}: ${stage.name.toLowerCase()}.`); await sleep(700);
        for (const k of cats) { setAgent('adjust', `${k === 'studioDir' ? 'Studio light from' : 'Studio light on'}: ${idea.s[k]}`); change(s => { s[k] = idea.s[k]; }, { all: [p] }); const sel = document.getElementById('sel-' + k); if (sel) { sel.value = idea.s[k]; sel.scrollIntoView({ block: 'center', behavior: 'smooth' }); const r = sel.getBoundingClientRect(); await handTo(r.left + r.width / 2, r.top + r.height / 2, 450); } await sleep(500); }
        await moveSettings(p, tgt, Object.keys(hv).length ? hv : null, '');
      }
      const exact = () => change(s => { const keep = { crop: s.crop, angle: s.angle, rot: s.rot, flipH: s.flipH, aspect: s.aspect, removals: s.removals, people: s.people, peopleDone: s.peopleDone }; Object.assign(s, clone(idea.s), keep); s.autoDone = true; }, { all: [p], undo: false });
      exact();   // every hidden setting the idea used (skin depth and the like) too, so the edit is the idea
      // check against the idea: same size render, colour difference, then the AI's own eyes
      for (let round = 1; round <= 3; round++) {
        setAgent('look', round === 1 ? 'Checking my edit against the idea you picked.' : 'Checking again.');
        const now = await renderSettings(p, p.s, 900, 'V' + round), gap = colourGap(now, idea.cv);
        let out = null;
        try { out = await timedCall(`Image 1 is the photo as it is now. Image 2 is the idea the photographer approved. The final edit must look exactly like image 2: same brightness, colour, skin, contrast, light. Their average colour difference measures ${gap.toFixed(1)} (under 2 is invisible).
Also check it is clean: no blotches on skin, no halos, whites neutral. If it matches and is clean, reply {"match": true}. Otherwise give the setting changes that close the gap: {"match": false, "note": "what differs", "changes": {"setting": value}}.
Current settings: ${JSON.stringify(Object.fromEntries(ALL_KEYS().map(k => [k, p.s[k]])))}. Reply with JSON only.`, [await toBlob(now, 0.86), await toBlob(idea.cv, 0.86)]); etaTick(); } catch (e) { if (e && e.code === 'not_granted') throw new Error('Asking Claude was not allowed.'); }
        if ((!out || out.match === true) && gap < 2.5) { setAgent('talk', `It matches the idea (difference ${gap.toFixed(1)}).`); break; }
        const ch = out && out.changes && typeof out.changes === 'object' ? out.changes : {}, tgt = {};
        for (const k in ch) if (AGENT_KEYS[k] && isFinite(+ch[k])) { const R = AGENT_KEYS[k]; tgt[k] = k === 'ev' ? +Math.max(R[0], Math.min(R[1], +ch[k])).toFixed(2) : Math.round(Math.max(R[0], Math.min(R[1], +ch[k]))); }
        if (!Object.keys(tgt).length) { if (gap >= 2.5) exact(); else { setAgent('talk', `It matches the idea (difference ${gap.toFixed(1)}).`); break; } continue; }
        setAgent('talk', (out.note ? String(out.note).slice(0, 140) + ' ' : '') + 'Tweaking.'); await sleep(700); await moveSettings(p, tgt, null, '');
      }
      p.agentNote = `Did the "${idea.title}" idea and checked it against the preview.`; p.aiSnap = aiSnapOf(p); persist(p);
      AG.msg = ['ok', `Done: "${idea.title}". Ctrl/⌘Z undoes each step.`]; notifyDone('Your edit is done.');
    } catch (e) { AG.msg = ['err', e && e.message || String(e)]; }
    etaStop(); S.busy = null; progress(); AG.busy = false; document.body.classList.remove('ai-busy'); handOff(); hudShow(false); corePhase(AG.msg && AG.msg[0] === 'err' ? null : 'done'); AG.stageId = null; setAgent('idle', null); scheduleRender('final'); renderRight(); updateCell(p);
  }
  async function agentEdit(list, instruction, resume) {
    list = (list || []).filter(t => t && t.eyeBlob); if (!list.length || !S.sample || AG.busy) return; AG.resume = null; AG.paused = false; AG.lastInstr = instruction || '';
    learnSweep(); AG.busy = true; AG.follow = true; AG.now = ''; hudShow(true); corePhase('work'); hudStage(null, 'Finding the people'); for (const t of list || []) if (t) { t.s.editStrength = AG.strength || 'light'; if (AG.handRetouch === false) { t.s.aiStrokes = []; t.s.dodgeBurn = 0; } strengthFix(t.s); } AG.msg = null; (list || []).forEach(t => { if (t) t.restored = false; }); if (AG.area === 'subject') for (const t of list) { t.s.bgEdit = 0; t.s.bgBlur = 0; t.s.bokeh = 0; t.s.subjectOnly = true; } else if ((AG.area || 'gentle') === 'gentle') for (const t of list) areaFix(t.s); document.body.classList.add('ai-busy'); renderRight();
    const many = list.length > 1; S.busy = { text: 'AI editor: finding people', frac: 0 }; progress();
    let done = 0, failed = 0;
    try {
      let target = null;
      if (AG.refs.length) {
        S.busy.text = 'AI editor: reading your reference photos'; progress();
        target = await Promise.all(AG.refs.slice(0, 3).map(async r => { const bmp = await decode(r.file), c = scaled(bmp, bmp.width, bmp.height, 768), bl = await toBlob(c, 0.86); c.width = c.height = 0; bmp.close && bmp.close(); return bl; }));
        if (!AG.refLookId || !lookById(AG.refLookId)) {
          const per = []; for (const r of AG.refs) per.push(await measureEdit(r.file, AG.notMine));
          const look = LC.combineRef(per, null), id = nid(), name = 'Match: ' + (AG.notMine ? `${AG.refs.length} reference${AG.refs.length > 1 ? 's' : ''}` : AG.refs[0].file.name.replace(/\.[^.]+$/, '')) + ' ' + new Date().toLocaleDateString();
          await saveLook(Object.assign(LC.serialize(look, { name, created: Date.now(), creative: false }), { id }));
          if (!lookById(id)) S.looks = [{ id, name, created: Date.now(), creative: false, look, rev: 1 }].concat(S.looks);
          AG.refLookId = id;
        }
        change(s => { s.look = AG.refLookId; s.pick = 'auto'; }, { all: list });
      }
      setAgent('look', 'Looking for the people and their faces.');
      await detectPeople(list, true);
      P.clear(); renderRight(); setAgent('look', list.some(t => t.s.people && t.s.people.length) ? 'Found them. Now I can work on the people only.' : 'No people found, so I will edit the whole photo.'); await sleep(900);

      S.busy = { text: `AI editor 0 of ${list.length}`, frac: 0 }; progress();
      etaStart(list.length * (7 * (AG.avgCall || 25) + 40));
      for (let pi = 0; pi < list.length; pi++) { const p = list[pi];
        if (S.busy && S.busy.stop) { AG.resume = { ids: list.slice(pi).map(t => t.id), stage: 0, instruction }; break; }
        const before = JSON.parse(JSON.stringify(p.s)), startStage = resume && pi === 0 && resume.ids[0] === p.id ? resume.stage || 0 : 0; AG.curIdx = pi; holoShow(true, p);
        if (S.active !== p.id || S.mod !== 'develop') { S.active = p.id; S.sel = new Set([p.id]); S.mod = 'develop'; render(); await sleep(700); }
        // the style to work toward
        if (!target && !S.manual && AG.style && lookById(AG.style) && p.s.look !== AG.style) { setAgent('adjust', `Putting on ${lookById(AG.style).name} as the starting style.`); change(s => { s.look = AG.style; s.pick = 'auto'; }, { all: [p] }); renderLeft(); await sleep(1400); }
        if (!p.s.autoDone) {
          setAgent('look', 'Reading the photo: faces, skin, light and colour.'); await sleep(500);
          let a = null; try { a = await autoValues(p); } catch (e) { }
          if (a) { const num = {}; for (const k in a) if (typeof a[k] === 'number' && AGENT_KEYS[k]) num[k] = a[k];
            hudStage(null, 'Setting a starting point'); setAgent('adjust', 'Setting a starting point.'); await moveSettings(p, num, null, ''); change(s => { s.skinDepth = a.skinDepth; s.autoDone = true; }, { all: [p], undo: false }); }
        }
        const orig = p.eyeBlob; let notes = [], refsFor = null, calls = 0;
        stages: for (const [si, stage] of STAGES.entries()) {
          if (si < startStage) continue;
          AG.curStage = si; hudStage(stage.id); holoStage(stage.name);
          for (let round = 1; round <= 2; round++) {
            if (S.busy && S.busy.stop) { AG.resume = { ids: list.slice(pi).map(t => t.id), stage: si, instruction }; break stages; }
            S.busy.text = `AI editor: ${many ? `photo ${done + 1} of ${list.length}, ` : ''}${stage.name.toLowerCase()}`; progress();
            setAgent('look', round === 1 ? `Step ${HUD_STEPS.findIndex(x => x[0] === stage.id) + 1} of ${HUD_STEPS.length}, ${stage.name.toLowerCase()}: comparing with the ${target ? 'reference photos' : 'style'}.` : `Checking ${stage.name.toLowerCase()} again.`);
            const L = p.s.look ? lookById(p.s.look) : null, refs = target ? target : L ? (refsFor && refsFor.id === L.id ? refsFor.imgs : (refsFor = { id: L.id, imgs: await refImages(L, p) }).imgs) : [];
            const refsN = refs.slice(0, Math.max(0, (await imageLimit()) - 2)), imgs = [orig, await renderForAgent(p), ...refsN];
            let out;
            try { calls++; out = await timedCall(agentPrompt(p, stage, round, refsN.length, instruction, !!target), imgs); etaTick(-1); }
            catch (e) { if (e && e.code === 'not_granted') { S.sampleDenied = true; throw new Error('Asking Claude was not allowed. Allow it in the artifact\'s permissions to use the AI editor.'); } if (e && e.code === 'rate_limited') { await new Promise(r => setTimeout(r, 4000)); round--; continue; } failed++; break stages; }
            if (!out || typeof out !== 'object') { failed++; break stages; }
            const ch = out.changes && typeof out.changes === 'object' ? out.changes : {}, hsl = stage.keys.includes('hsl') && out.hsl && typeof out.hsl === 'object' ? out.hsl : null;
            const blem = stage.skin && Array.isArray(out.blemishes) ? out.blemishes.filter(b => Array.isArray(b) && b.length === 4 && b.every(v => isFinite(+v))).map(b => b.map(v => Math.max(0, Math.min(1000, +v)) / 1000)).filter(b => b[2] > b[0] && b[3] > b[1] && b[2] - b[0] <= 0.05 && b[3] - b[1] <= 0.05).slice(0, 15) : [];
            const allowed = Object.keys(ch).filter(k => AGENT_KEYS[k] && stage.keys.includes(k)), cats = Object.keys(ch).filter(k => CAT_KEYS[k] && stage.keys.includes(k) && CAT_KEYS[k].includes(ch[k]) && p.s[k] !== ch[k]);
            const any = allowed.length || cats.length || (hsl && Object.keys(hsl).length) || blem.length;
            if (typeof out.note === 'string' && out.note.trim() && any) notes.push(`${stage.name}: ${out.note.trim().slice(0, 200)}`);
            if (any) {
              // do it where it can be seen: each slider moves on screen, then blemishes are healed one by one
              const tgt = {}; for (const k of allowed) { const R = AGENT_KEYS[k]; let v = +ch[k]; if (!isFinite(v)) continue; const now = p.s[k] ?? 0, step = k === 'ev' ? 1 : k === 'angle' ? 5 : 50; v = Math.max(now - step, Math.min(now + step, v)); tgt[k] = k === 'ev' || k === 'angle' ? +Math.max(R[0], Math.min(R[1], v)).toFixed(2) : Math.round(Math.max(R[0], Math.min(R[1], v))); }
              const hv = {}; if (hsl) for (const b of D.HSL_KEYS) { const v = hsl[b]; if (Array.isArray(v) && v.length === 3 && v.every(x => isFinite(+x))) hv[b] = v.map(x => Math.round(Math.max(-100, Math.min(100, +x)))); }
              for (const k of cats) { setAgent('adjust', `${k === 'studioDir' ? 'Studio light from' : 'Studio light on'}: ${ch[k]}`); change(s => { s[k] = ch[k]; }, { all: [p] }); const sel = document.getElementById('sel-' + k); if (sel) { sel.value = ch[k]; sel.scrollIntoView({ block: 'center', behavior: 'smooth' }); const r = sel.getBoundingClientRect(); await handTo(r.left + r.width / 2, r.top + r.height / 2, 450); } await sleep(500); }
              if (p.id === S.active) { const why = typeof out.note === 'string' ? out.note.trim().slice(0, 140) : ''; setAgent('talk', why || 'Adjusting.'); await sleep(900); await moveSettings(p, tgt, Object.keys(hv).length ? hv : null, ''); }
              else change(s => { Object.assign(s, tgt); for (const b in hv) s.hsl[b] = hv[b]; }, { all: [p] });
              if (blem.length) { S.showRm = true; setAgent('adjust', `Healing ${blem.length} small spot${blem.length > 1 ? 's' : ''} on the skin.`);
                for (const b of blem) { const fr = document.getElementById('frame'); if (fr) { const r = fr.getBoundingClientRect(); ghost().classList.add('brush'); await handTo(r.left + (b[0] + b[2]) / 2 * r.width, r.top + (b[1] + b[3]) / 2 * r.height, 500); ghost().classList.add('press'); }
                  change(s => { s.removals = (s.removals || []).concat([{ label: 'Blemish', kind: 'blemish', box: [b[0], b[1], Math.max(0.004, b[2] - b[0]), Math.max(0.004, b[3] - b[1])], on: true }]); }, { all: [p] }); await sleep(450); ghost().classList.remove('press'); }
                S.showRm = false; drawOverlay(); }
              handOff();
            }
            if (false) {
              change(s => {
                for (const k of allowed) { const R = AGENT_KEYS[k]; let v = +ch[k]; if (!isFinite(v)) continue; const now = s[k] ?? 0, step = k === 'ev' ? 1 : k === 'angle' ? 5 : 50; v = Math.max(now - step, Math.min(now + step, v)); s[k] = k === 'ev' || k === 'angle' ? +Math.max(R[0], Math.min(R[1], v)).toFixed(2) : Math.round(Math.max(R[0], Math.min(R[1], v))); }
                if (hsl) for (const b of D.HSL_KEYS) { const v = hsl[b]; if (Array.isArray(v) && v.length === 3 && v.every(x => isFinite(+x))) s.hsl[b] = v.map(x => Math.round(Math.max(-100, Math.min(100, +x)))); }
                if (blem.length) s.removals = (s.removals || []).concat(blem.map(b => ({ label: 'Blemish', kind: 'blemish', box: [b[0], b[1], Math.max(0.004, b[2] - b[0]), Math.max(0.004, b[3] - b[1])], on: true })));
              }, { all: [p] });
            }
            if (!any) setAgent('talk', `${stage.name} looks right.`), await sleep(700);
            if (out.done === true || !any) break;
          }
          // after the skin: dodge and burn by hand, the way a retoucher would
          if (stage.id === 'skin' && !(S.busy && S.busy.stop) && p.s.people && p.s.people.length && AG.handRetouch !== false) {
            try { const n0 = await handRetouch(p, orig, target, instruction); if (n0) notes.push(`Retouch: ${n0}`); } catch (e) { if (e && e.code === 'not_granted') throw e; } }
        }
        setAgent('talk', S.busy && S.busy.stop ? 'Stopped.' : 'Done with this photo.'); handOff(); etaSet(Math.max(0, (list.length - done - 1)) * (7 * (AG.avgCall || 25) + 40));
        p.agentNote = notes.length ? notes.join(' ') : 'No changes needed.'; p.aiSnap = aiSnapOf(p); persist(p); if (p.id !== S.active) queueThumb(p); updateCell(p);
        done++; S.busy.frac = done / list.length; progress();
        // like a hired editor: show the finished photo and wait for the photographer before moving on
        if (!(S.busy && S.busy.stop) && AG.approveEach) { const v = await askApprove(p, pi, list.length);
          if (v === 'redo') { change(s => { Object.assign(s, before); }, { all: [p] }); done--; pi--; continue; }
          if (v === 'stop') { AG.resume = pi + 1 < list.length ? { ids: list.slice(pi + 1).map(t => t.id), stage: 0, instruction } : null; S.busy.stop = true; break; }
          p.pick = 1; p.approved = true; persist(p); updateCell(p); }
      }
      AG.msg = ['ok', failed ? `Edited ${done - failed} of ${list.length}. ${failed} could not be read; try them again.` : `Edited ${done} photo${done === 1 ? '' : 's'}. Ctrl/⌘Z undoes each step.`];
    } catch (e) { AG.msg = ['err', e.message || String(e)]; }
    etaStop(); if (!(AG.msg && AG.msg[0] === 'err')) notifyDone(`${list.length > 1 ? list.length + ' photos are' : 'Your photo is'} edited.`);
    S.busy = null; progress(); AG.busy = false; document.body.classList.remove('ai-busy'); handOff(); hudShow(false); corePhase(AG.msg && AG.msg[0] === 'err' ? null : 'done'); AG.stageId = null; if (AG.msg && AG.msg[0] === 'err') setAgent('idle', AG.msg[1]); else setAgent('idle', null); scheduleRender('final'); renderLeft(); renderRight();
  }
  function showIdea(it) { let close; close = modal(d => { d.append(el('h3', { text: it.title }), el('p', { text: it.why }), el('img', { src: it.url, alt: it.title, style: 'width:100%;border-radius:10px;display:block' }), el('div', { class: 'row', style: 'justify-content:flex-end' }, el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close'))); }); }
  /* back to the photo as shot: every setting, look, brush and healed spot cleared; the people found are kept */
  function startOver(list) {
    for (const t of list) { pushUndo(t); const keep = { people: t.s.people || null, peopleDone: t.s.peopleDone }; t.s = Object.assign(D.defaults(), keep); t.aiSnap = null; t.brush = null; t.subj = null; t.rm = null; t.agentNote = null; t.restored = false; persist(t); queueThumb(t); updateCell(t); }
    if (AG.ideasFor && list.some(t => t.id === AG.ideasFor)) AG.ideas = null;
    P.clear(); scheduleRender('final'); renderLeft(); renderRight(); setAgent('idle', 'Back to the photo as you shot it.');
    toast(list.length > 1 ? `${list.length} photos are back to how they were shot. Ctrl/⌘Z brings an edit back.` : 'Back to how it was shot. Ctrl/⌘Z brings the edit back.');
  }
  /* ---- Hand retouching: the AI studies each face and body and paints dodge and burn strokes, the way a retoucher works,
     then looks at the result and fixes strokes that are too strong, too weak or in the wrong place. ---- */
  const RETOUCH_GUIDE = `HOW A PORTRAIT RETOUCHER DODGES AND BURNS (follow the light that is already in the photo; you are shaping it, not inventing a new light):
FACE (each face, both sides; the side away from the light gets less dodge and a little more burn):
- dodge: center of the forehead, the bridge and tip of the nose (thin stroke), the top of each cheekbone, the chin, cupid's bow, under-eye hollows (very light, strength 10-20), the iris/eye whites (tiny, light), the lower lip highlight.
- burn: temples and hairline edges, the hollow under each cheekbone (a soft diagonal stroke from ear toward mouth corner), along the jawline and under the jaw (separates face from neck), the sides of the nose (thin), the outer edges of the face.
BODY: shoulders, arms, back, chest and legs are cylinders: dodge a soft band along the ridge facing the light; burn the far edges and where a limb meets the body. Collarbones: dodge the top edge, burn just below. On a back: dodge the shoulder blades' tops, burn the spine channel lightly. Dress and suit: dodge folds facing the light a little, burn deep folds a little.
${AG.strength === 'bold' ? '' : 'KEEP IT SUBTLE: strengths mostly 8-20 (never above ' + (AG.strength === 'balanced' ? 40 : 25) + '); the viewer should not be able to see that anything was painted.\n'}SKIN TYPES: deep skin: dodge gently (strength 15-35) so it never turns gray or ashy, burn very gently (10-25) because it is already dark; keep its richness. Medium skin: dodge 20-40, burn 15-35. Light skin: dodge 15-30, burn 20-40, and avoid burning in red areas (it reads as blotchy).
NEVER: paint over the eyes' pupils, teeth or lips with burn; paint the background; leave visible patches or stripes; let one stroke change brightness abruptly. Strokes are soft and wide: a face's strokes are roughly 1/6 to 1/3 of the face width; body strokes wider.`;
  function peopleForPrompt(p) { const P = (p.s.people || []).map((q, i) => { const r = v => v ? v.map(x => Math.round(x * 1000)) : null;
      return `person ${i + 1}: body box ${JSON.stringify(r(q.b))}${q.f ? `, face box ${JSON.stringify(r(q.f))}` : ''}${q.lm && q.lm.le ? `, eyes ${JSON.stringify(r(q.lm.le))} ${JSON.stringify(r(q.lm.re))}, nose ${JSON.stringify(r(q.lm.n))}, mouth ${JSON.stringify(r(q.lm.m))}` : ''}${p.skinReport && p.skinReport[i] ? `, ${p.skinReport[i].type} skin` : ''}`; });
    return P.join('\n'); }
  function cleanStroke(t) { if (!t || !Array.isArray(t.pts)) return null; const pts = t.pts.filter(q => Array.isArray(q) && q.length === 2 && q.every(v => isFinite(+v))).slice(0, 12).map(q => [Math.max(0, Math.min(1000, +q[0])), Math.max(0, Math.min(1000, +q[1]))]);
    if (!pts.length) return null; return { mode: t.mode === 'burn' ? 'burn' : 'dodge', pts, size: Math.max(4, Math.min(250, +t.size || 30)), strength: Math.max(3, Math.min(AG.strength === 'bold' ? 70 : AG.strength === 'balanced' ? 40 : 25, +t.strength || 20)), why: String(t.why || t.area || '').slice(0, 60) }; }
  async function paintStrokeOnScreen(p, st) {
    // the hand traces the stroke over the photo and the light builds up as it goes
    const cv = document.getElementById('cvA'), on = p.id === S.active && cv;
    const toScreen = q => { const r = cv.getBoundingClientRect(); return [r.left + q[0] / 1000 * r.width, r.top + q[1] / 1000 * r.height]; };
    const pts = st.pts.length === 1 ? [st.pts[0], st.pts[0]] : st.pts, seg = [];
    for (let k = 1; k < pts.length; k++) for (let j = 0; j < 3; j++) seg.push([pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * j / 3, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * j / 3]);
    seg.push(pts[pts.length - 1]);
    if (on) { const [x, y] = toScreen(seg[0]); await handTo(x, y, 380); ghost().classList.add('press'); }
    const idx = (p.s.aiStrokes || []).length, steps = Math.min(seg.length, 5);
    for (let k = 1; k <= steps; k++) { const upto = Math.max(1, Math.round(seg.length * k / steps)), part = Object.assign({}, st, { pts: seg.slice(0, upto) });
      AG.dragging = true; change(s => { const a = (s.aiStrokes || []).slice(); a[idx] = part; s.aiStrokes = a; }, { all: [p], draft: true, undo: k === 1 });
      if (on) { const [x, y] = toScreen(seg[upto - 1]); const g = ghost(); g.style.transitionDuration = '260ms'; g.style.transform = `translate(${x}px, ${y}px)`; lookAt(x, y); }
      await sleep(120); await renderIdle(1800); }
    AG.dragging = false; change(s => { const a = (s.aiStrokes || []).slice(); a[idx] = st; s.aiStrokes = a; }, { all: [p], undo: false });
    if (on) ghost().classList.remove('press');
  }
  async function handRetouch(p, orig, target, instruction) {
    hudStage('retouch'); S.busy && (S.busy.text = 'AI editor: dodge & burn by hand'); progress();
    setAgent('look', 'Studying how the light falls on each face and body.');
    const rules = `${RETOUCH_GUIDE}
PEOPLE (coordinates are 0-1000 of image 2's width and height): 
${peopleForPrompt(p)}
${S.styleNotes ? 'THE PHOTOGRAPHER\'S STYLE: ' + S.styleNotes : ''}${instruction ? '\nWHAT THEY ASKED FOR: ' + instruction : ''}`;
    const prompt = `You are a high-end wedding portrait retoucher doing dodge and burn by hand on image 2 (image 1 is the camera original${target ? '; the images after it are reference photos to match' : ''}).
${rules}
Paint between 8 and 24 strokes in total, covering every face and the visible skin of every person, in the order a retoucher would work (faces first).
A stroke: {"mode": "dodge" or "burn", "pts": [[x, y], ...] (1 to 8 points along the stroke, 0-1000 coordinates), "size": brush radius (0-1000 of the image width), "strength": 5-60, "why": "2-5 words, e.g. 'left cheekbone highlight'"}.
Reply with JSON only: {"note": "one sentence on your plan", "strokes": [ ... ]}`;
    let out; try { out = await timedCall(prompt, [orig, await renderForAgent(p), ...(target || []).slice(0, 2)]); etaTick(); } catch (e) { if (e && e.code === 'not_granted') throw e; return ''; }
    const list = (out && Array.isArray(out.strokes) ? out.strokes : []).map(cleanStroke).filter(Boolean).slice(0, 28);
    if (!list.length) { setAgent('talk', 'The light on the faces already looks right; no hand retouching needed.'); return ''; }
    if (out.note) { setAgent('talk', String(out.note).slice(0, 160)); await sleep(1200); }
    // the automatic dodge & burn slider steps back so the two don't double up
    if ((p.s.dodgeBurn || 0) > 20) { setAgent('adjust', `Dodge & burn slider: ${p.s.dodgeBurn} → 15 (doing it by hand instead)`); await dragSlider(p, 'dodgeBurn', 15); }
    for (const [i, st] of list.entries()) { if (S.busy && S.busy.stop) break; setAgent('adjust', `${st.mode === 'dodge' ? 'Dodging' : 'Burning'} ${st.why || 'stroke ' + (i + 1)} (${st.strength}%)`); await paintStrokeOnScreen(p, st); }
    handOff();
    // look at the result and fix what's off: too strong, too weak, patchy, or in the wrong place
    for (let round = 1; round <= 2; round++) {
      if (S.busy && S.busy.stop) break;
      setAgent('look', round === 1 ? 'Checking the retouch: is it natural, even, and true to each skin tone?' : 'Checking the retouch once more.');
      const cur = p.s.aiStrokes || [];
      const rev = `You are checking dodge and burn you painted on a wedding portrait. Image 1 is the camera original, image 2 is the photo now.
${rules}
Your strokes so far (numbered): ${JSON.stringify(cur.map((t, i) => ({ n: i + 1, mode: t.mode, why: t.why, pts: t.pts, size: t.size, strength: t.strength })))}
Look closely at each face and the skin: anything patchy, striped, gray/ashy, spot-lit or too contrasty means a stroke is too strong or misplaced; flat, lifeless faces mean it is too weak. Fix only what needs it.
Reply with JSON only: {"done": true or false, "note": "one sentence", "change": [{"n": 3, "strength": 20}], "remove": [5], "add": [stroke objects as before]}`;
      let r; try { r = await timedCall(rev, [orig, await renderForAgent(p)]); etaTick(); } catch (e) { if (e && e.code === 'not_granted') throw e; break; }
      if (!r || typeof r !== 'object') break;
      const rm = new Set((Array.isArray(r.remove) ? r.remove : []).map(n => (n | 0) - 1)), chg = (Array.isArray(r.change) ? r.change : []).filter(c => c && isFinite(+c.n) && isFinite(+c.strength)), add = (Array.isArray(r.add) ? r.add : []).map(cleanStroke).filter(Boolean).slice(0, 8);
      if (!rm.size && !chg.length && !add.length) { setAgent('talk', r.note ? String(r.note).slice(0, 160) : 'The retouch looks natural.'); await sleep(800); break; }
      if (r.note) { setAgent('talk', String(r.note).slice(0, 160)); await sleep(900); }
      for (const c of chg) { const i = (c.n | 0) - 1; if (!cur[i]) continue; const v = Math.max(0, Math.min(70, +c.strength)); setAgent('adjust', `${cur[i].why || 'Stroke ' + (i + 1)}: ${cur[i].strength}% → ${Math.round(v)}%`);
        change(s => { const a = s.aiStrokes.slice(); a[i] = Object.assign({}, a[i], { strength: v }); s.aiStrokes = a; }, { all: [p] }); await renderIdle(3000); await sleep(350); }
      if (rm.size) { setAgent('adjust', `Taking out ${rm.size} stroke${rm.size > 1 ? 's' : ''} that didn't look right.`); change(s => { s.aiStrokes = s.aiStrokes.filter((_, i) => !rm.has(i)); }, { all: [p] }); await renderIdle(3000); await sleep(400); }
      for (const st of add) { setAgent('adjust', `${st.mode === 'dodge' ? 'Dodging' : 'Burning'} ${st.why || 'a new stroke'} (${st.strength}%)`); await paintStrokeOnScreen(p, st); }
      handOff(); if (r.done === true) break;
    }
    const n = (p.s.aiStrokes || []).length; return n ? `painted ${n} dodge and burn strokes by hand and checked them.` : '';
  }
  async function retouchOnly(p) {
    if (!S.sample || AG.busy || !p || !p.eyeBlob) return;
    learnSweep(); AG.busy = true; AG.follow = true; AG.now = ''; AG.msg = null; document.body.classList.add('ai-busy'); renderRight(); hudShow(true); corePhase('work'); hudStage(null, 'Finding the people');
    S.busy = { text: 'AI editor: dodge & burn by hand', frac: 0 }; progress(); etaStart(3 * (AG.avgCall || 25) + 60);
    try { if (!(p.s.people && p.s.people.length)) await detectPeople([p], true);
      if (!(p.s.people && p.s.people.length)) throw new Error('No people found in this photo, so there is nothing to retouch.');
      await renderForAgent(p); const n = await handRetouch(p, p.eyeBlob, null, AG.text && AG.text.trim());
      p.agentNote = n ? 'Retouch: ' + n : p.agentNote; p.aiSnap = aiSnapOf(p); persist(p); setAgent('talk', n ? 'Retouch done.' : 'Nothing to retouch.'); notifyDone('Retouch done.'); }
    catch (e) { AG.msg = ['err', e && e.message || String(e)]; setAgent('idle', AG.msg[1]); }
    etaStop(); S.busy = null; progress(); AG.busy = false; document.body.classList.remove('ai-busy'); handOff(); hudShow(false); corePhase(AG.msg && AG.msg[0] === 'err' ? null : 'done'); AG.stageId = null; renderRight();
  }
  /* ---- learning from the photographer: after the AI edits a photo, the changes they make to its sliders are what it got wrong.
     Those corrections are averaged across photos and every later edit starts from them. ---- */
  const LEARN_KEYS = () => Object.keys(AGENT_KEYS).filter(k => k !== 'angle');
  S.lessons = (() => { try { return JSON.parse(lsGet('lookmatch.lessons', '') || 'null'); } catch (e) { return null; } })() || { keys: {}, photos: 0 };
  /* ---------- learning his style from his own finished edits (camera original + his edit, matched by file name) ---------- */
  S.style = (() => { try { return JSON.parse(lsGet('lookmatch.style', '') || 'null'); } catch (e) { return null; } })();
  function saveStyle() { lsSet('lookmatch.style', JSON.stringify(S.style)); if (S.db) try { S.db.collection('prefs').doc('style').set(S.style || {}); } catch (e) { } }
  function statsOf(bmp) {
    const c = scaled(bmp, bmp.width, bmp.height, 320), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; c.width = c.height = 0;
    const Ls = [], C = [], nb = [], na = [], skD = [], skL = [], t = [0, 0, 0];
    for (let i = 0; i < d.length; i += 8) { LC.rgb2lab(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, t); const L = t[0], a = t[1], b = t[2], ch = Math.hypot(a, b), hu = Math.atan2(b, a) * 57.3;
      Ls.push(L); C.push(ch); if (ch < 12 && L > 25 && L < 90) { na.push(a); nb.push(b); }
      if (ch > 7 && ch < 45 && hu > 18 && hu < 75 && L > 12 && L < 85) (L < 45 ? skD : skL).push([L, a, b]); }
    const q = (A, f) => { if (!A.length) return null; const B = A.slice().sort((x, y) => x - y); return B[Math.min(B.length - 1, (B.length * f) | 0)]; };
    const med3 = A => A.length > 40 ? [0, 1, 2].map(k => q(A.map(v => v[k]), 0.5)) : null;
    return { L50: q(Ls, 0.5), L05: q(Ls, 0.05), L95: q(Ls, 0.95), C50: q(C, 0.5), C80: q(C, 0.8), na: q(na, 0.5), nb: q(nb, 0.5), skD: med3(skD), skL: med3(skL) };
  }
  async function teachStyle(files) {
    const base = f => f.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const raw = /\.(cr2|cr3|nef|arw|raf|dng|orf|rw2|pef|srw)$/i, byKey = {};
    for (const f of files) { const k = base(f); (byKey[k] = byKey[k] || []).push(f); }
    // an edit is matched to its original by name: the original is the RAW (or the file whose name is contained in the edit's name)
    const keys = Object.keys(byKey), pairs = [];
    for (const k of keys) { const g = byKey[k]; if (g.length >= 2) { const o = g.find(f => raw.test(f.name)) || g[0], e = g.find(f => f !== o && !raw.test(f.name)); if (e) pairs.push([o, e]); } }
    for (const f of files) { if (raw.test(f.name)) continue; const k = base(f); if (byKey[k].length >= 2) continue; const ok = keys.find(o => o !== k && o.length >= 5 && k.includes(o) && byKey[o].length === 1); if (ok) pairs.push([byKey[ok][0], f]); }
    if (!pairs.length) { toast('No pairs found. Add each camera original with your finished edit of it, named the same (e.g. IMG_1234.CR3 and IMG_1234.jpg).', 7000); return; }
    S.busy = { text: `Learning your style from ${pairs.length} edit${pairs.length > 1 ? 's' : ''}`, stop: false }; progress();
    const rows = []; let i = 0;
    for (const [o, e] of pairs) { if (S.busy.stop) break; i++; S.busy.text = `Learning your style: ${i} of ${pairs.length}`; progress();
      try { const bo = await decode(o), be = await createImageBitmap(e); const so = statsOf(bo), se = statsOf(be); rows.push({ o: so, e: se }); } catch (err) { console.warn('style pair', o.name, err); } }
    S.busy = null; progress();
    if (!rows.length) { toast('Could not read those files.'); return; }
    const avg = f => { const v = rows.map(f).filter(x => x != null && isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const sk = (k, j) => avg(r => r.e[k] ? r.e[k][j] : null), skO = (k, j) => avg(r => r.o[k] && r.e[k] ? r.e[k][j] - r.o[k][j] : null);
    S.style = { n: rows.length, at: Date.now(),
      mid: avg(r => r.e.L50 - r.o.L50), blacks: avg(r => r.e.L05 - r.o.L05), whites: avg(r => r.e.L95 - r.o.L95), range: avg(r => (r.e.L95 - r.e.L05) - (r.o.L95 - r.o.L05)),
      rich: avg(r => r.o.C50 > 1 ? r.e.C50 / r.o.C50 : null), warm: avg(r => r.e.nb != null && r.o.nb != null ? r.e.nb - r.o.nb : null), tint: avg(r => r.e.na != null && r.o.na != null ? r.e.na - r.o.na : null),
      editL50: avg(r => r.e.L50), neutralB: avg(r => r.e.nb), deep: [sk('skD', 0), sk('skD', 1), sk('skD', 2)], light: [sk('skL', 0), sk('skL', 1), sk('skL', 2)], deepD: [skO('skD', 0), skO('skD', 1), skO('skD', 2)], lightD: [skO('skL', 0), skO('skL', 1), skO('skL', 2)] };
    saveStyle(); renderRight(); toast(`Learned your style from ${rows.length} of your edits.`, 5000);
  }
  function styleLines() { const t = S.style; if (!t || !t.n) return []; const f = (v, d = 1) => v == null ? '?' : (v > 0 ? '+' : '') + v.toFixed(d), o = [];
    o.push(`Midtones ${f(t.mid)} L, blacks ${f(t.blacks)}, whites ${f(t.whites)} (tonal range ${f(t.range)})`);
    if (t.rich != null) o.push(`Colour richness ×${t.rich.toFixed(2)}`);
    if (t.warm != null) o.push(`Neutrals ${t.warm > 0.5 ? 'warmer' : t.warm < -0.5 ? 'cooler' : 'about the same'} (${f(t.warm)} b), tint ${f(t.tint)} a`);
    if (t.deep && t.deep[0] != null) o.push(`Deep skin in your edits: L ${t.deep[0].toFixed(0)}, a ${t.deep[1].toFixed(0)}, b ${t.deep[2].toFixed(0)}${t.deepD[0] != null ? ` (${f(t.deepD[0])} L from camera)` : ''}`);
    if (t.light && t.light[0] != null) o.push(`Light skin in your edits: L ${t.light[0].toFixed(0)}, a ${t.light[1].toFixed(0)}, b ${t.light[2].toFixed(0)}${t.lightD[0] != null ? ` (${f(t.lightD[0])} L from camera)` : ''}`);
    return o; }
  function stylePrompt() { const l = styleLines(); return l.length ? `\nMEASURED FROM ${S.style.n} OF THIS PHOTOGRAPHER'S OWN FINISHED EDITS (his edit vs his camera original, in Lab). Make this photo move the same way, by about these amounts:\n- ${l.join('\n- ')}` : ''; }
  function aiSnapOf(p) { const o = {}; for (const k of LEARN_KEYS()) o[k] = p.s[k] ?? 0; o.hsl = clone(p.s.hsl); o.look = p.s.look || null; return o; }
  function saveLessons() { lsSet('lookmatch.lessons', JSON.stringify(S.lessons)); if (S.db) try { S.db.collection('prefs').doc('lessons').set(S.lessons); } catch (e) { } }
  function learnFrom(p) {
    if (!p || !p.aiSnap || AG.busy) return false; const a = p.aiSnap, L = S.lessons; let any = false;
    for (const k of LEARN_KEYS()) { const d = (p.s[k] ?? 0) - (a[k] ?? 0), R = AGENT_KEYS[k], tiny = k === 'ev' ? 0.08 : Math.max(3, (R[1] - R[0]) * 0.02); if (Math.abs(d) < tiny) continue;
      const e = L.keys[k] || (L.keys[k] = { sum: 0, n: 0 }); e.sum = e.sum * 0.9 + d; e.n = e.n * 0.9 + 1; any = true; }   /* recent corrections count most */
    for (const b of D.HSL_KEYS) for (let t = 0; t < 3; t++) { const d = (p.s.hsl[b][t] || 0) - ((a.hsl && a.hsl[b] && a.hsl[b][t]) || 0); if (Math.abs(d) < 4) continue;
      const k = `hsl.${b}.${t}`, e = L.keys[k] || (L.keys[k] = { sum: 0, n: 0 }); e.sum = e.sum * 0.9 + d; e.n = e.n * 0.9 + 1; any = true; }
    if (any) { L.photos = (L.photos || 0) + 1; saveLessons(); }
    p.aiSnap = aiSnapOf(p); persist(p); return any;
  }
  function lessonsList() { const out = []; for (const [k, e] of Object.entries(S.lessons.keys || {})) { if (!e || e.n < 0.5) continue; const avg = e.sum / Math.max(1, e.n); if (Math.abs(avg) < (k === 'ev' ? 0.05 : 2)) continue;
      const [nm, unit] = k.startsWith('hsl.') ? (() => { const [, b, t] = k.split('.'); return [`${b[0].toUpperCase() + b.slice(1)} ${['hue', 'saturation', 'brightness'][+t]}`, '']; })() : [SLIDER_NAMES[k] || k, ''];
      out.push({ k, nm, avg, txt: `${nm} ${avg > 0 ? 'higher' : 'lower'} by about ${k === 'ev' ? Math.abs(avg).toFixed(2) + ' stops' : Math.round(Math.abs(avg))}` }); }
    return out.sort((x, y) => Math.abs(y.avg) - Math.abs(x.avg)).slice(0, 10); }
  function lessonsPrompt() { return lessonsPrompt0() + stylePrompt(); }
  function lessonsPrompt0() { const l = lessonsList(); if (!l.length) return ''; return `\nLEARNED FROM THIS PHOTOGRAPHER'S OWN CORRECTIONS (after earlier AI edits, they moved these sliders by hand on ${Math.max(1, S.lessons.photos || 0)} photo(s) so far). Lean your values this way: ${l.map(x => x.txt).join('; ')}.`; }
  // when they leave a photo the AI edited, or start a new AI edit, see what they changed
  function learnSweep() { let n = 0; for (const q of S.photos || []) if (q.aiSnap && learnFrom(q)) n++; if (n) toast(`Learned from your changes on ${n} photo${n > 1 ? 's' : ''}.`); }
  function agentPanel(p) {
    const real = !!p; if (!p) p = { s: D.defaults(), id: null };
    const multi = S.sel.size > 1 ? [...S.sel].map(photo).filter(Boolean) : null;
    const box = el('section', { class: 'sec agent' }, el('div', { class: 'sec-h' }, el('h2', { text: 'AI editor' }),
      el('label', { class: 'row mtog', title: 'Show the presets, brushes and quick tools' }, el('span', { text: 'Manual tools' }), el('span', { class: 'sw' }, el('input', { type: 'checkbox', checked: S.manual || null, 'aria-label': 'Manual tools', onchange: e => { S.manual = e.target.checked; lsSet('lookmatch.manual', S.manual ? '1' : '0'); render(); } }), el('span', { class: 'sw-t' })))));
    const holo = el('div', { class: 'holo', id: 'agHolo', 'data-state': AG.state || 'idle' }); if (AG.phase) holo.dataset.phase = AG.phase; holo.append(holoFace());
    box.append(el('div', { class: 'holo-row' }, holo, el('div', { class: 'holo-talk' }, el('p', { class: 'holo-say', id: 'agSay', 'aria-live': 'polite', text: AG.sayText || (AG.busy ? 'Working…' : 'Ready. Tell me what you want, or just press Edit.') }), el('p', { class: 'holo-eta', id: 'agEta', 'aria-live': 'polite' }), el('ol', { class: 'holo-log', id: 'agLog' }, ...(AG.busy && AG.log ? AG.log.slice(0, -1).map(t => el('li', { text: t })) : [])))));
    if (real && isEdited(p)) {
      const multi2 = S.sel.size > 1 ? [...S.sel].map(photo).filter(Boolean) : null;
      box.append(el('div', { class: 'row restart' }, el('span', { class: 'note', text: p.restored ? 'This photo still has its edit from last time.' : 'This photo has edits.' }),
        el('button', { class: 'btn sm', type: 'button', disabled: AG.busy || null, onclick: () => startOver([p]) }, 'Start over'),
        multi2 ? el('button', { class: 'btn sm ghost', type: 'button', disabled: AG.busy || null, onclick: () => startOver(multi2) }, `Start over on ${multi2.length}`) : null));
    }
    const ta = el('textarea', { rows: 2, placeholder: 'What do you want? e.g. "brighter face, keep the lights golden, make the dress white"', 'aria-label': 'Instructions for this edit', oninput: e => { AG.text = e.target.value; } }); ta.value = AG.text;
    const rz = dropzone(AG.refs.length ? 'Add more reference photos' : 'Match these photos (optional)', el('span', { text: AG.refs.length ? '' : 'Drop 1 to 4 finished photos. The editor makes yours look edited the same way.' }), true, files => {
      const add = [...files].filter(f => /^image\//.test(f.type) || /\.(cr2|cr3|nef|arw|dng|raf|orf|rw2|pef|srw)$/i.test(f.name)).slice(0, 4 - AG.refs.length);
      for (const f of add) AG.refs.push({ file: f, url: URL.createObjectURL(f) }); AG.refLookId = null; renderRight(); });
    const inBox = el('div', { class: 'ag-in sec' }); box.append(inBox); const bAppend = box.append.bind(box); box.append = (...a) => inBox.append(...a);
    if (!S.manual) {
      const sel = el('select', { class: 'text', id: 'agStyle', 'aria-label': 'Style for the AI', onchange: e => { AG.style = e.target.value || null; lsSet('lookmatch.agentStyle', AG.style || ''); } },
        el('option', { value: '', text: 'Your style notes only' }), ...S.looks.filter(L => !L.sample).map(L => el('option', { value: L.id, text: L.name + (L.creative ? ' (creative)' : '') })));
      sel.value = AG.style && lookById(AG.style) ? AG.style : '';
      box.append(el('label', { class: 'row agstyle', for: 'agStyle' }, el('span', { text: 'Style' }), sel));
      const ar = el('select', { class: 'text', id: 'agArea', 'aria-label': 'What the AI edits', onchange: e => { AG.area = e.target.value; lsSet('lookmatch.area', AG.area); if (real && AG.area === 'subject') change(s => { s.bgEdit = 0; s.bgBlur = 0; s.bokeh = 0; s.subjectOnly = true; if (s.studioTarget !== 'person') s.studioTarget = 'person'; }); else if (real) change(s => { s.subjectOnly = false; }); else if (real && AG.area === 'gentle') change(s => areaFix(s)); renderRight(); } },
        el('option', { value: 'subject', text: 'Subject only (background as shot)' }), el('option', { value: 'gentle', text: 'Subject, background barely changed' }), el('option', { value: 'whole', text: 'Whole photo' }));
      ar.value = AG.area || 'gentle';
      box.append(el('label', { class: 'row agstyle', for: 'agArea' }, el('span', { text: 'Edit' }), ar));
      const sg = el('select', { class: 'text', id: 'agStrength', 'aria-label': 'How strong the edit is', onchange: e => { AG.strength = e.target.value; lsSet('lookmatch.strength', AG.strength); if (activePhoto() && !AG.busy) { change(s => { s.editStrength = AG.strength; strengthFix(s); }); try { renderRight(); } catch (_) {} } } },
        el('option', { value: 'light', text: 'Light touch (smooth, keep the light)' }), el('option', { value: 'balanced', text: 'Balanced' }), el('option', { value: 'bold', text: 'Bold' }));
      sg.value = AG.strength || 'light';
      box.append(el('label', { class: 'row agstyle', for: 'agStrength' }, el('span', { text: 'Strength' }), sg));
      if (real && AG.area !== 'whole') box.append(el('p', { class: 'note area-note' + (p.s.people && p.s.people.length ? ' ok' : ''), text: p.s.people && p.s.people.length ? `${p.s.people.length} ${p.s.people.length > 1 ? 'people' : 'person'} found: edits stay on them${AG.area === 'subject' ? ', the background stays as shot' : ''}.` : (p.s.peopleDone ? 'No people found in this photo, so the background is protected with a best-guess outline. Tap "Find people again" in Manual tools if it missed someone.' : 'The AI finds the people first, then keeps its edits inside them.') }));
      if (real && p.s.look) box.append(slider(p, 'lookAmt', 'Look strength', 0, 150, { def: 100, fmt: v => v + '%' }));
      if (real) box.append(slider(p, 'beautify', 'Beautify', 0, 100, { id: 'beautify-ai' }));
    }
    box.append(rz);
    if (AG.refs.length) {
      box.append(el('div', { class: 'agrefs' }, ...AG.refs.map((r, i) => el('div', { class: 'agref' }, el('img', { src: r.url, alt: 'Reference ' + (i + 1) }),
        el('button', { type: 'button', 'aria-label': 'Remove reference ' + (i + 1), text: '✕', onclick: () => { URL.revokeObjectURL(r.url); AG.refs.splice(i, 1); AG.refLookId = null; renderRight(); } })))),
        el('label', { class: 'row', style: 'gap:8px;font-size:11.5px' }, el('input', { type: 'checkbox', checked: AG.notMine || null, onchange: e => { AG.notMine = e.target.checked; AG.refLookId = null; } }), el('span', { text: 'These are not my photos (keep only their colour data, no thumbnails)' })));
    }
    box.append(ta, el('div', { class: 'row' },
      el('button', { class: 'btn sm primary', type: 'button', disabled: !real || !S.sample || AG.busy || null, onclick: () => makeIdeas(p, AG.text.trim()) }, AG.busy ? 'Working…' : 'Show me ideas'),
      el('button', { class: 'btn sm', type: 'button', disabled: !real || !S.sample || AG.busy || null, onclick: () => { askNotify(); agentEdit([p], AG.text.trim()); } }, AG.busy ? 'Editing…' : AG.refs.length ? 'Match this photo' : 'Edit this photo'),
      el('button', { class: 'btn sm', type: 'button', title: 'The AI dodges and burns each face and body by hand, then checks and fixes its own strokes', disabled: !real || !S.sample || AG.busy || null, onclick: () => { askNotify(); retouchOnly(p); } }, 'Retouch by hand'),
      multi ? el('button', { class: 'btn sm', type: 'button', disabled: !S.sample || AG.busy || null, onclick: () => agentEdit(multi, AG.text.trim()) }, AG.refs.length ? `Match ${multi.length} selected` : `Edit ${multi.length} selected`) : null,
      AG.resume && !AG.busy ? el('button', { class: 'btn sm primary', type: 'button', disabled: !S.sample || null, onclick: () => { const r = AG.resume, l = r.ids.map(id => photo(id)).filter(Boolean); if (l.length) agentEdit(l, r.instruction || AG.lastInstr || '', r); } }, `Continue edit (${AG.resume.ids.length} to go)`) : null),
      el('label', { class: 'row', style: 'gap:8px;font-size:12px;margin-top:6px' }, el('input', { type: 'checkbox', checked: AG.approveEach || null, onchange: e => { AG.approveEach = e.target.checked; lsSet('lookmatch.approveEach', AG.approveEach ? '1' : '0'); } }), el('span', { text: 'Wait for my approval after each photo' })));
    if (!S.sample) box.append(el('p', { class: 'note', text: 'The AI editor needs Claude, available when this app is opened in Claude.' }));
    else if (!AG.refs.length && !p.s.look && !(AG.style && !S.manual)) box.append(el('p', { class: 'note', text: S.manual ? 'Turn on a look or drop reference photos so it has a style to match.' : 'Pick a style above or drop reference photos so it has something to match.' }));
    if (AG.msg) box.append(el('div', { class: 'msg ' + (AG.msg[0] === 'err' ? 'warn' : ''), text: AG.msg[1] }));
    if (!real) box.append(el('p', { class: 'note', text: 'Import a photo to start.' }));
    if (p.agentNote) box.append(el('p', { class: 'note', text: 'Last AI edit: ' + p.agentNote }));
    if (AG.ideas && AG.ideasFor === p.id) {
      box.append(el('div', { class: 'ideas' }, ...AG.ideas.map((it, i) => el('div', { class: 'idea' },
        el('button', { type: 'button', class: 'idea-img', 'aria-label': 'See ' + it.title + ' larger', onclick: () => showIdea(it) }, el('img', { src: it.url, alt: it.title })),
        el('b', { text: it.title }), it.s.look && lookById(it.s.look) ? el('span', { class: 'idea-look', text: 'Look: ' + lookById(it.s.look).name }) : (AG.refs.length ? el('span', { class: 'idea-look', text: 'Matches your reference photos' }) : null), el('span', { text: it.why }),
        el('button', { class: 'btn sm primary', type: 'button', disabled: AG.busy || null, onclick: () => doIdea(p, it) }, 'Do this edit')))));
    }
    const sd = el('details', null, el('summary', { text: 'Your style (the editor follows this on every photo)', style: 'font-size:11.5px;cursor:pointer' }));
    const st = el('textarea', { rows: 4, 'aria-label': 'Your style notes', onchange: e => { S.styleNotes = e.target.value; lsSet('lookmatch.styleNotes', S.styleNotes); toast('Style saved.'); } }); st.value = S.styleNotes;
    const ll = lessonsList();
    sd.append(st, el('div', { class: 'learned' }, el('b', { text: 'Learned from your corrections' }),
      ll.length ? el('ul', null, ...ll.map(x => el('li', { text: x.txt }))) : el('p', { class: 'note', text: 'After the AI edits a photo, change any slider you don\'t like. The next time you run the AI, it learns from what you changed and leans that way on every photo.' }),
      ll.length ? el('div', { class: 'row', style: 'gap:8px' }, el('button', { class: 'btn sm', type: 'button', onclick: () => { if (real) learnFrom(p); renderRight(); } }, 'Learn from this photo now'),
        el('button', { class: 'btn sm', type: 'button', onclick: () => { S.lessons = { keys: {}, photos: 0 }; saveLessons(); renderRight(); toast('Forgot what it learned.'); } }, 'Forget')) :
        (real && p.aiSnap ? el('button', { class: 'btn sm', type: 'button', onclick: () => { const ok = learnFrom(p); renderRight(); toast(ok ? 'Learned from your changes on this photo.' : 'No changes to learn from yet on this photo.'); } }, 'Learn from this photo now') : null)));
    { const fi = el('input', { type: 'file', multiple: true, accept: 'image/*,.cr2,.cr3,.nef,.arw,.raf,.dng,.orf,.rw2', hidden: true, onchange: e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) teachStyle(f); } }), sl = styleLines();
      sd.append(el('div', { class: 'learned' }, el('b', { text: S.style && S.style.n ? `Learned from ${S.style.n} of your finished edits` : 'Teach it your style from your own edits' }),
        sl.length ? el('ul', null, ...sl.map(x => el('li', { text: x }))) : el('p', { class: 'note', text: 'Pick camera originals together with your finished edits of them (same file names, e.g. IMG_1234.CR3 and IMG_1234.jpg). It measures how you move exposure, warmth, contrast, colour and each skin type, and the AI edits that way. 20 or more pairs from different light works best.' }),
        el('div', { class: 'row', style: 'gap:8px' }, fi, el('button', { class: 'btn sm', type: 'button', onclick: () => fi.click() }, S.style && S.style.n ? 'Teach from more edits' : 'Teach from my edits'),
          S.style && S.style.n ? el('button', { class: 'btn ghost sm', type: 'button', onclick: () => { S.style = null; saveStyle(); renderRight(); toast('Forgot your measured style.'); } }, 'Forget') : null))); }
    sd.append(el('label', { class: 'row', style: 'gap:8px;font-size:12px;margin-top:10px' }, el('input', { type: 'checkbox', checked: lsGet('lookmatch.keepEdits', '0') === '1' || null, onchange: e => { lsSet('lookmatch.keepEdits', e.target.checked ? '1' : '0'); toast(e.target.checked ? 'Photos you import again will keep their last edit.' : 'Photos you import again will start fresh.'); } }), el('span', { text: 'Keep a photo\'s last edit when I import it again' })));
    box.append(sd); box.append = bAppend;
    return box;
  }
  function actionsPanel(p) {
    const multi = S.sel.size > 1 ? [...S.sel].map(photo).filter(Boolean) : null;
    return el('section', { class: 'sec' },
      el('div', { class: 'row' },
        el('button', { class: 'btn sm', type: 'button', title: 'Auto: brighten faces, hold bright lights, add depth and color', onclick: () => autoFix(p, multi) }, multi ? `Auto ${multi.length}` : 'Auto'),
        el('button', { class: 'btn sm', type: 'button', title: 'Copy settings (⌘C)', onclick: copySettings }, 'Copy'),
        el('button', { class: 'btn sm', type: 'button', disabled: !S.clip, title: 'Paste settings (⌘V)', onclick: () => pasteSettings(multi) }, multi ? `Paste to ${multi.length}` : 'Paste'),
        el('button', { class: 'btn sm', type: 'button', disabled: !multi, title: 'Copy this photo\'s settings to the selected photos (crop and brushes stay)', onclick: () => { copySettings(); pasteSettings(multi); } }, multi ? `Sync ${multi.length}` : 'Sync'),
        el('button', { class: 'btn ghost sm danger', type: 'button', onclick: () => change(s => { const keep = { look: null, people: s.people || null, peopleDone: s.peopleDone }; Object.assign(s, D.defaults(), keep); }, {}) && renderRight() || setTimeout(renderRight) }, 'Reset')),
      el('label', { class: 'row', style: 'gap:8px;margin-top:6px;font-size:11.5px' }, el('span', { text: 'Auto pop' }),
        (() => { const sel = el('select', { 'aria-label': 'When Auto pop runs', style: 'flex:1;min-width:0', onchange: e => { S.autoMode = e.target.value; try { localStorage.setItem('lookmatch.autoMode', S.autoMode); } catch (x) { } toast(S.autoMode === 'import' ? 'Auto pop will run on every photo you import.' : S.autoMode === 'look' ? 'Auto pop will run when you turn on a look.' : 'Auto pop will only run when you click Auto.'); } },
          ...[['import', 'On import'], ['look', 'When I turn on a look'], ['manual', 'Only when I click Auto']].map(([v, t]) => el('option', { value: v, selected: S.autoMode === v || null, text: t }))); return sel; })()),
      multi ? el('p', { class: 'note', text: `${multi.length} selected. Sliders change the highlighted photo; use Sync or Paste to copy to the rest.` }) : null);
  }
  /* every look (regular, creative, auto-picked) gets Auto + dodge & burn on photos that haven't been corrected yet */
  S.autoMode = (() => { try { return localStorage.getItem('lookmatch.autoMode') || 'look'; } catch (e) { return 'look'; } })();
  const isFresh = t => t && t.state === 'ready' && !t.s.autoDone && !t.s.ev && !t.s.shadows && !t.s.subjLight;
  function autoIfFresh(list) { if (S.autoMode === 'manual') return; const fresh = (list || []).filter(t => t && !t.s.autoDone && !t.s.ev && !t.s.shadows && !t.s.subjLight); if (fresh.length) return autoFix(activePhoto(), fresh); }
  /* Ask Claude where the people are (body + face boxes), several photos per request. Saved with each photo, so it's asked once. */
  async function detectPeople(list, quiet) {
    list = (list || []).filter(t => t && t.eyeBlob && !t.s.peopleDone); if (!list.length || !S.sample) return 0;
    let per = 6; try { const lim = await S.sample.limits(); if (lim && lim.images && lim.images.maxPerRequest) per = Math.max(1, Math.min(6, lim.images.maxPerRequest)); } catch (e) { }
    const batches = []; for (let i = 0; i < list.length; i += per) batches.push(list.slice(i, i + per));
    const show = !quiet && list.length > 1; let done = 0, found = 0; if (show) { S.busy = { text: `Finding people 0 of ${list.length}`, frac: 0 }; progress(); }
    const ok = v => Array.isArray(v) && v.length === 4 && v.every(n => typeof n === 'number' && isFinite(n)) && v[2] > v[0] && v[3] > v[1];
    const nb = v => v.map(n => Math.min(1, Math.max(0, n / 1000)));
    const run = async b => {
      const prompt = `You are helping a wedding photographer's editing app find the people in ${b.length === 1 ? 'this photo' : 'these ' + b.length + ' photos'} so it can brighten faces and leave the background alone.
For each photo, in the order given, list the MAIN subjects only (the people being photographed: bride, groom, couple, family). Skip passers-by and blurred people in the background.
For each person give:
- body: [x0, y0, x1, y1], a box around everything visible of that person including hair, veil, dress, suit, arms and anything they hold
- face: [x0, y0, x1, y1], a tight box around the face only, forehead to chin and cheek to cheek, or null if the face is not visible
- eyes: [[x, y], [x, y]], the centre of each eye's pupil, the eye on the left of the photo first; nose: [x, y], the tip of the nose; mouth: [x, y], the centre of the mouth. Use null for any you cannot see.
All numbers are integers from 0 to 1000, relative to that photo's full width (x) and height (y).
Reply with JSON only: [{"photo":1,"people":[{"body":[0,0,0,0],"face":[0,0,0,0],"eyes":[[0,0],[0,0]],"nose":[0,0],"mouth":[0,0]}]}] with one entry per photo. Use an empty people list when a photo has no main subject.`;
      try {
        const out = await S.sample.json(prompt, { images: b.map(t => t.eyeBlob), modelTier: 'default' });
        const arr = Array.isArray(out) ? out : (out && out.photos) || [];
        b.forEach((t, k) => { const e = arr.find(x => x && +x.photo === k + 1) || arr[k]; if (!e || !Array.isArray(e.people)) return;
          const ppl = e.people.filter(q => q && ok(q.body)).slice(0, 8).map(q => { const pt = v => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && isFinite(n)) ? nb(v) : null, e = Array.isArray(q.eyes) ? q.eyes.map(pt) : [];
            const lm = e[0] && e[1] ? { le: e[0][0] <= e[1][0] ? e[0] : e[1], re: e[0][0] <= e[1][0] ? e[1] : e[0], n: pt(q.nose), m: pt(q.mouth) } : null;
            return { b: nb(q.body), f: ok(q.face) ? nb(q.face) : null, lm }; });
          t.s.people = ppl; t.s.peopleDone = true; if (ppl.length) found++; persist(t); });
      } catch (e) { if (e && e.code === 'not_granted') S.sampleDenied = true; }
      done += b.length; if (show && S.busy) { S.busy.text = `Finding people ${Math.min(done, list.length)} of ${list.length}`; S.busy.frac = done / list.length; progress(); }
    };
    let bi = 0; const worker = async () => { while (bi < batches.length && !S.sampleDenied && !(S.busy && S.busy.stop)) await run(batches[bi++]); };
    await Promise.all([worker(), worker()]);
    if (show) { S.busy = null; progress(); }
    return found;
  }
  async function autoValues(t) {
    const sb = await smallSource(t), c = scaled(sb, sb.width, sb.height, 640), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const small = D.smallFrom(d, c.width, c.height, P.MAPLONG); c.width = c.height = 0;
    const nz = t.iso ? (t.iso >= 12800 ? 75 : t.iso >= 6400 ? 65 : t.iso >= 3200 ? 55 : t.iso >= 1600 ? 45 : t.iso >= 800 ? 35 : 25) : 30;   // he wants no grain: noise reduction always on, stronger at high ISO   // high ISO: noise reduction to match
    const out = t.s.people && t.s.people.length ? (() => { const pm = D.peopleMasks(small, P.boxMaps(t.s.people, null, sb.width, sb.height, small.w, small.h), null); return D.autoPop(small, { mask: pm.person, frac: pm.frac }, pm.facePx); })() : D.autoPop(small, D.subjectMask(small));
    if (nz != null) out.noise = nz;
    { const v = []; for (let i = 0; i < small.rgb.length; i += 9) v.push(0.299 * small.rgb[i] + 0.587 * small.rgb[i + 1] + 0.114 * small.rgb[i + 2]); v.sort((a, b) => a - b); const med = v[(v.length * 0.5) | 0] * Math.pow(2, out.ev || 0);
      if (med < 0.2) { out.rescue = med < 0.08 ? 75 : med < 0.14 ? 60 : 40; out.noise = Math.max(out.noise || 0, 40); } }   // dark and night photos come up by area, not by exposure alone
    return out;
  }
  /* Auto: exposure + warmth kept, faces brought up, bright lights held, depth and colour added. Works on every selected photo. */
  async function autoFix(p, list) {
    const targets = (list && list.length ? list : [p]).filter(Boolean); if (!targets.length) return;
    if (S.sample && !S.sampleDenied) await detectPeople(targets);
    let done = 0; const many = targets.length > 1; if (many) { S.busy = { text: `Auto 0 of ${targets.length}`, frac: 0 }; progress(); }
    for (const t of targets) {
      if (many && S.busy && S.busy.stop) break;
      try { const a = await autoValues(t); t.aiSnap = null; change(s => { Object.assign(s, a); s.autoDone = true; }, { all: [t] }); } catch (e) { }
      done++; if (many && S.busy) { S.busy.text = `Auto ${done} of ${targets.length}`; S.busy.frac = done / targets.length; progress(); }
    }
    if (many) { S.busy = null; progress(); }
    renderRight(); toast(many ? `Auto applied to ${done} photos.` : 'Auto applied: light on faces, bright lights held, depth and color added.');
  }
  const NOGEOM = s => { const o = clone(s); delete o.crop; delete o.angle; delete o.rot; delete o.flipH; delete o.aspect; delete o.people; delete o.peopleDone; return o; };
  function copySettings() { const p = activePhoto(); if (!p) return; S.clip = NOGEOM(p.s); toast('Settings copied (crop and brush work not included).'); renderRight(); }
  function pasteSettings(list) { if (!S.clip) return; const targets = list || [activePhoto()]; change((s) => Object.assign(s, clone(S.clip)), { all: targets }); toast(`Pasted to ${targets.length} photo${targets.length > 1 ? 's' : ''}.`); renderRight(); renderLeft(); }

  function slider(p, key, label, min, max, opts) {
    opts = opts || {}; const get = opts.get || (s => s[key]), set = opts.set || ((s, v) => { s[key] = v; });
    const val = get(p.s), id = 'sl-' + (opts.id || key), step = opts.step || 1, fmt = opts.fmt || (v => (v > 0 && min < 0 ? '+' : '') + (step < 1 ? (+v).toFixed(2) : v));
    const out = el('output', { for: id, text: fmt(val) });
    const inp = el('input', { type: 'range', id, min, max, step, value: val });
    const fill = () => { const z = (Math.min(max, Math.max(min, 0)) - min) / (max - min) * 100, v = (+inp.value - min) / (max - min) * 100; inp.style.setProperty('--lo', Math.min(z, v) + '%'); inp.style.setProperty('--hi', Math.max(z, v) + '%'); }; fill();
    let began = false;
    inp.onpointerdown = () => { if (!began) { pushUndo(p); began = true; } };
    inp.oninput = () => { if (!began) { pushUndo(p); began = true; } const v = +inp.value; set(p.s, v); out.textContent = fmt(v); fill(); row.classList.toggle('mod', v !== (opts.def ?? 0)); scheduleRender('draft'); };
    inp.onchange = () => { began = false; persist(p); scheduleRender('final'); updateCell(p); };
    inp.ondblclick = () => { pushUndo(p); const d = opts.def ?? 0; inp.value = d; set(p.s, d); out.textContent = fmt(d); fill(); row.classList.remove('mod'); persist(p); scheduleRender('final'); };
    const row = el('div', { class: 'sl' + (val !== (opts.def ?? 0) ? ' mod' : '') + (opts.cls ? ' ' + opts.cls : ''), title: 'Double-click to reset' }, el('label', { for: id }, opts.dot ? el('span', { class: 'swatch-dot', style: `background:${opts.dot}` }) : null, label), inp, out);
    return row;
  }
  function basicPanel(p) {
    return el('details', { class: 'sec', open: true }, el('summary', { text: 'Light & color' }),
      slider(p, 'temp', 'Temperature', -100, 100, { cls: 'temp' }), slider(p, 'tint', 'Tint', -100, 100, { cls: 'tint' }),
      slider(p, 'ev', 'Exposure', -3, 3, { step: 0.05, fmt: v => (v > 0 ? '+' : '') + (+v).toFixed(2) }), slider(p, 'subjLight', 'Subject light', 0, 200),
      el('div', { class: 'row', style: 'gap:8px;margin:-2px 0 6px' },
        el('button', { class: 'btn sm', type: 'button', disabled: !S.sample || null, title: 'Claude looks at the photo and marks each person and face, so light and skin edits land exactly on them', onclick: async () => { const multi = S.sel.size > 1 ? [...S.sel].map(photo).filter(Boolean) : [p]; multi.forEach(t => { t.s.peopleDone = false; }); toast('Finding people…'); const f = await detectPeople(multi); P.clear(); scheduleRender('final'); renderRight(); toast(f ? `People found in ${f} photo${f > 1 ? 's' : ''}.` : 'No people found. Use the Subject brush to mark them.'); } }, p.s.people && p.s.people.length ? 'Find people again' : 'Find people'),
        el('span', { class: 'note', text: !S.sample ? 'Needs Claude (open this app in Claude)' : p.s.people && p.s.people.length ? `${p.s.people.length} found · edits follow them exactly` : 'Not found yet · Subject light, skin, blur, bokeh and person-only edits stay off until people are found' })), slider(p, 'skinMatch', 'Skin match', 0, 100), slider(p, 'skinSmooth', 'Skin smoothing', 0, 100), slider(p, 'beautify', 'Beautify', 0, 100),
      slider(p, 'bgEdit', 'Background edit', 0, 100, { def: 100, fmt: v => v + '%' }),
      el('label', { class: 'row', style: 'gap:8px;font-size:11px;margin:-2px 0 6px' }, el('input', { type: 'checkbox', checked: (p.s.bgEdit ?? 100) === 0 || null, onchange: e => { const v = e.target.checked ? 0 : 100, multi = S.sel.size > 1 ? [...S.sel].map(photo).filter(Boolean) : null; change(s => { s.bgEdit = v; }, multi ? { all: multi } : {}); renderRight(); } }), el('span', { text: 'Edit the person only (background stays as shot)' })),
      slider(p, 'contrast', 'Contrast', -100, 100), slider(p, 'highlights', 'Highlights', -100, 100), slider(p, 'shadows', 'Shadows', -100, 100),
      slider(p, 'whites', 'Whites', -100, 100), slider(p, 'blacks', 'Blacks', -100, 100),
      slider(p, 'vibrance', 'Vibrance', -100, 100), slider(p, 'saturation', 'Saturation', -100, 100));
  }
  const HSLC = { red: '#e0534a', orange: '#e8913a', yellow: '#e2cf3e', green: '#58b45a', aqua: '#4fc0c0', blue: '#4a78d8', purple: '#8a5fd0', magenta: '#d65aa8' };
  function hslPanel(p) {
    const box = el('details', { class: 'sec' }, el('summary', { text: 'Color mixer' }));
    const tabs = el('div', { class: 'tabs' }, ...['Hue', 'Saturation', 'Luminance'].map((t, i) => el('button', { type: 'button', 'aria-pressed': S.hslTab === i, text: t, onclick: () => { S.hslTab = i; const o = box.open; const nb = hslPanel(p); nb.open = o; box.replaceWith(nb); } })));
    box.append(tabs);
    for (const k of D.HSL_KEYS) box.append(slider(p, null, k[0].toUpperCase() + k.slice(1), -100, 100, { id: 'hsl-' + k + S.hslTab, dot: HSLC[k], get: s => s.hsl[k][S.hslTab], set: (s, v) => { s.hsl[k][S.hslTab] = v; } }));
    box.append(el('p', { class: 'note', text: 'Shift, strengthen or brighten one color family, like greens in foliage or the orange in skin.' }));
    return box;
  }
  function skyPanel(p) {
    return el('details', { class: 'sec' }, el('summary', { text: 'Sky' }),
      el('p', { class: 'note', text: 'Finds the sky automatically (blue, overcast or sunset) and adjusts only that area.' }),
      slider(p, 'skyExp', 'Brightness', -100, 100), slider(p, 'skySat', 'Saturation', -100, 100), slider(p, 'skyTemp', 'Warmth', -100, 100));
  }
  function removePanel(p) {
    const list = p.s.removals || [];
    const box = el('details', { class: 'sec', open: list.length || S.tool === 'remove' || S.tool === 'unremove' || null, ontoggle: e => { S.showRm = e.target.open; drawOverlay(); } }, el('summary', { text: 'Remove distractions' }));
    box.append(el('p', { class: 'note', text: 'Claude points out people walking by and clutter. Tick what to remove, or paint over anything with the Remove brush. Works best on walls, sky, grass and soft backgrounds.' }));
    box.append(el('div', { class: 'row' },
      el('button', { class: 'btn sm primary', type: 'button', disabled: !S.sample || RM.busy || null, onclick: () => findDistractions(p) }, RM.busy ? 'Looking…' : list.length ? 'Look again' : 'Find distractions'),
      el('button', { class: 'btn sm', type: 'button', 'aria-pressed': S.tool === 'remove', onclick: () => setTool(S.tool === 'remove' ? 'none' : 'remove') }, S.tool === 'remove' ? '● Painting' : 'Remove brush'),
      el('button', { class: 'btn sm', type: 'button', 'aria-pressed': S.tool === 'unremove', onclick: () => setTool(S.tool === 'unremove' ? 'none' : 'unremove') }, 'Restore brush')));
    if (!S.sample) box.append(el('p', { class: 'note', text: 'Finding distractions needs Claude, available when this app is opened in Claude. The Remove brush always works.' }));
    if (RM.msg) box.append(el('div', { class: 'msg ' + RM.msg[0], text: RM.msg[1] }));
    if (list.length) {
      box.append(el('div', { class: 'radio' }, ...list.map((r, i) => el('label', null, el('input', { type: 'checkbox', checked: r.on || null, onchange: e => { pushUndo(p); r.on = e.target.checked; afterChange(p, false); drawOverlay(); } }), el('span', null, `${i + 1}. ${r.label}`, el('small', { text: r.kind === 'person' ? 'Person' : 'Object' }))))));
      box.append(el('div', { class: 'row' }, el('button', { class: 'btn ghost sm', type: 'button', onclick: () => { pushUndo(p); list.forEach(r => r.on = r.kind === 'person' || (r.kind === 'blemish' && r.on)); afterChange(p, true); } }, 'Tick all people'), el('button', { class: 'btn ghost sm', type: 'button', onclick: () => { pushUndo(p); list.forEach(r => r.on = false); afterChange(p, true); } }, 'Untick all')));
    }
    if (p.rm) box.append(el('button', { class: 'btn ghost sm', type: 'button', onclick: () => { pushUndo(p); p.rm = null; afterChange(p, true); drawOverlay(); } }, 'Clear Remove brush'));
    return box;
  }
  const RM = { busy: false, msg: null };
  async function findDistractions(p) {
    if (!S.sample || !V.last) return;
    RM.busy = true; RM.msg = null; renderRight();
    try {
      const c = scaled(V.last.canvas, V.last.w, V.last.h, 1280), blob = await toBlob(c, 0.86); c.width = c.height = 0;
      const prompt = `This photo is from a professional wedding and event photographer who wants a clean final image.
List the distracting elements they might want to remove:
- people who are NOT the main subjects: passers-by, guests walking through, people in the background, a stray arm, shoulder or head at the frame edge
- objects: exit signs, trash, cords, cups, bottles, poles, stray chairs, signs, bright distracting spots
Never list the main subjects or anything touching them.
For each item give: label (2-5 words), kind ("person" or "object"), box [x0, y0, x1, y1] as integers from 0 to 1000 relative to the full image width and height, fitting the item tightly.
Also give subjects: a few words naming the main subjects.
Reply with JSON only: {"subjects":"...","items":[{"label":"...","kind":"person","box":[0,0,0,0]}]}. At most 12 items. If nothing is distracting, return an empty items list.`;
      const out = await S.sample.json(prompt, { images: [blob], modelTier: 'default' });
      const items = ((out && out.items) || []).filter(it => Array.isArray(it.box) && it.box.length === 4).slice(0, 12).map(it => { const [x0, y0, x1, y1] = it.box.map(v => Math.max(0, Math.min(1000, +v || 0)) / 1000); return { label: String(it.label || 'Item').slice(0, 40), kind: it.kind === 'person' ? 'person' : 'object', box: [Math.min(x0, x1), Math.min(y0, y1), Math.max(0.01, Math.abs(x1 - x0)), Math.max(0.01, Math.abs(y1 - y0))], on: false }; });
      pushUndo(p); p.s.removals = (p.s.removals || []).filter(r => r.kind === 'blemish').concat(items); persist(p);
      RM.msg = items.length ? ['ok', `Found ${items.length}. Tick the ones to remove; numbers match the boxes on the photo.${out.subjects ? ' Main subjects: ' + out.subjects + '.' : ''}`] : ['ok', 'Nothing distracting found. Use the Remove brush for anything else.'];
      S.showRm = true;
    } catch (e) { RM.msg = ['err', e && e.code === 'not_granted' ? 'Claude was not allowed to look at this photo.' : 'Could not check this photo. Try again in a moment.']; }
    RM.busy = false; renderRight(); drawOverlay();
  }
  /* added light, for shots taken without flash */
  /* Curves, like a Photoshop curves layer with a mask: drag the line up to brighten, down to darken; choose where it applies */
  function curvePanel(p) {
    const c = p.s.curve || null, pts = c && Array.isArray(c.pts) ? c.pts.map(q => q.slice()) : [[0, 0], [1, 1]], tgt = c && c.target || 'subject';
    const det = el('details', { class: 'sec', open: S.curveOpen || null, ontoggle: e => { S.curveOpen = e.target.open; } }, el('summary', { text: 'Curve' }));
    const W = 240, H = 240, cv = el('canvas', { class: 'curve-cv', width: W * 2, height: H * 2, role: 'img', 'aria-label': 'Tone curve. Drag the line to brighten or darken.' }); cv.style.width = '100%'; cv.style.maxWidth = W + 'px'; cv.style.aspectRatio = '1';
    let P = pts, drag = -1;
    const fn = () => D.curveFn(P);
    const draw = () => { const x = cv.getContext('2d'), w = cv.width, h = cv.height; x.clearRect(0, 0, w, h); x.fillStyle = '#18191d'; x.fillRect(0, 0, w, h);
      x.strokeStyle = 'rgba(255,255,255,.08)'; x.lineWidth = 2; for (let k = 1; k < 4; k++) { x.beginPath(); x.moveTo(k * w / 4, 0); x.lineTo(k * w / 4, h); x.moveTo(0, k * h / 4); x.lineTo(w, k * h / 4); x.stroke(); }
      x.strokeStyle = 'rgba(255,255,255,.25)'; x.setLineDash([6, 6]); x.beginPath(); x.moveTo(0, h); x.lineTo(w, 0); x.stroke(); x.setLineDash([]);
      const f = fn(); x.strokeStyle = '#ffd08a'; x.lineWidth = 4; x.beginPath(); for (let i = 0; i <= 255; i++) { const X = i / 255 * w, Y = h - f[i] * h; i ? x.lineTo(X, Y) : x.moveTo(X, Y); } x.stroke();
      for (const [i, q] of P.entries()) { x.beginPath(); x.arc(q[0] * w, h - q[1] * h, i === drag ? 12 : 9, 0, 7); x.fillStyle = i === drag ? '#ffd08a' : '#25262b'; x.fill(); x.strokeStyle = '#ffd08a'; x.lineWidth = 3; x.stroke(); } };
    const at = e => { const r = cv.getBoundingClientRect(); return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height))]; };
    const commit = (final) => { const v = P.map(q => [+q[0].toFixed(3), +q[1].toFixed(3)]), flat = v.length === 2 && v[0][1] === 0 && v[1][1] === 1; change(s => { s.curve = flat ? null : { pts: v, target: (s.curve && s.curve.target) || tgt }; }, { all: [p], draft: !final, undo: final }); };
    cv.onpointerdown = e => { e.preventDefault(); cv.setPointerCapture(e.pointerId); const [u, v] = at(e); let best = -1, bd = 0.06;
      P.forEach((q, i) => { const d = Math.hypot(q[0] - u, q[1] - v); if (d < bd) { bd = d; best = i; } });
      if (best < 0) { P.push([u, v]); P.sort((a, b) => a[0] - b[0]); best = P.findIndex(q => q[0] === u && q[1] === v); }
      drag = best; draw(); };
    cv.onpointermove = e => { if (drag < 0) return; const [u, v] = at(e); const q = P[drag];
      if (drag === 0) { q[0] = 0; q[1] = v; } else if (drag === P.length - 1) { q[0] = 1; q[1] = v; } else { q[0] = Math.max(P[drag - 1][0] + 0.02, Math.min(P[drag + 1][0] - 0.02, u)); q[1] = v; }
      draw(); commit(false); };
    cv.onpointerup = () => { if (drag < 0) return; drag = -1; draw(); commit(true); };
    cv.ondblclick = e => { const [u, v] = at(e); const i = P.findIndex((q, k) => k > 0 && k < P.length - 1 && Math.hypot(q[0] - u, q[1] - v) < 0.06); if (i > 0) { P.splice(i, 1); draw(); commit(true); } };
    // keyboard: arrows nudge the middle of the curve (brighten/darken), for people who don't drag
    cv.tabIndex = 0; cv.onkeydown = e => { if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return; e.preventDefault(); let i = P.findIndex(q => Math.abs(q[0] - 0.5) < 0.01); if (i < 0) { P.push([0.5, 0.5]); P.sort((a, b) => a[0] - b[0]); i = P.findIndex(q => q[0] === 0.5); }
      P[i][1] = Math.max(0, Math.min(1, P[i][1] + (e.key === 'ArrowUp' ? 0.02 : -0.02))); draw(); commit(true); };
    const preset = (name, v) => el('button', { class: 'btn sm', type: 'button', onclick: () => { P = v.map(q => q.slice()); draw(); commit(true); } }, name);
    const sel = el('select', { class: 'text', id: 'curveTarget', 'aria-label': 'Where the curve applies', onchange: e => { const t = e.target.value; change(s => { s.curve = { pts: (s.curve && s.curve.pts) || P, target: t }; }, { all: [p] }); } },
      el('option', { value: 'subject', text: 'The people only (mask)' }), el('option', { value: 'background', text: 'Background only' }), el('option', { value: 'whole', text: 'Whole photo' }));
    sel.value = tgt;
    const known = p.s.people && p.s.people.length;
    det.append(cv, el('label', { class: 'row agstyle', for: 'curveTarget', style: 'margin-top:8px' }, el('span', { text: 'Apply to' }), sel),
      el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-top:6px' }, preset('Brighten', [[0, 0], [0.45, 0.55], [1, 1]]), preset('Lift shadows', [[0, 0.03], [0.25, 0.33], [0.6, 0.64], [1, 1]]), preset('Darken', [[0, 0], [0.55, 0.45], [1, 1]]), preset('Reset', [[0, 0], [1, 1]])),
      el('p', { class: 'note', text: (tgt !== 'whole' && !known ? 'The people haven\'t been found yet, so the mask uses a best guess. ' : '') + 'Drag the line up to brighten, down to darken. Click to add a point, double-click a point to remove it.' }));
    requestAnimationFrame(draw);
    return det;
  }
  function lightPanel(p) {
    const ok = !!(p.s.people && p.s.people.length);
    const pick = (key, label, opts) => { const sel = el('select', { class: 'text', id: 'sel-' + key, 'aria-label': label, onchange: e => { change(s => { s[key] = e.target.value; }); } }, ...opts.map(([v, t]) => el('option', { value: v, text: t }))); sel.value = p.s[key]; return el('label', { class: 'row agstyle', for: 'sel-' + key }, el('span', { text: label, style: 'width:82px' }), sel); };
    return el('details', { class: 'sec', open: true }, el('summary', { text: 'Light' }),
      slider(p, 'rescue', 'Night rescue', 0, 100),
      el('div', { class: 'row', style: 'gap:8px;margin:-2px 0 6px' }, el('button', { class: 'btn sm', type: 'button', title: 'Measures how dark the photo is and sets Night rescue, Face light and Noise reduction to match', onclick: () => rescueNow(p) }, 'Rescue this dark photo')),
      slider(p, 'faceLight', 'Face light', 0, 100),
      ok ? null : el('p', { class: 'note', text: 'Face light needs the people found first (Find people under Light & color).' }),
      slider(p, 'studioLight', 'Studio light', 0, 100),
      pick('studioDir', 'From', [['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right'], ['front', 'Front'], ['spot', 'Placed spot']]),
      slider(p, 'studioWarm', 'Light colour', -100, 100, { cls: 'temp' }), slider(p, 'studioX', 'Light across', 0, 1000), slider(p, 'studioY', 'Light height', 0, 1000),
      pick('studioTarget', 'Light on', [['person', 'The person'], ['background', 'The background'], ['both', 'Everything']]),
      slider(p, 'noise', 'Noise reduction', 0, 100),
      el('p', { class: 'note', text: 'For dark and night shots: Night rescue brings up dark areas while lights and highlights stay put. Face light brightens faces, Studio light adds a big soft light, Noise reduction cleans up high-ISO grain.' }));
  }
  /* one click for a dark or night photo: how dark it is decides how much rescue, face light and noise reduction it gets */
  async function rescueNow(p) {
    try { const sb = await smallSource(p), c = scaled(sb, sb.width, sb.height, 320), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, v = [];
      for (let i = 0; i < d.length; i += 16) v.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); v.sort((a, b) => a - b); c.width = c.height = 0;
      const med = v[(v.length * 0.5) | 0] / 255, ev = Math.pow(2, p.s.ev || 0), m = med * ev, amt = m < 0.08 ? 85 : m < 0.14 ? 70 : m < 0.22 ? 55 : m < 0.32 ? 35 : 20;
      change(s => { s.rescue = amt; s.noise = Math.max(s.noise || 0, amt > 60 ? 50 : 35); if (s.people && s.people.length) s.faceLight = Math.max(s.faceLight || 0, amt > 60 ? 20 : 12); s.highlights = Math.min(s.highlights || 0, -15); });
      renderRight(); toast && toast(`Night rescue set to ${amt}`); } catch (e) { console.warn(e); }
  }
  function retouchPanel(p) {
    const ok = !!(p.s.people && p.s.people.length);
    return el('details', { class: 'sec', open: true }, el('summary', { text: 'Skin & retouch' }),
      slider(p, 'skinSmooth', 'Skin smoothing', 0, 100), slider(p, 'beautify', 'Beautify', 0, 100),
      slider(p, 'heal', 'Blemish heal', 0, 100), slider(p, 'shine', 'Shine control', 0, 100),
      slider(p, 'eyes', 'Eyes', 0, 100), slider(p, 'teeth', 'Teeth', 0, 100),
      slider(p, 'fabric', 'Fabric wrinkles', 0, 100), slider(p, 'flyaways', 'Flyaway hair', 0, 100),
      slider(p, 'faceRestore', 'Face restore', 0, 100),
      el('div', { class: 'sub-h', text: 'Shape', style: 'font-size:11px;opacity:.7;margin:8px 0 2px' }),
      slider(p, 'faceSlim', 'Slim face', 0, 100), slider(p, 'jaw', 'Jawline', 0, 100), slider(p, 'eyesBig', 'Bigger eyes', 0, 100), slider(p, 'bodySlim', 'Slim body', 0, 100),
      ok ? null : el('p', { class: 'note', text: 'Skin tools need the people found first (Find people under Light & color).' }));
  }
  function effectsPanel(p) {
    return el('details', { class: 'sec', open: true }, el('summary', { text: 'Effects & detail' }),
      slider(p, 'glow', 'Glow', 0, 100), slider(p, 'flare', 'Sun flare', 0, 100),
      slider(p, 'flareX', 'Flare across', 0, 1000), slider(p, 'flareY', 'Flare height', 0, 1000), slider(p, 'flareWarm', 'Flare warmth', 0, 100),
      slider(p, 'pop', 'Pop', 0, 100),
      slider(p, 'bgBlur', 'Background blur', 0, 100), slider(p, 'bokeh', 'Bokeh lights', 0, 100),
      slider(p, 'dodgeBurn', 'Dodge & burn', 0, 100),
      el('label', { class: 'row', style: 'gap:8px;font-size:11px;margin:-2px 0 6px' }, el('input', { type: 'checkbox', checked: S.showDB || null, onchange: e => { S.showDB = e.target.checked; drawOverlay(); } }), el('span', { text: 'Show where (gold = dodged, blue = burned)' })),
      slider(p, 'clarity', 'Clarity', -100, 100), slider(p, 'dehaze', 'Dehaze', -100, 100), slider(p, 'vignette', 'Vignette', -100, 100),
      slider(p, 'grain', 'Grain', 0, 100), slider(p, 'sharpen', 'Sharpening', 0, 100, { def: 0 }),
      el('div', { class: 'row' }, el('button', { class: 'btn sm', type: 'button', onclick: () => setTool('crop') }, 'Crop & straighten'),
        el('button', { class: 'btn ghost sm', type: 'button', disabled: !p.brush, onclick: () => { pushUndo(p); p.brush = null; afterChange(p, true); } }, 'Clear dodge & burn')));
  }
  function cropPanel(p) {
    const s = p.s;
    return el('section', { class: 'sec' }, el('div', { class: 'sec-h' }, el('h2', { text: 'Crop & straighten' })),
      el('p', { class: 'note', text: 'Drag the corners or the box on the photo. Drag outside the box to draw a new one.' }),
      el('label', { class: 'sl', for: 'aspSel', style: 'grid-template-columns:82px minmax(0,1fr)' }, el('span', { text: 'Aspect' }),
        el('select', { class: 'text', id: 'aspSel', onchange: e => { s.aspect = e.target.value; CR.rect = fitAspect(p, CR.rect); drawOverlay(); persist(p); } }, ...ASPECTS.map(([v, t]) => el('option', { value: v, selected: s.aspect === v, text: t })))),
      el('div', { class: 'row' }, el('button', { class: 'btn sm', type: 'button', disabled: s.aspect === 'free' || null, onclick: () => { s.aspectFlip = !s.aspectFlip; CR.rect = fitAspect(p, { x: 0, y: 0, w: 1, h: 1 }); drawOverlay(); persist(p); renderRight(); } }, s.aspectFlip ? 'Make landscape' : 'Make portrait'), el('span', { class: 'note', text: 'Swaps the crop between vertical and horizontal.' })),
      slider(p, 'angle', 'Straighten', -15, 15, { step: 0.1, fmt: v => (+v).toFixed(1) + '°' }),
      el('div', { class: 'row' },
        el('button', { class: 'btn sm', type: 'button', onclick: () => { change(s => { s.rot = (s.rot + 270) % 360; }); CR.rect = fitAspect(p, { x: 0, y: 0, w: 1, h: 1 }); renderRight(); } }, '⟲ Rotate left'),
        el('button', { class: 'btn sm', type: 'button', onclick: () => { change(s => { s.rot = (s.rot + 90) % 360; }); CR.rect = fitAspect(p, { x: 0, y: 0, w: 1, h: 1 }); renderRight(); } }, '⟳ Rotate right'),
        el('button', { class: 'btn sm', type: 'button', onclick: () => { change(s => { s.flipH = !s.flipH; }); } }, 'Flip')),
      el('div', { class: 'row' },
        el('button', { class: 'btn ghost sm', type: 'button', onclick: () => { CR.rect = { x: 0, y: 0, w: 1, h: 1 }; s.angle = 0; s.aspect = 'orig'; drawOverlay(); scheduleRender('final'); renderRight(); } }, 'Reset crop'),
        el('button', { class: 'btn primary sm', type: 'button', onclick: () => setTool('none') }, 'Done')));
  }

  /* ================= LOOKS (left in Develop) ================= */
  function drawSwatch(canvas, look) {
    const w = 116, h = 68; canvas.width = w; canvas.height = h; const x = canvas.getContext('2d'), id = x.createImageData(w, h), t = [0, 0, 0], lut = LC.bakedLUT(look);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      let r, g, b; const u = xx / (w - 1);
      if (yy < h * 0.42) r = g = b = u;
      else if (yy < h * 0.72) { const hh = u * 6, c = 0.55, X = c * (1 - Math.abs(hh % 2 - 1)), m = 0.62 - c / 2; [r, g, b] = [[c, X, 0], [X, c, 0], [0, c, X], [0, X, c], [X, 0, c], [c, 0, X]][Math.min(5, hh | 0)]; r += m; g += m; b += m; }
      else [r, g, b] = [[0.36, 0.22, 0.15], [0.55, 0.38, 0.28], [0.76, 0.58, 0.47], [0.9, 0.75, 0.66]][Math.min(3, (u * 4) | 0)];
      LC.lutAt(lut, r, g, b, t, 0); const p = 4 * (yy * w + xx); id.data[p] = t[0] * 255; id.data[p + 1] = t[1] * 255; id.data[p + 2] = t[2] * 255; id.data[p + 3] = 255;
    }
    x.putImageData(id, 0, 0);
  }
  function looksPanel() {
    const p = activePhoto(), box = el('section', { class: 'sec' });
    const act = p && p.s.look ? lookById(p.s.look) : null;
    if (S.looksOpen === undefined) { try { S.looksOpen = localStorage.getItem('lookmatch.looksOpen') !== '0'; } catch (e) { S.looksOpen = true; } }
    box.append(el('div', { class: 'sec-h' },
      el('button', { class: 'dd', type: 'button', 'aria-expanded': String(!!S.looksOpen), 'aria-controls': 'looksList', onclick: () => { S.looksOpen = !S.looksOpen; try { localStorage.setItem('lookmatch.looksOpen', S.looksOpen ? '1' : '0'); } catch (e) { } renderLeft(); } },
        el('span', { class: 'dd-c', text: S.looksOpen ? '▾' : '▸' }), el("h2", { text: "Your looks" })),
      el('div', { class: 'row' }, el('button', { class: 'btn ghost sm', type: 'button', onclick: () => openTeach() }, '+ New look'), el('button', { class: 'btn ghost sm', type: 'button', onclick: importLookFile }, 'Import'))));
    if (!S.looksOpen) box.append(el('p', { class: 'note', style: 'margin:0 0 6px', text: act ? `On: ${act.name}` : 'No look on' }));
    const list = el('div', { class: 'looks', id: 'looksList', hidden: !S.looksOpen || null });
    const onNow = id => !!(p && p.s.look === id);
    for (const L of S.looks) {
      let cv; if (L.doc && L.doc.cover) cv = el('img', { src: L.doc.cover, alt: '', style: 'width:58px;height:34px;object-fit:cover;border-radius:4px;display:block' }); else { cv = el('canvas'); drawSwatch(cv, L.look); }
      const st = L.look.stats || {};
      const meta = (L.sample ? 'Sample' : L.look.kind === 'ref' ? `${st.refs} edit${st.refs > 1 ? 's' : ''}` : `${st.pairs || 1} pair${(st.pairs || 1) > 1 ? 's' : ''}`) + (L.creative ? ' · creative' : '');
      list.append(el('div', { class: 'look' + (onNow(L.id) ? ' on' : ''), 'data-id': L.id },
        cv, el('div', { style: 'min-width:0' }, el('div', { class: 'nm', text: L.name }), el('div', { class: 'mt', text: meta })),
        el('span', { class: 'row', style: 'gap:6px' },
          el('label', { class: 'sw', title: onNow(L.id) ? 'Turn this look off' : 'Turn this look on' }, el('input', { type: 'checkbox', disabled: !p || null, checked: onNow(L.id) || null, 'aria-label': `${L.name} on or off`, onchange: e => applyLook(e.target.checked ? L.id : null) }), el('span', { class: 'sw-t' })),
          L.sample ? null : el('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Look options', onclick: () => openLookEditor(L) }, '•••'))));
    }
    box.append(list);
    if (p) {
      const multi = S.sel.size > 1 ? [...S.sel].map(photo).filter(Boolean) : null;
      const L = p.s.look ? lookById(p.s.look) : null;
      box.append(el('div', { class: 'row' },
        el('button', { class: 'btn sm', type: 'button', disabled: !multi, onclick: () => applyLook(p.s.look, multi) }, multi ? `Apply to ${multi.length} selected` : 'Apply to selected'),
        el('button', { class: 'btn sm', type: 'button', onclick: () => { const all = visible().filter(q => q.pick !== -1); applyLook(p.s.look, all); } }, `Apply to all shown (${visible().filter(q => q.pick !== -1).length})`)));
      if (L) {
        box.append(slider(p, 'lookAmt', 'Strength', 0, 150, { def: 100, fmt: v => v + '%' }));
        if (!L.sample) box.append(el('button', { class: 'btn ghost sm', type: 'button', onclick: () => setCover(L, p, true) }, 'Use this photo as the look\'s cover'));
        box.append(el('label', { class: 'row', for: 'lookBg', style: 'gap:8px' }, el('input', { type: 'checkbox', id: 'lookBg', checked: p.s.lookBg || null, onchange: e => change(s => { s.lookBg = e.target.checked; }) }), el('span', { text: 'Keep the couple natural (look mostly on the background)' })));
        if (L.look.kind === 'ref') {
          const order = LC.rankRefs(L.look, { rgb: V.last && V.last.small ? V.last.small.rgb : new Float32Array(3) });
          const sel = el('select', { class: 'text', id: 'matchSel', onchange: e => change(s => { s.pick = e.target.value === 'auto' ? 'auto' : +e.target.value; }) },
            el('option', { value: 'auto', text: 'Whole look (blend)' }),
            ...order.map((j, k) => { const r = L.look.refs[j]; return el('option', { value: j, disabled: !r.px, selected: String(p.s.pick) === String(j), text: `Precise: ${r.name || 'Edit ' + (j + 1)}${k === 0 ? ' (closest)' : ''}${r.px ? '' : ' (re-add to use)'}` }); }));
          if (p.s.pick === 'auto') sel.value = 'auto';
          box.append(el('label', { class: 'sl', for: 'matchSel', style: 'grid-template-columns:82px minmax(0,1fr)' }, el('span', { text: 'Match to' }), sel));
        }
      }
    }
    return box;
  }
  /* a look's cover is always one of the photographer's own photos, rendered with the look */
  const coverBusy = new Set();
  async function setCover(L, p, pinned) {
    if (!L.doc || coverBusy.has(L.id) || !V.last || p.id !== S.active) return;
    if (L.doc.coverPinned && !pinned) return;
    coverBusy.add(L.id);
    try {
      const c = scaled(V.last.canvas, V.last.w, V.last.h, 160), url = c.toDataURL('image/jpeg', 0.7); c.width = c.height = 0;
      const doc = Object.assign({}, L.doc, { cover: url, coverPinned: !!pinned || !!L.doc.coverPinned, updated: Date.now() });
      await saveLook(doc); L.doc = doc; renderLeft(); if (pinned) toast(`Cover set for “${L.name}”.`);
    } catch (e) { if (pinned) toast('Could not save the cover.'); }
    finally { coverBusy.delete(L.id); }
  }
  function applyLook(id, list) {
    const targets = list || [activePhoto()]; if (!targets[0]) return;
    change(s => { s.look = id; s.pick = 'auto'; }, { all: targets });
    if (id) autoIfFresh(targets);
    renderLeft(); if (list && list.length > 1) toast(`${id ? lookById(id).name : 'No look'} applied to ${list.length} photos.`);
  }
  async function importLookFile() {
    const inp = el('input', { type: 'file', accept: '.json,application/json' });
    inp.onchange = async () => { const f = inp.files[0]; if (!f) return; try { const d = JSON.parse(await f.text()); LC.deserialize(d); await saveLook(Object.assign({}, d, { id: nid(), name: d.name || f.name.replace(/\..*$/, ''), created: Date.now() })); toast('Look imported.'); } catch (e) { toast(e.message || 'That is not a Look Match look file.'); } };
    inp.click();
  }

  /* ---------------- creative looks ---------------- */
  function creativePanel() {
    const p = activePhoto(), box = el('section', { class: 'sec' }, el('div', { class: 'sec-h' }, el('h2', { text: 'Creative looks' }), el('button', { class: 'btn ghost sm', type: 'button', onclick: () => openTeach({ creative: true }) }, '+ Add')));
    if (!p) return box;
    const coll = S.looks.filter(l => l.creative);
    box.append(el('div', { class: 'sec-h' }, el('h2', { text: `Your collection (${coll.length})`, style: 'font-size:10px' })));
    if (!coll.length) box.append(el('p', { class: 'note', text: 'Teach your magical edits as looks and tick “Creative look”. Auto-pick then chooses the one that fits each photo\'s scene.' }));
    else {
      box.append(el('div', { class: 'chips' }, ...coll.map(L => el('button', { type: 'button', class: 'chip', 'aria-pressed': p.s.look === L.id, text: L.name, onclick: () => autoPick([p], [L]) }))));
      const multi = S.sel.size > 1 ? [...S.sel].map(photo).filter(Boolean) : null, shown = visible().filter(q => q.pick !== -1 && q.eyeBlob);
      box.append(el('div', { class: 'row' },
        el('button', { class: 'btn sm primary', type: 'button', onclick: () => autoPick([p], coll) }, 'Auto-pick for this photo'),
        multi ? el('button', { class: 'btn sm', type: 'button', onclick: () => autoPick(multi, coll) }, `Auto-pick ${multi.length} selected`) : el('button', { class: 'btn sm', type: 'button', onclick: () => autoPick(shown, coll) }, `Auto-pick all shown (${shown.length})`)));
      if (p.s.autoPick && p.s.look && lookById(p.s.look)) box.append(el('p', { class: 'note', text: `Picked “${lookById(p.s.look).name}”: its closest edit is “${p.s.autoPick}”.` }));
    }
    box.append(el('div', { class: 'sec-h', style: 'margin-top:6px' }, el('h2', { text: 'Scene effects', style: 'font-size:10px' })));
    box.append(el('p', { class: 'note', text: 'Keeps the couple natural and restyles the background around them.' }));
    const chips = el('div', { class: 'chips' }, el('button', { type: 'button', class: 'chip', 'aria-pressed': !p.s.creative, text: 'None', onclick: () => { change(s => { s.creative = null; }); renderLeft(); } }),
      ...Object.entries(D.CREATIVE).map(([k, v]) => el('button', { type: 'button', class: 'chip', 'aria-pressed': p.s.creative === k, text: v.name, onclick: () => { change(s => { s.creative = k; }); renderLeft(); autoIfFresh([p]); } })));
    box.append(chips);
    if (p.s.creative) {
      box.append(slider(p, 'creativeAmt', 'Amount', 0, 100, { def: 70, fmt: v => v + '%' }));
      box.append(el('div', { class: 'row' },
        el('button', { class: 'btn sm', type: 'button', 'aria-pressed': S.tool === 'subj+', onclick: () => setTool(S.tool === 'subj+' ? 'none' : 'subj+') }, S.tool === 'subj+' ? '● Adding subject' : 'Add to subject'),
        el('button', { class: 'btn sm', type: 'button', 'aria-pressed': S.tool === 'subj-', onclick: () => setTool(S.tool === 'subj-' ? 'none' : 'subj-') }, S.tool === 'subj-' ? '● Removing' : 'Remove from subject'),
        p.subj ? el('button', { class: 'btn ghost sm', type: 'button', onclick: () => { p.subj = null; persist(p); scheduleRender('final'); renderLeft(); } }, 'Reset subject') : null));
      box.append(el('p', { class: 'note', text: 'The red tint while brushing shows what counts as the subject.' }));
      box.append(el('button', { class: 'btn sm', type: 'button', disabled: !(S.sel.size > 1), onclick: () => { const multi = [...S.sel].map(photo).filter(Boolean); change(s => { s.creative = p.s.creative; s.creativeAmt = p.s.creativeAmt; }, { all: multi }); autoIfFresh(multi); toast(`Creative look applied to ${multi.length} photos.`); } }, S.sel.size > 1 ? `Apply to ${S.sel.size} selected` : 'Apply to selected'));
    }
    return box;
  }

  /* ---------------- Auto-pick: compare each photo's scene to every edit in the creative collection ---------------- */
  const refLabCache = new Map();
  function labSample(rgbU8orF, n, isU8) {
    const cnt = rgbU8orF.length / 3, out = new Float32Array(n * 3), t = [0, 0, 0]; let seed = 11;
    for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const q = seed % cnt, k = isU8 ? 1 / 255 : 1; LC.rgb2lab(rgbU8orF[3 * q] * k, rgbU8orF[3 * q + 1] * k, rgbU8orF[3 * q + 2] * k, t); out[3 * i] = t[0]; out[3 * i + 1] = t[1] * 1.3; out[3 * i + 2] = t[2] * 1.3; }
    return out;
  }
  const DIRS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.7, 0.7, 0], [0.7, 0, 0.7], [0, 0.7, 0.7], [0.58, -0.58, 0.58], [0, 0.7, -0.7]];
  function projSorted(X) { return DIRS.map(d => { const n = X.length / 3, a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = X[3 * i] * d[0] + X[3 * i + 1] * d[1] + X[3 * i + 2] * d[2]; return a.sort(); }); }
  function swd(PA, PB) { let s = 0; for (let k = 0; k < PA.length; k++) { const a = PA[k], b = PB[k]; let d = 0; for (let q = 1; q < 40; q++) d += Math.abs(a[Math.floor(q / 40 * a.length)] - b[Math.floor(q / 40 * b.length)]); s += d / 39; } return s / PA.length; }
  function refProj(L, j) { const key = L.id + ':' + (L.rev || 0) + ':' + j; if (!refLabCache.has(key)) refLabCache.set(key, projSorted(labSample(LC.fromB64(L.look.refs[j].px), 1500, true))); return refLabCache.get(key); }
  async function photoProj(p) { const b = await smallSource(p), c = scaled(b, b.width, b.height, 256), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, rgb = new Uint8Array(c.width * c.height * 3); for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2]; } c.width = c.height = 0; return projSorted(labSample(rgb, 2500, true)); }
  async function autoPick(list, looks) {
    looks = looks.filter(L => L.look.kind === 'ref' && L.look.refs.some(r => r.px));
    if (!looks.length) { toast('These looks were taught before precise matching existed. Open the look, re-add its edits, and save.'); return; }
    const big = list.length > 3; if (big) { S.busy = { text: 'Auto-picking', frac: 0 }; progress(); }
    let n = 0; const tally = {};
    for (const p of list) {
      if (!p.eyeBlob) continue; const P0 = await photoProj(p); let best = null;
      for (const L of looks) L.look.refs.forEach((r, j) => { if (!r.px) return; const d = swd(P0, refProj(L, j)); if (!best || d < best.d) best = { d, L, j }; });
      if (best) { pushUndo(p); p.s.look = best.L.id; p.s.pick = best.j; p.s.lookBg = true; p.s.autoPick = best.L.look.refs[best.j].name || `edit ${best.j + 1}`; persist(p); if (p.id !== S.active) queueThumb(p); updateCell(p); tally[best.L.name] = (tally[best.L.name] || 0) + 1; }
      n++; if (big) { S.busy.frac = n / list.length; S.busy.text = `Auto-picking ${n} of ${list.length}`; progress(); await tick(); }
    }
    if (big) { S.busy = null; progress(); }
    scheduleRender('final'); renderLeft(); autoIfFresh(list);
    toast(list.length === 1 ? `Picked “${Object.keys(tally)[0]}” for this scene.` : 'Auto-picked: ' + Object.entries(tally).map(([k, v]) => `${k} ×${v}`).join(', '), 5000);
  }

  /* ---------------- teach / edit looks (modal) ---------------- */
  function modal(build) { const m = $('modal'), d = $('dialog'); d.innerHTML = ''; build(d); m.hidden = false; const close = () => { m.hidden = true; d.innerHTML = ''; }; m.onclick = e => { if (e.target === m) close(); }; return close; }
  function dropzone(label, sub, multiple, onFiles) {
    const inp = el('input', { type: 'file', accept: 'image/*,.cr2,.cr3,.nef,.arw,.dng,.raf,.orf,.rw2,.pef,.srw', multiple: multiple || null, 'aria-label': label, onchange: e => { onFiles(e.target.files); e.target.value = ''; } });
    const z = el('label', { class: 'dropzone' }, el('b', { text: label }), sub, inp);
    z.ondragover = e => { e.preventDefault(); z.classList.add('drag'); }; z.ondragleave = () => z.classList.remove('drag');
    z.ondrop = e => { e.preventDefault(); e.stopPropagation(); z.classList.remove('drag'); onFiles(e.dataTransfer.files); };
    return z;
  }
  function makeThumb(src) { const c = scaled(src, src.width, src.height, 120); return c.toDataURL('image/jpeg', 0.6); }
  async function measureEdit(file, notMine) {
    const bmp = await decode(file); const sm = D.smallFrom(scaled(bmp, bmp.width, bmp.height, 1280).getContext('2d').getImageData(0, 0, Math.round(bmp.width * Math.min(1, 1280 / Math.max(bmp.width, bmp.height))), Math.round(bmp.height * Math.min(1, 1280 / Math.max(bmp.width, bmp.height)))).data, Math.round(bmp.width * Math.min(1, 1280 / Math.max(bmp.width, bmp.height))), Math.round(bmp.height * Math.min(1, 1280 / Math.max(bmp.width, bmp.height))), 1280);
    const cw = Math.min(700, Math.round(bmp.width * 0.3)), ch = Math.min(700, Math.round(bmp.height * 0.3));
    const cc = el('canvas'); cc.width = cw; cc.height = ch; const cx = cc.getContext('2d', { willReadFrequently: true }); cx.drawImage(bmp, Math.round(bmp.width * 0.35), Math.round(bmp.height * 0.35), cw, ch, 0, 0, cw, ch);
    const d = cx.getImageData(0, 0, cw, ch).data, L = new Float32Array(cw * ch); for (let i = 0; i < L.length; i++) L[i] = (0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]) / 255;
    const st = LC.refStats({ w: sm.w, h: sm.h, rgb: sm.rgb, crop: { w: cw, h: ch, L }, thumb: notMine ? null : makeThumb(bmp), name: notMine ? 'Reference' : file.name }); bmp.close && bmp.close();
    if (notMine) { delete st.thumb; st.notMine = true; }
    // a private copy for the AI editor to compare against (never shown as a thumbnail)
    if (S.assets) { try { const b2 = await decode(file), c = scaled(b2, b2.width, b2.height, 1024), up = await S.assets.upload(await toBlob(c, 0.85)); c.width = c.height = 0; b2.close && b2.close(); if (up && up.url) st.img = up.url; } catch (e) { } }
    return st;
  }
  function openTeach() {
    const T = { mode: 'ref', refs: [], pairs: [{ b: null, a: null }], name: '', busy: false, msg: null, creative: !!(arguments[0] && arguments[0].creative), notMine: false };
    const close = modal(draw);
    function draw(d) {
      d.innerHTML = '';
      d.append(el('h3', { text: 'New look' }),
        el('div', { class: 'seg', role: 'group', 'aria-label': 'Teach from' },
          el('button', { type: 'button', 'aria-pressed': T.mode === 'ref', text: 'From finished edits', onclick: () => { T.mode = 'ref'; draw(d); } }),
          el('button', { type: 'button', 'aria-pressed': T.mode === 'pair', text: 'From before & after', onclick: () => { T.mode = 'pair'; draw(d); } })));
      if (T.mode === 'ref') {
        d.append(el('p', { text: 'Add 5–10 finished photos in one style. New photos are matched to the most similar of them, and you can lock a photo to one of them with Match to.' }),
          dropzone('Add finished edits', 'Drop photos or choose', true, files => { for (const f of files) if (T.refs.length < 20) T.refs.push({ file: f, url: URL.createObjectURL(f) }); draw(d); }));
        if (T.refs.length) d.append(el('div', { class: 'refs' }, ...T.refs.map((r, i) => el('div', { class: 'rt' }, el('img', { src: r.url, alt: r.file.name }), el('button', { type: 'button', 'aria-label': 'Remove', text: '✕', onclick: () => { T.refs.splice(i, 1); draw(d); } })))));
        d.append(el('label', { class: 'row', for: 'teachNotMine', style: 'gap:8px' }, el('input', { type: 'checkbox', id: 'teachNotMine', checked: T.notMine || null, onchange: e => T.notMine = e.target.checked }), el('span', null, 'These examples are not my work', el('small', { class: 'note', style: 'display:block', text: 'Keeps only their color measurements. No thumbnail or file name is saved; the look shows one of your own photos as its cover once you use it.' }))));
      } else {
        d.append(el('p', { text: 'Add the original and your finished edit of the same photo, uncropped. This copies an edit most exactly, including dodge & burn.' }));
        T.pairs.forEach((pr, i) => d.append(el('div', { class: 'pairrow' },
          ...['b', 'a'].map(k => { const z = dropzone(k === 'b' ? 'Original' : 'Your edit', '', false, files => { pr[k] = { file: files[0], url: URL.createObjectURL(files[0]) }; draw(d); }); if (pr[k]) z.prepend(el('img', { src: pr[k].url, alt: '' })); return z; }),
          el('button', { class: 'btn ghost sm', type: 'button', text: '✕', 'aria-label': 'Remove pair', onclick: () => { T.pairs.splice(i, 1); if (!T.pairs.length) T.pairs.push({ b: null, a: null }); draw(d); } }))));
        d.append(el('div', { class: 'row' }, el('button', { class: 'btn sm', type: 'button', onclick: () => { T.pairs.push({ b: null, a: null }); draw(d); } }, '+ Another pair')));
      }
      const nameIn = el('input', { class: 'text', id: 'teachName', value: T.name, placeholder: 'e.g. Bright & Airy', maxlength: 60, oninput: e => T.name = e.target.value });
      d.append(el('label', { for: 'teachName', class: 'note', text: 'Look name' }), nameIn,
        el('label', { class: 'row', for: 'teachCreative', style: 'gap:8px' }, el('input', { type: 'checkbox', id: 'teachCreative', checked: T.creative || null, onchange: e => T.creative = e.target.checked }), el('span', null, 'Creative look', el('small', { class: 'note', style: 'display:block', text: 'Adds it to your Creative collection, so Auto-pick can choose it for photos with a matching scene.' }))));
      if (T.msg) d.append(el('div', { class: 'msg ' + T.msg[0], text: T.msg[1] }));
      const ready = T.mode === 'ref' ? T.refs.length : T.pairs.filter(x => x.a && x.b).length;
      d.append(el('div', { class: 'row', style: 'justify-content:flex-end' }, el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'button', disabled: !ready || T.busy, onclick: () => learn(d) }, T.busy ? 'Learning…' : 'Learn look')));
    }
    async function learn(d) {
      T.busy = true; T.msg = null; draw(d);
      try {
        let look;
        if (T.mode === 'ref') { const per = []; for (const r of T.refs) per.push(await measureEdit(r.file, T.notMine)); look = LC.combineRef(per, null); }
        else {
          const pairs = [];
          for (const pr of T.pairs.filter(x => x.a && x.b)) {
            const [bb, ab] = await Promise.all([decode(pr.b.file), decode(pr.a.file)]);
            if (Math.abs(bb.width / bb.height - ab.width / ab.height) / (ab.width / ab.height) > 0.02) throw new Error('A pair has different shapes. Use the uncropped edit of the same photo.');
            const ac = scaled(ab, ab.width, ab.height, 1280), A = D.smallFrom(ac.getContext('2d').getImageData(0, 0, ac.width, ac.height).data, ac.width, ac.height, 1280);
            const bc = el('canvas'); bc.width = ac.width; bc.height = ac.height; bc.getContext('2d').drawImage(bb, 0, 0, ac.width, ac.height); const B = D.smallFrom(bc.getContext('2d').getImageData(0, 0, ac.width, ac.height).data, ac.width, ac.height, 1280);
            pairs.push({ B, A }); bb.close && bb.close(); ab.close && ab.close();
          }
          look = LC.learn(pairs);
        }
        const name = T.name.trim() || `Look ${new Date().toLocaleDateString()}`, id = nid();
        await saveLook(Object.assign(LC.serialize(look, { name, created: Date.now(), creative: !!T.creative }), { id }));
        if (S.db) S.looks = [{ id, name, created: Date.now(), creative: !!T.creative, look, rev: 1 }].concat(S.looks.filter(l => l.id !== id));
        close(); renderLeft(); toast(`Saved “${name}”. Click it to apply.`);
      } catch (e) { T.busy = false; T.msg = ['err', e.message || String(e)]; draw(d); }
    }
  }
  function openLookEditor(L) {
    const E = { name: L.name, refs: L.look.kind === 'ref' ? L.look.refs.map(r => Object.assign({}, r)) : null, confirmDel: false, busy: false, creative: !!L.creative, addNotMine: false, cover: L.doc && L.doc.cover || null };
    const close = modal(draw);
    function draw(d) {
      d.innerHTML = '';
      d.append(el('h3', { text: 'Edit look' }), el('label', { for: 'lkName', class: 'note', text: 'Name' }), el('input', { class: 'text', id: 'lkName', value: E.name, maxlength: 60, oninput: e => E.name = e.target.value }),
        el('label', { class: 'row', for: 'lkCreative', style: 'gap:8px' }, el('input', { type: 'checkbox', id: 'lkCreative', checked: E.creative || null, onchange: e => E.creative = e.target.checked }), el('span', { text: 'Creative look (part of your Creative collection)' })));
      if (E.refs) {
        d.append(el('div', { class: 'sec-h' }, el('h2', { text: `Edits in this look (${E.refs.length})` })),
          el('div', { class: 'refs' }, ...E.refs.map((r, i) => el('div', { class: 'rt', title: r.notMine ? 'Not your work: no thumbnail kept' : (r.name || '') },
            r.thumb ? el('img', { src: r.thumb, alt: r.name || '' }) : el('span', { text: r.notMine ? 'Not mine' : `Edit ${i + 1}` }),
            el('button', { type: 'button', text: '✕', 'aria-label': 'Remove', disabled: E.refs.length < 2 || null, onclick: () => { E.refs.splice(i, 1); draw(d); } }),
            !r.notMine ? el('button', { type: 'button', style: 'left:2px;right:auto;width:auto;padding:0 5px;border-radius:9px;font-size:9px', 'aria-label': 'Mark as not my work', title: 'Mark as not my work (deletes its thumbnail)', text: 'Not mine?', onclick: () => { r.notMine = true; delete r.thumb; r.name = 'Reference'; draw(d); } }) : null))),
          el('label', { class: 'row', for: 'addNotMine', style: 'gap:8px' }, el('input', { type: 'checkbox', id: 'addNotMine', checked: E.addNotMine || null, onchange: e => E.addNotMine = e.target.checked }), el('span', { text: 'Edits I add next are not my work' })),
          dropzone('Add more edits', 'Same style only', true, async files => { E.busy = true; draw(d); for (const f of files) { try { if (E.refs.length < 20) E.refs.push(await measureEdit(f, E.addNotMine)); } catch (e) { toast(e.message); } } E.busy = false; draw(d); }));
      } else d.append(el('p', { text: 'Built from before & after pairs. To change its photos, teach it again.' }));
      if (E.cover) d.append(el('div', { class: 'row' }, el('img', { src: E.cover, alt: 'Look cover', style: 'height:48px;border-radius:4px' }), el('span', { class: 'note', text: 'Cover: one of your photos edited with this look.' }), el('button', { class: 'btn ghost sm', type: 'button', onclick: () => { E.cover = null; draw(d); } }, 'Remove cover')));
      d.append(el('div', { class: 'row' },
        el('button', { class: 'btn sm', type: 'button', onclick: async () => { try { const zip = new JSZip(); zip.file(slug(L.name) + '.cube', LC.toCube(L.look, L.name)); await offerFile(slug(L.name) + '-LUT.zip', await zip.generateAsync({ type: 'blob' })); } catch (e) { toast(e.message); } } }, 'Export .cube LUT'),
        el('button', { class: 'btn sm', type: 'button', onclick: () => offerFile(slug(L.name) + '.lookmatch.json', JSON.stringify(LC.serialize(L.look, { name: L.name, created: L.created }))).catch(e => toast(e.message)) }, 'Save look file'),
        E.confirmDel ? el('span', { class: 'row' }, el('span', { class: 'note', text: 'Delete for good?' }), el('button', { class: 'btn sm danger', type: 'button', onclick: async () => { await deleteLook(L.id); for (const p of S.photos) if (p.s.look === L.id) { p.s.look = null; persist(p); } close(); render(); } }, 'Delete'), el('button', { class: 'btn ghost sm', type: 'button', onclick: () => { E.confirmDel = false; draw(d); } }, 'Keep'))
          : el('button', { class: 'btn ghost sm danger', type: 'button', onclick: () => { E.confirmDel = true; draw(d); } }, 'Delete look')));
      d.append(el('div', { class: 'row', style: 'justify-content:flex-end' }, el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'button', disabled: E.busy, onclick: async () => {
          const look = E.refs ? LC.combineRef(E.refs, L.look) : L.look;
          const doc = Object.assign(LC.serialize(look, { name: E.name.trim() || L.name, created: L.created, updated: Date.now(), creative: !!E.creative, cover: E.cover || null, coverPinned: !!(L.doc && L.doc.coverPinned) }), { id: L.id });
          try { await saveLook(doc); close(); toast('Look saved.'); } catch (e) { toast(e.message); }
        } }, E.busy ? 'Reading…' : 'Save changes')));
    }
  }

  /* ================= EYES CHECK (Claude) ================= */
  function openEyes() {
    const ready = S.photos.filter(p => p.eyeBlob && p.pick !== -1);
    const best = ready.filter(p => !p.flags.dup);
    const sel = S.sel.size > 1 ? ready.filter(p => S.sel.has(p.id)) : [];
    const picks = ready.filter(p => p.pick === 1);
    let choice = 'best', tier = 'default';
    const close = modal(d => {
      const opts = [['best', `Best of each burst and single frames (${best.length})`, 'Recommended: skips near-identical frames.'], ['picks', `Picks (${picks.length})`, ''], ['sel', `Selected (${sel.length})`, ''], ['all', `Everything not rejected (${ready.length})`, '']];
      d.append(el('h3', { text: 'Check eyes with Claude' }),
        el('p', { text: 'Claude looks at a small preview of each photo and flags closed eyes and blinks. Eyes closed on purpose (prayer, a kiss, laughing) are noted but not flagged. This uses your Claude usage.' }),
        el('div', { class: 'radio' }, ...opts.map(([v, t, sub]) => el('label', null, el('input', { type: 'radio', name: 'eyesScope', value: v, checked: v === choice, disabled: (v === 'sel' && !sel.length) || (v === 'picks' && !picks.length) || null, onchange: () => choice = v }), el('span', null, t, sub ? el('small', { text: sub }) : null)))),
        el('div', { class: 'radio' }, ...[['default', 'Careful', 'Best for group shots and small faces. About 10–20 seconds per batch of photos.'], ['quick', 'Fast', 'Good for portraits and close-ups.']].map(([v, t, sub]) => el('label', null, el('input', { type: 'radio', name: 'eyesTier', value: v, checked: v === tier, onchange: () => tier = v }), el('span', null, t, el('small', { text: sub }))))),
        S.sample ? null : el('div', { class: 'msg warn', text: 'Asking Claude is not available in this view. Open this app in Claude to use the eyes check.' }),
        el('div', { class: 'row', style: 'justify-content:flex-end' }, el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
          el('button', { class: 'btn primary', type: 'button', disabled: !S.sample || null, onclick: () => { close(); runEyes(choice === 'best' ? best : choice === 'picks' ? picks : choice === 'sel' ? sel : ready, tier); } }, 'Start check')));
    });
  }
  async function runEyes(list, tier) {
    if (!list.length) return;
    let lim = null; try { lim = await S.sample.limits(); } catch (e) { }
    if (!lim || !lim.images) { toast('Claude can\'t receive images in this view.'); return; }
    const per = Math.max(1, Math.min(6, lim.images.maxCount || 4));
    const batches = []; for (let i = 0; i < list.length; i += per) batches.push(list.slice(i, i + per));
    S.busy = { text: 'Checking eyes', frac: 0, stop: false }; progress();
    let done = 0, flagged = 0, failed = 0; const ctl = new AbortController();
    const one = async b => {
      const prompt = `You are helping a professional wedding and event photographer cull photos. You get ${b.length} photo${b.length > 1 ? 's' : ''}, in order, numbered 1 to ${b.length}.
For each photo report:
- people: number of clearly visible faces (ignore tiny faces far in the background)
- closed: faces whose eyes are closed or mid-blink in a way that looks accidental
- intentional: faces with eyes closed on purpose (praying, kissing, emotional moment, laughing hard, looking down at hands)
- keeper: 1-5, how strong this frame is for a client gallery (expression, moment)
- note: at most 10 words, only if something is wrong (blink, awkward expression, someone cut off, motion blur); else ""
Reply with JSON only: {"results":[{"i":1,"people":0,"closed":0,"intentional":0,"keeper":3,"note":""}]}`;
      try {
        const out = await S.sample.json(prompt, { images: b.map(p => p.eyeBlob), modelTier: tier, signal: ctl.signal });
        for (const r of (out && out.results) || []) { const p = b[(r.i | 0) - 1]; if (!p) continue; p.eyes = { people: r.people | 0, closed: r.closed | 0, intentional: r.intentional | 0, keeper: Math.max(1, Math.min(5, r.keeper | 0 || 3)), note: String(r.note || '').slice(0, 80) }; if (p.eyes.closed) flagged++; persist(p); updateCell(p); }
      } catch (e) {
        if (e && (e.code === 'not_granted' || e.code === 'images_unavailable' || e.code === 'sampling_disabled')) { S.busy.stop = true; toast('Claude was not allowed to check these photos.'); }
        else if (e && e.code === 'rate_limited') { await new Promise(r => setTimeout(r, 8000)); failed += b.length; }
        else if (e && e.code !== 'cancelled') failed += b.length;
      }
      done += b.length; S.busy.frac = done / list.length; S.busy.text = `Checking eyes: ${done} of ${list.length}`; progress();
    };
    let i = 0;
    const worker = async () => { while (i < batches.length && !S.busy.stop) { const b = batches[i++]; await one(b); } };
    const stopWatch = setInterval(() => { if (S.busy && S.busy.stop) ctl.abort(); }, 300);
    await Promise.all([worker(), worker()]);
    clearInterval(stopWatch); S.busy = null; progress();
    D.cull(S.photos); renderAll();
    toast(`Eyes check done: ${flagged} photo${flagged === 1 ? '' : 's'} with closed eyes${failed ? `, ${failed} could not be checked` : ''}. See the Eyes closed folder.`, 6000);
  }

  /* ================= EXPORT ================= */
  const EX = { scope: 'picks', size: 'full', custom: 3000, quality: 92, naming: 'orig', base: '', part: 40 };
  function exportSets() {
    const ok = S.photos.filter(p => p.state === 'ready');
    return { picks: ok.filter(p => p.pick === 1), keep: ok.filter(p => p.pick !== -1), sel: ok.filter(p => S.sel.has(p.id)), shown: visible().filter(p => p.state === 'ready') };
  }
  function exportView() {
    const sets = exportSets();
    const box = el('div', { style: 'flex:1;overflow-y:auto;padding:24px;display:flex;justify-content:center' });
    const f = el('div', { style: 'width:min(560px,100%);display:flex;flex-direction:column;gap:16px' });
    const radio = (name, opts, cur, on) => el('div', { class: 'radio' }, ...opts.map(([v, t, sub, dis]) => el('label', null, el('input', { type: 'radio', name, value: v, checked: cur === v, disabled: dis || null, onchange: () => { on(v); renderCenter(); } }), el('span', null, t, sub ? el('small', { text: sub }) : null))));
    f.append(el('h3', { text: 'Export', style: 'margin:0;font-size:20px;font-weight:800' }),
      el('div', { class: 'sec-h' }, el('h2', { text: 'Which photos' })),
      radio('exScope', [['picks', `Picks (${sets.picks.length})`, 'Flagged with P in the Library', !sets.picks.length], ['keep', `Everything not rejected (${sets.keep.length})`], ['sel', `Selected (${sets.sel.length})`, '', !sets.sel.length], ['shown', `Current folder (${sets.shown.length})`]], EX.scope, v => EX.scope = v),
      el('div', { class: 'sec-h' }, el('h2', { text: 'Size' })),
      radio('exSize', [['full', 'Full resolution', 'For prints and client delivery'], ['4096', 'Long edge 4096 px', 'High-quality online gallery'], ['2048', 'Long edge 2048 px', 'Web and social'], ['custom', 'Custom long edge']], EX.size, v => EX.size = v),
      EX.size === 'custom' ? el('input', { class: 'text', type: 'number', min: 300, max: 20000, value: EX.custom, 'aria-label': 'Long edge in pixels', onchange: e => EX.custom = +e.target.value }) : null,
      el('div', { class: 'sl', style: 'grid-template-columns:96px minmax(0,1fr) 40px' }, el('label', { for: 'exQ', text: 'JPEG quality' }), el('input', { type: 'range', id: 'exQ', min: 70, max: 100, value: EX.quality, oninput: e => { EX.quality = +e.target.value; e.target.nextSibling.textContent = EX.quality; } }), el('output', { text: EX.quality })),
      el('div', { class: 'sec-h' }, el('h2', { text: 'File names' })),
      radio('exName', [['orig', 'Original file name', 'IMG_1234.jpg'], ['custom', 'Client name + number', `${EX.base || 'Smith-Wedding'}-001.jpg`]], EX.naming, v => EX.naming = v),
      EX.naming === 'custom' ? el('input', { class: 'text', value: EX.base, placeholder: 'Smith-Wedding', 'aria-label': 'Name prefix', oninput: e => EX.base = e.target.value }) : null,
      el('div', { class: 'sec-h' }, el('h2', { text: 'Package' })),
      el('label', { class: 'sl', for: 'exPart', style: 'grid-template-columns:auto 90px minmax(0,1fr)' }, el('span', { text: 'Photos per .zip' }), el('input', { class: 'text', type: 'number', id: 'exPart', min: 1, max: 500, value: EX.part, onchange: e => EX.part = Math.max(1, +e.target.value || 40) }), el('span', { class: 'note', text: 'Large shoots download as several .zip parts so the browser does not run out of memory.' })),
      el('div', { id: 'exMsg' }),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'button', id: 'exGo', onclick: runExport }, `Export ${(sets[EX.scope] || []).length} photo${(sets[EX.scope] || []).length === 1 ? '' : 's'}`)),
      el('p', { class: 'note', text: 'Exports are sRGB JPEGs with every edit applied (look, sliders, crop, brushes, creative look). Camera metadata is not copied.' }));
    box.append(f); return box;
  }
  function exportHelp() { return el('section', { class: 'sec' }, el('div', { class: 'sec-h' }, el('h2', { text: 'Before you export' })), el('p', { class: 'note', text: 'Check the Picks folder in the Library. Unedited photos export as they are. Keep this tab open while exporting; each .zip part asks you to save it.' })); }
  async function runExport() {
    const list = (exportSets()[EX.scope] || []).slice().sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || a.order - b.order);
    if (!list.length) return; const msg = $('exMsg'); msg.innerHTML = '';
    const long = EX.size === 'full' ? null : EX.size === 'custom' ? EX.custom : +EX.size;
    S.busy = { text: 'Exporting', frac: 0, stop: false }; progress(); $('exGo').disabled = true;
    const parts = Math.ceil(list.length / EX.part); let made = 0, errs = [];
    try {
      for (let pi = 0; pi < parts && !S.busy.stop; pi++) {
        const zip = parts > 1 || list.length > 1 ? new JSZip() : null; let single = null;
        for (const p of list.slice(pi * EX.part, (pi + 1) * EX.part)) {
          if (S.busy.stop) break;
          try {
            const bmp = await decode(p.file); const L = p.s.look ? lookById(p.s.look) : null;
            const r = await P.process({ src: bmp, SW: bmp.width, SH: bmp.height, s: p.s, look: L ? L.look : null, lookKey: L ? L.id + ':' + (L.rev || 0) : '', id: p.id + 'F', maxLong: long, full: true, fullW: Math.max(bmp.width, bmp.height), brush: p.brush, subj: p.subj, rm: p.rm, onProgress: f => { S.busy.frac = (made + f) / list.length; S.busy.text = `Exporting ${made + 1} of ${list.length}`; progress(); } });
            bmp.close && bmp.close();
            const blob = await toBlob(r.canvas, EX.quality / 100); r.canvas.width = r.canvas.height = 0;
            if (!blob) throw new Error('too large for this browser');
            const nm = EX.naming === 'custom' ? `${slug(EX.base || 'Photo')}-${String(made + 1).padStart(3, '0')}.jpg` : p.name.replace(/\.[^.]+$/, '') + '.jpg';
            if (zip) zip.file(uniqueName(zip, nm), blob); else single = [nm, blob];
          } catch (e) { errs.push(`${p.name}: ${e.message || e}`); }
          made++; S.busy.frac = made / list.length; progress(); P.clear(); await tick();
        }
        if (zip && Object.keys(zip.files).length) { S.busy.text = `Packing part ${pi + 1} of ${parts}`; progress(); const out = await zip.generateAsync({ type: 'blob', compression: 'STORE' }); await offerFile(`${slug(EX.base || 'Photos')}${parts > 1 ? `-part${pi + 1}of${parts}` : ''}.zip`, out); }
        if (single) await offerFile(single[0], single[1]);
      }
      msg.append(el('div', { class: errs.length ? 'msg warn' : 'msg ok', text: errs.length ? `Exported ${made - errs.length} of ${list.length}. ${errs.join(' · ')}` : `Exported ${made} photo${made === 1 ? '' : 's'}.` }));
    } catch (e) { msg.append(el('div', { class: 'msg err', text: e.message || String(e) })); }
    finally { S.busy = null; progress(); const b = $('exGo'); if (b) b.disabled = false; }
  }
  function uniqueName(zip, nm) { if (!zip.files[nm]) return nm; let k = 2; const base = nm.replace(/\.jpg$/, ''); while (zip.files[`${base}-${k}.jpg`]) k++; return `${base}-${k}.jpg`; }

  /* ================= FILMSTRIP ================= */
  function renderStrip() {
    const st = $('strip'); st.hidden = !(S.mod === 'develop' || (S.mod === 'library' && loupe)) || !S.photos.length; st.innerHTML = '';
    if (st.hidden) return;
    for (const p of visible()) st.append(cellFor(p));
    requestAnimationFrame(() => { const a = st.querySelector('.cell.active'); if (a) a.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
  }

  /* ================= KEYBOARD ================= */
  document.addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('input[type=text],input:not([type]),input[type=number],select,textarea') ) return;
    if (!$('modal').hidden) { if (e.key === 'Escape') { $('modal').hidden = true; } return; }
    const p = activePhoto(), mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === 'c' && S.mod === 'develop') { e.preventDefault(); copySettings(); return; }
    if (mod && k === 'v' && S.mod === 'develop') { e.preventDefault(); pasteSettings(S.sel.size > 1 ? [...S.sel].map(photo).filter(Boolean) : null); return; }
    if (mod && k === 'a') { e.preventDefault(); S.sel = new Set(visible().map(q => q.id)); render(); return; }
    if (mod) return;
    if (k === 'g') { loupe = false; setMod('library'); return; }
    if (k === 'd') { setMod('develop'); return; }
    if (k === 'e' && !e.shiftKey) { setMod('export'); return; }
    if (k === '\\') { S.compare = S.compare === 'before' ? 'split' : 'before'; applyCompare(); return; }
    if (k === 'r' && S.mod === 'develop') { setTool(S.tool === 'crop' ? 'none' : 'crop'); return; }
    if (k === 'escape') { if (S.tool !== 'none') setTool('none'); else if (loupe) { loupe = false; render(); } return; }
    if (!p) return;
    if (k === 'arrowright' || k === 'arrowleft') {
      const v = visible(), i = v.findIndex(q => q.id === p.id), n = v[Math.max(0, Math.min(v.length - 1, i + (k === 'arrowright' ? 1 : -1)))];
      if (n && n.id !== p.id) { e.preventDefault(); if (S.tool === 'crop') commitCrop(); S.tool = 'none'; S.active = n.id; S.sel = new Set([n.id]); S.anchor = n.id; if (S.mod === 'library' && !loupe) { document.querySelectorAll('.cell').forEach(c => { c.classList.toggle('active', c.dataset.id === n.id); c.classList.toggle('sel', c.dataset.id === n.id); }); const c = document.querySelector(`.grid .cell[data-id="${n.id}"]`); if (c) c.scrollIntoView({ block: 'nearest' }); renderRight(); } else render(); }
      return;
    }
    if (k === ' ' && S.mod === 'library') { e.preventDefault(); loupe = !loupe; render(); return; }
    if (S.mod === 'library' || S.mod === 'develop') {
      const targets = S.sel.size > 1 ? [...S.sel].map(photo).filter(Boolean) : [p];
      let hit = false;
      if (k === 'p') { targets.forEach(t => t.pick = 1); hit = true; } else if (k === 'x') { targets.forEach(t => t.pick = -1); hit = true; } else if (k === 'u') { targets.forEach(t => t.pick = 0); hit = true; }
      else if (/^[0-5]$/.test(k)) { targets.forEach(t => t.rating = +k); hit = true; }
      if (hit) { targets.forEach(t => { persist(t); updateCell(t); }); renderLeft(); if (S.mod === 'library') renderRight();
        // auto-advance after flagging a single photo, like Lightroom's caps-lock mode
        if (targets.length === 1 && S.mod === 'library' && (k === 'p' || k === 'x')) { const v = visible(), i = v.findIndex(q => q.id === p.id), n = v[i + 1] || v[i]; if (n && n.id !== p.id) { S.active = n.id; S.sel = new Set([n.id]); S.anchor = n.id; if (loupe) render(); else { document.querySelectorAll('.cell').forEach(c => { c.classList.toggle('active', c.dataset.id === n.id); c.classList.toggle('sel', c.dataset.id === n.id); }); renderRight(); } } }
      }
    }
  });
  window.addEventListener('beforeunload', e => { if (S.photos.length && (Q.running || S.busy)) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------------- boot ---------------- */
  render(); initCaps();
  window.__studio = { S, AG, decode, importFiles, render, setMod, runExport, EX, change, applyLook, photo, setTool, CR, commitCrop, runEyes, agentEdit };
})();
