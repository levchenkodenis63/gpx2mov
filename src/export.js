'use strict';

window.recordTrip = async function recordTrip(canvas, durationSeconds, draw, onProgress, signal) {
  if (!canvas.captureStream || typeof MediaRecorder === 'undefined') {
    throw new Error('Этот браузер не поддерживает запись видео с карты.');
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('Укажите положительную длительность видео.');
  }
  const abortError = () => new DOMException('Экспорт отменён.', 'AbortError');
  if (signal?.aborted) throw abortError();

  const frameRate = 30;
  const frameMs = 1000 / frameRate;
  const durationMs = durationSeconds * 1000;
  const stream = canvas.captureStream(frameRate);
  let recorder;
  let timer;
  let abort;
  let visibilityChange;

  try {
    return await new Promise((resolve, reject) => {
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      abort = () => fail(abortError());
      visibilityChange = () => {
        if (document.hidden) fail(new Error('Запись прервана. Повторите экспорт и оставьте вкладку открытой.'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      document.addEventListener('visibilitychange', visibilityChange);
      if (document.hidden) {
        visibilityChange();
        return;
      }

      let chunks = [];
      let finished = false;
      const formats = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
      for (const mimeType of formats) {
        if (MediaRecorder.isTypeSupported && !MediaRecorder.isTypeSupported(mimeType)) continue;
        try {
          recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8000000 });
          recorder.ondataavailable = (event) => {
            if (event.data.size) chunks.push(event.data);
          };
          recorder.onerror = () => fail(new Error('Браузер прервал запись видео.'));
          recorder.onstop = () => {
            if (!finished || !chunks.length) {
              fail(new Error('Не удалось завершить запись видео.'));
              return;
            }
            const type = recorder.mimeType || chunks[0].type || mimeType;
            resolve({ blob: new Blob(chunks, { type }), extension: type.includes('mp4') ? 'mp4' : 'webm' });
          };
          recorder.start();
          break;
        } catch {
          if (recorder) recorder.onstop = recorder.ondataavailable = recorder.onerror = null;
          recorder = undefined;
          chunks = [];
        }
      }
      if (!recorder) {
        fail(new Error('Браузер не смог запустить видеокодек. Попробуйте другой браузер.'));
        return;
      }

      const start = performance.now();
      function frame() {
        try {
          const elapsed = performance.now() - start;
          const fraction = Math.min(1, elapsed / durationMs);
          draw(fraction);
          onProgress?.(fraction);
          if (fraction === 1) {
            finished = true;
            timer = setTimeout(() => {
              try { recorder.stop(); } catch (error) { fail(error); }
            }, frameMs);
          } else {
            const next = Math.min(durationMs, (Math.floor(elapsed / frameMs) + 1) * frameMs);
            timer = setTimeout(frame, Math.max(1, start + next - performance.now()));
          }
        } catch (error) {
          fail(error);
        }
      }
      draw(0);
      onProgress?.(0);
      timer = setTimeout(frame, frameMs);
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    document.removeEventListener('visibilitychange', visibilityChange);
    if (recorder) {
      recorder.onstop = recorder.ondataavailable = recorder.onerror = null;
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* Recorder may already be stopping. */ }
      }
    }
    stream.getTracks().forEach(track => track.stop());
  }
};
