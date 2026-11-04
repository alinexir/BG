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

  // Loads ONNX Runtime with a normal <script> tag (works where importScripts in a Worker failed).
  function tryScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => (window.ort ? resolve(window.ort) : reject(new Error('ort غیرفعال بعد از ' + url)));
      s.onerror = () => reject(new Error('بارگذاری ناموفق: ' + url));
      document.head.appendChild(s);
    });
  }

  async function loadOrt() {
    if (window.ort) return window.ort;
    let lastErr = null;
    for (const src of CFG.ORT_SOURCES) {
      try {
        const ort = await tryScript(new URL(src.url, location.href).href);
        ort.env.wasm.wasmPaths = new URL(src.wasm, location.href).href;
        ort.env.wasm.numThreads = 1; // single thread: no cross-origin isolation needed
        return ort;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error('ONNX Runtime نتوانست بارگذاری شود: ' + (lastErr && lastErr.message));
  }

  // Shared segmenter: one session reused for every image and video frame.
  function getSegmenter(onProgress) {
    if (segPromise) return segPromise;
    segPromise = (async () => {
      const modelBuffer = await fetchModel(onProgress);
      const ort = await loadOrt();
      let session = null;
      let provider = 'wasm';
      if (navigator.gpu) {
        try {
          session = await ort.InferenceSession.create(modelBuffer, { executionProviders: ['webgpu', 'wasm'], graphOptimizationLevel: 'all' });
          provider = 'webgpu';
        } catch (e) {
          session = null;
        }
      }
      if (!session) {
        session = await ort.InferenceSession.create(modelBuffer, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      }
      const inName = session.inputNames[0];
      const outName = session.outputNames[0];
      const S = CFG.INPUT_SIZE;
      return {
        provider,
        async segment(input) {
          const feeds = {};
          feeds[inName] = new ort.Tensor('float32', input, [1, 3, S, S]);
          const out = await session.run(feeds);
          const raw = out[outName].data;
          let min = Infinity, max = -Infinity;
          for (let i = 0; i < raw.length; i++) { if (raw[i] < min) min = raw[i]; if (raw[i] > max) max = raw[i]; }
          // logits get squashed to 0..1, probabilities are kept as they are
          const needSigmoid = min < 0 || max > 1;
          const mask = new Float32Array(raw.length);
          for (let i = 0; i < raw.length; i++) mask[i] = needSigmoid ? 1 / (1 + Math.exp(-raw[i])) : raw[i];
          return mask;
        },
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
