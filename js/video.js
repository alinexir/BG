(() => {
  const root = document.getElementById('page-video');
  const $ = (id) => root.querySelector('#' + id);
  const CFG = window.BG_CONFIG;
  const MAX = 100 * 1024 * 1024;
  let busy = false, cancelled = false, origUrl = null, outUrl = null, ffmpeg = null;

  const drop = $('drop'), fileInput = $('file');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) handle(f); });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) handle(fileInput.files[0]); });

  const showError = (msg) => { $('error').textContent = msg; $('error').classList.remove('hidden'); };
  const hideError = () => $('error').classList.add('hidden');
  const setProgress = (p, label) => {
    $('bar').style.width = Math.round(p) + '%';
    $('percent').textContent = Math.round(p) + '%';
    $('statusText').textContent = label;
  };
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const once = (el, ev) => new Promise((res) => el.addEventListener(ev, res, { once: true }));
  const seek = (v, t) => new Promise((res) => {
    if (Math.abs(v.currentTime - t) < 0.001) return res();
    v.addEventListener('seeked', () => res(), { once: true });
    v.currentTime = t;
  });
  const loadScript = (src, global) => new Promise((res, rej) => {
    if (window[global]) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('بارگذاری FFmpeg ناموفق بود. اتصال اینترنت را بررسی کنید.'));
    document.head.appendChild(s);
  });

  async function loadFFmpeg() {
    if (ffmpeg) return ffmpeg;
    await loadScript(CFG.FFMPEG_UTIL_URL, 'FFmpegUtil');
    await loadScript(CFG.FFMPEG_URL, 'FFmpegWASM');
    const { FFmpeg } = window.FFmpegWASM;
    const { toBlobURL } = window.FFmpegUtil;
    const base = CFG.FFMPEG_CORE_URL.replace('ffmpeg-core.js', '');
    const f = new FFmpeg();
    await f.load({
      coreURL: await toBlobURL(base + 'ffmpeg-core.js', 'text/javascript'),
      wasmURL: await toBlobURL(base + 'ffmpeg-core.wasm', 'application/wasm'),
    });
    ffmpeg = f;
    return f;
  }

  function friendly(err) {
    const msg = String((err && err.message) || err);
    if (/memory|out of/i.test(msg)) return 'حافظه مرورگر برای این ویدیو کافی نیست. ویدیوی کوتاه‌تر یا با وضوح کمتر امتحان کنید.';
    if (/WebAssembly|SharedArrayBuffer|Worker/i.test(msg)) return 'FFmpeg یا پردازش هوش مصنوعی در این مرورگر اجرا نشد. جزئیات: ' + msg.slice(0, 300);
    return msg;
  }

  async function cleanup(ff, total, ext) {
    try {
      for (let i = 0; i < total; i++) await ff.deleteFile(`f${String(i).padStart(6, '0')}.jpg`).catch(() => {});
      await ff.deleteFile('input.' + ext).catch(() => {});
      await ff.deleteFile('out.mp4').catch(() => {});
    } catch (e) { /* ignore */ }
  }

  async function handle(f) {
    hideError();
    if (!/\.(mp4|mov)$/i.test(f.name) && !['video/mp4', 'video/quicktime'].includes(f.type)) return showError('فقط فایل‌های MP4 و MOV پشتیبانی می‌شوند.');
    if (f.size > MAX) return showError('حجم ویدیو بیش از ۱۰۰ مگابایت است.');
    if (busy) return;
    busy = true; cancelled = false;

    drop.classList.add('hidden');
    $('workspace').classList.remove('hidden');
    $('progressBox').classList.remove('hidden');
    $('resultBox').classList.add('hidden');
    $('cancel').classList.remove('hidden');
    $('cancel').disabled = false;
    if (origUrl) URL.revokeObjectURL(origUrl);
    origUrl = URL.createObjectURL(f);
    $('origVideo').src = origUrl;

    const bgColor = $('bgColor').value;
    const ext = /\.mov$/i.test(f.name) || f.type === 'video/quicktime' ? 'mov' : 'mp4';
    let ff = null, total = 0;
    try {
      setProgress(0, 'در حال بارگذاری مدل…');
      const seg = await BGModel.getSegmenter((p) => setProgress(p * 10, 'در حال دانلود مدل (فقط بار اول)…'));
      setProgress(10, 'در حال بارگذاری FFmpeg…');
      ff = await loadFFmpeg();

      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.preload = 'auto';
      video.src = origUrl;
      await once(video, 'loadedmetadata');
      const dur = Math.min(video.duration, CFG.VIDEO_MAX_SECONDS);
      const scale = Math.min(1, 1280 / video.videoWidth);
      const W = even(video.videoWidth * scale), H = even(video.videoHeight * scale);
      total = Math.max(1, Math.floor(dur * CFG.VIDEO_FPS));

      const srcC = document.createElement('canvas'); srcC.width = W; srcC.height = H;
      const sctx = srcC.getContext('2d');
      const outC = document.createElement('canvas'); outC.width = W; outC.height = H;
      const octx = outC.getContext('2d');

      await ff.writeFile('input.' + ext, new Uint8Array(await f.arrayBuffer()));

      let prev = null;
      for (let i = 0; i < total; i++) {
        if (cancelled) throw new Error('cancelled');
        await seek(video, i / CFG.VIDEO_FPS);
        sctx.drawImage(video, 0, 0, W, H);
        const mask = await seg.segment(BGModel.toInput(srcC));
        // temporal smoothing keeps the mask stable between frames (less flicker)
        if (prev) for (let k = 0; k < mask.length; k++) mask[k] = 0.6 * mask[k] + 0.4 * prev[k];
        prev = mask.slice();
        const layer = BGModel.composite(srcC, BGModel.maskToCanvas(mask, W, H), W, H, null);
        octx.fillStyle = bgColor;
        octx.fillRect(0, 0, W, H);
        octx.drawImage(layer, 0, 0);
        const blob = await new Promise((r) => outC.toBlob(r, 'image/jpeg', 0.92));
        await ff.writeFile(`f${String(i).padStart(6, '0')}.jpg`, new Uint8Array(await blob.arrayBuffer()));
        setProgress(10 + ((i + 1) / total) * 75, `حذف پس‌زمینه فریم ${i + 1} از ${total}`);
      }
      if (cancelled) throw new Error('cancelled');

      setProgress(86, 'ساخت ویدیوی نهایی…');
      ff.on('progress', ({ progress }) => setProgress(86 + Math.min(1, Math.max(0, progress)) * 13, 'ساخت ویدیوی نهایی…'));
      await ff.exec([
        '-framerate', String(CFG.VIDEO_FPS), '-i', 'f%06d.jpg',
        '-i', 'input.' + ext,
        '-map', '0:v:0', '-map', '1:a?',
        '-t', String(dur),
        '-c:v', 'mpeg4', '-q:v', '3', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest',
        'out.mp4',
      ]);
      const data = await ff.readFile('out.mp4');
      const blob = new Blob([data.buffer], { type: 'video/mp4' });
      if (outUrl) URL.revokeObjectURL(outUrl);
      outUrl = URL.createObjectURL(blob);
      $('resultVideo').src = outUrl;
      $('download').href = outUrl;
      $('progressBox').classList.add('hidden');
      $('cancel').classList.add('hidden');
      $('resultBox').classList.remove('hidden');
    } catch (err) {
      $('progressBox').classList.add('hidden');
      $('workspace').classList.add('hidden');
      drop.classList.remove('hidden');
      showError(cancelled ? 'پردازش لغو شد.' : friendly(err));
    } finally {
      if (ff) await cleanup(ff, total, ext);
      busy = false;
    }
  }

  $('cancel').addEventListener('click', () => {
    cancelled = true;
    $('cancel').disabled = true;
    setProgress(0, 'در حال لغو…');
  });
  $('reset').addEventListener('click', () => {
    $('workspace').classList.add('hidden');
    $('resultBox').classList.add('hidden');
    drop.classList.remove('hidden');
    fileInput.value = '';
    hideError();
  });
})();
