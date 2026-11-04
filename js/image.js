(() => {
  const root = document.getElementById('page-image');
  const $ = (id) => root.querySelector('#' + id);
  const ACCEPT = ['image/png', 'image/jpeg', 'image/webp'];
  const MAX = 15 * 1024 * 1024;
  let origUrl = null, outUrl = null, bgImg = null, srcImg = null, layerCanvas = null, maskCanvas = null;
  let busy = false, cancelled = false;

  const drop = $('drop'), fileInput = $('file');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) handle(f); });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) handle(fileInput.files[0]); });

  const showError = (msg) => { $('error').textContent = msg; $('error').classList.remove('hidden'); };
  const hideError = () => $('error').classList.add('hidden');
  const setStatus = (t, p) => { $('loadingText').textContent = t; $('loadingBar').style.width = (p == null ? 0 : Math.round(p * 100)) + '%'; };
  const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

  function friendly(err) {
    const msg = String((err && err.message) || err);
    if (/memory|out of/i.test(msg)) return 'حافظه دستگاه برای این تصویر کافی نیست. تصویر کوچک‌تری امتحان کنید.';
    if (/Failed to fetch|NetworkError/i.test(msg)) return 'دانلود مدل ناموفق بود. اتصال اینترنت را بررسی کنید.';
    if (/WebAssembly|webgpu|Worker/i.test(msg)) return 'پردازش هوش مصنوعی در این مرورگر اجرا نشد. جزئیات: ' + msg.slice(0, 300);
    return msg;
  }

  async function handle(f) {
    hideError();
    if (!ACCEPT.includes(f.type)) return showError('فقط فایل‌های PNG، JPG، JPEG و WEBP پشتیبانی می‌شوند.');
    if (f.size > MAX) return showError('حجم فایل بیش از ۱۵ مگابایت است.');
    if (busy) return;
    busy = true; cancelled = false;
    drop.classList.add('hidden');
    $('loading').classList.remove('hidden');
    if (origUrl) URL.revokeObjectURL(origUrl);
    origUrl = URL.createObjectURL(f);
    $('orig').src = origUrl;
    try {
      setStatus('در حال بارگذاری مدل…', 0);
      const seg = await BGModel.getSegmenter((p) => setStatus('در حال دانلود مدل (فقط بار اول)…', p));
      setStatus('در حال حذف پس‌زمینه… (' + (seg.provider === 'webgpu' ? 'WebGPU' : 'WASM') + ')', null);
      srcImg = await loadImg(origUrl);
      const mask = await seg.segment(BGModel.toInput(srcImg));
      if (cancelled) throw new Error('cancelled');
      const w = srcImg.naturalWidth, h = srcImg.naturalHeight;
      maskCanvas = BGModel.maskToCanvas(mask, w, h);
      layerCanvas = BGModel.composite(srcImg, maskCanvas, w, h, null);
      $('loading').classList.add('hidden');
      $('workspace').classList.remove('hidden');
      await render();
    } catch (err) {
      $('loading').classList.add('hidden');
      drop.classList.remove('hidden');
      showError(cancelled ? 'پردازش لغو شد.' : friendly(err));
    } finally {
      busy = false;
    }
  }

  async function render() {
    if (!layerCanvas) return;
    const mode = $('bgMode').value;
    let canvas = layerCanvas;
    if (mode === 'color') canvas = BGModel.composite(srcImg, maskCanvas, layerCanvas.width, layerCanvas.height, { color: $('bgColor').value });
    else if (mode === 'image' && bgImg) canvas = BGModel.composite(srcImg, maskCanvas, layerCanvas.width, layerCanvas.height, { image: bgImg });
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    if (outUrl) URL.revokeObjectURL(outUrl);
    outUrl = URL.createObjectURL(blob);
    $('result').src = outUrl;
    $('download').href = outUrl;
  }

  $('cancel').addEventListener('click', () => {
    cancelled = true;
    $('loading').classList.add('hidden');
    drop.classList.remove('hidden');
    showError('پردازش لغو شد.');
  });
  $('split').addEventListener('input', (e) => $('stage').style.setProperty('--pos', e.target.value + '%'));
  $('bgMode').addEventListener('change', () => {
    const m = $('bgMode').value;
    $('bgColor').classList.toggle('hidden', m !== 'color');
    $('bgFile').classList.toggle('hidden', m !== 'image');
    render();
  });
  $('bgColor').addEventListener('input', () => { if ($('bgMode').value === 'color') render(); });
  $('bgFile').addEventListener('change', async () => {
    const f = $('bgFile').files[0];
    if (!f) return;
    if (!f.type.startsWith('image/')) return showError('فایل پس‌زمینه باید تصویر باشد.');
    bgImg = await loadImg(URL.createObjectURL(f));
    render();
  });
  $('reset').addEventListener('click', () => {
    $('workspace').classList.add('hidden');
    drop.classList.remove('hidden');
    fileInput.value = '';
    srcImg = layerCanvas = maskCanvas = null;
    hideError();
  });
})();
