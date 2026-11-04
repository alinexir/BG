'use strict';
// Runs ONNX Runtime inference off the main thread.
let ort = null;
let session = null;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      importScripts(m.ortUrl);
      ort = self.ort;
      ort.env.wasm.wasmPaths = m.wasmBase;
      ort.env.wasm.numThreads = Math.max(1, Math.min(4, self.navigator.hardwareConcurrency || 1));
      let provider = 'wasm';
      if (m.webgpu) {
        try {
          session = await ort.InferenceSession.create(m.modelBuffer, { executionProviders: ['webgpu', 'wasm'], graphOptimizationLevel: 'all' });
          provider = 'webgpu';
        } catch (err) {
          session = null; // WebGPU failed on this device, fall back to WASM
        }
      }
      if (!session) {
        session = await ort.InferenceSession.create(m.modelBuffer, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      }
      self.postMessage({ type: 'ready', provider });
    } else if (m.type === 'infer') {
      const feeds = {};
      feeds[session.inputNames[0]] = new ort.Tensor('float32', m.data, [1, 3, 1024, 1024]);
      const out = await session.run(feeds);
      const raw = out[session.outputNames[0]].data;
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < raw.length; i++) { if (raw[i] < min) min = raw[i]; if (raw[i] > max) max = raw[i]; }
      // If outputs look like logits, squash them to 0..1 probabilities
      const needSigmoid = min < 0 || max > 1;
      const mask = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) mask[i] = needSigmoid ? 1 / (1 + Math.exp(-raw[i])) : raw[i];
      self.postMessage({ type: 'result', id: m.id, mask: mask.buffer }, [mask.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: 'خطا در اجرای مدل: ' + (err && err.message ? err.message : err) });
  }
};
