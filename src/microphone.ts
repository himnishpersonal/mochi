/** Bound permission/device startup and release a stream that arrives after timeout. */
export function openMicrophone(timeoutMs = 20_000): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      settled = true;
      reject(new Error("Microphone access was not confirmed. Allow MOCHI in System Settings → Privacy & Security → Microphone, then try recording again."));
    }, timeoutMs);
    if (!navigator.mediaDevices?.getUserMedia) {
      window.clearTimeout(timeout);
      reject(new Error("Microphone capture is unavailable. Reopen the MOCHI desktop app and try again."));
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(stream => {
      window.clearTimeout(timeout);
      if (settled) { stream.getTracks().forEach(track => track.stop()); return; }
      settled = true;
      resolve(stream);
    }, error => {
      window.clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
