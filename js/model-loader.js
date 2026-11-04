(function () {
  const CFG = window.BG_CONFIG;
  const MEAN = [0.485, 0.456, 0.406];
  const STD = [0.229, 0.224, 0.225];
  let segPromise = null;

  // Downloads the model once and keeps it in the browser's Cache Storage.
  // Streams straight into the cache so the phone never holds two full copies in memory.
  async function fetchModel(onProgress) {
    let cache = null;
    try { cache = await caches.open('bg-studio-models-v1'); } catch (e) { cache = null; }
    if (cache) {
      const hit = await cache.match(CFG.MODEL_URL);
      if (hit) { onProgress && onProgress(1); return hit.arrayBuffer(); }
    }

    const res = await fetch(CFG.MODEL_URL);
    if (!res.ok) throw new Error('دانلود مدل ناموفق بود (کد ' + res.status + ').');
    const total = Number(res.headers.get('content-length')) || CFG.MODEL_SIZE_HINT;
    let got = 0;
    const counter = new TransformStream({
      transform(chunk, controller) {
        got += chunk.byteLength;
        onProgress && onProgress(Math.min(got / total, 0.99));
        controller.enqueue(chunk);
      },
    });
    const body = res.body.pipeThrough(counter);

    if (cache) {
      await cache.put(CFG.MODEL_URL, new Response(body, { headers: { 'Content-Type': 'application/octet-stream' } }));
      const stored = await cache.match(CFG.MODEL_URL);
      onProgress && onProgress(1);
      return stored.arrayBuffer();
    }

    // No Cache Storage available: read into memory (uses more RAM)
    const reader = body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    const buf = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    onProgress && onProgress(1);
    return buf.buffer;
  }

  // Returns a shared segmenter (one model in memory, reused for every image and frame).
  function getSegmenter(onProgress) {
    if (segPromise) return segPromise;
    segPromise = (async () => {
      const modelBuffer = await fetchModel(onProgress);
      const worker = new Worker('js/worker.js');
      const pending = new Map();
      let nextId = 1;
      let provider = 'wasm';
      worker.onmessage = (e) => {
        const m = e.data;
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.type === 'result') p.resolve(new Float32Array(m.mask));
        else p.reject(new Error(m.message));
      };
      await new Promise((resolve, reject) => {
        const onInit = (e) => {
          const m = e.data;
          if (m.type === 'ready') { worker.removeEventListener('message', onInit); provider = m.provider; resolve(); }
          else if (m.type === 'error') { worker.removeEventListener('message', onInit); reject(new Error(m.message)); }
        };
        worker.addEventListener('message', onInit);
        worker.addEventListener('error', (e) => { reject(new Error('Worker: ' + (e.message || 'load failed'))); });
        worker.postMessage({ type: 'init', ortSources: CFG.ORT_SOURCES, webgpu: !!navigator.gpu, modelBuffer }, [modelBuffer]);
      });
      return {
        provider,
        segment(input) {
          return new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            worker.postMessage({ type: 'infer', id, data: input }, [input.buffer]);
          });
        },
        dispose() { worker.terminate(); segPromise = null; },
      };
    })().catch((err) => { segPromise = null; throw err; });
    return segPromise;
  }

  // Source image -> normalized NCHW float tensor at model resolution.
  function toInput(source) {
    const S = CFG.INPUT_SIZE, n = S * S;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, S, S);
    const px = ctx.getImageData(0, 0, S, S).data;
    const out = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      for (let ch = 0; ch < 3; ch++) out[ch * n + i] = (px[i * 4 + ch] / 255 - MEAN[ch]) / STD[ch];
    }
    return out;
  }

  // Model mask (1024x1024) -> canvas at target size, used as alpha.
  function maskToCanvas(mask, w, h) {
    const S = CFG.INPUT_SIZE;
    const small = document.createElement('canvas');
    small.width = small.height = S;
    const sctx = small.getContext('2d');
    const img = sctx.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const v = Math.max(0, Math.min(1, mask[i])) * 255;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
      img.data[i * 4 + 3] = v;
    }
    sctx.putImageData(img, 0, 0);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(small, 0, 0, w, h);
    return out;
  }

  // bg: null (transparent layer), {color} or {image}
  function composite(source, maskCanvas, w, h, bg) {
    const layer = document.createElement('canvas');
    layer.width = w; layer.height = h;
    const lctx = layer.getContext('2d');
    lctx.drawImage(source, 0, 0, w, h);
    lctx.globalCompositeOperation = 'destination-in';
    lctx.drawImage(maskCanvas, 0, 0, w, h);
    if (!bg) return layer;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (bg.color) {
      ctx.fillStyle = bg.color;
      ctx.fillRect(0, 0, w, h);
    } else if (bg.image) {
      const s = Math.max(w / bg.image.naturalWidth, h / bg.image.naturalHeight);
      const bw = bg.image.naturalWidth * s, bh = bg.image.naturalHeight * s;
      ctx.drawImage(bg.image, (w - bw) / 2, (h - bh) / 2, bw, bh);
    }
    ctx.drawImage(layer, 0, 0);
    return c;
  }

  window.BGModel = { getSegmenter, toInput, maskToCanvas, composite };
})();
