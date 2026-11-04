// Central config. Model URL taken from the onnx-community/BiRefNet-ONNX repo (fp32, ~973 MB, big for phones).
// Library URLs are not tested in the build sandbox.
window.BG_CONFIG = {
  MODEL_URL: 'https://huggingface.co/onnx-community/BiRefNet-ONNX/resolve/main/onnx/model.onnx',
  MODEL_SIZE_HINT: 973 * 1024 * 1024,
  ORT_URL: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.min.js',
  ORT_WASM_BASE: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/',
  FFMPEG_URL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js',
  FFMPEG_UTIL_URL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/umd/index.js',
  FFMPEG_CORE_URL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js',
  VIDEO_MAX_SECONDS: 30,
  VIDEO_FPS: 24,
  INPUT_SIZE: 1024
};
