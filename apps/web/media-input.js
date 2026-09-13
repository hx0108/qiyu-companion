export const HOLD_CANCEL_DISTANCE_PX = 70;
export const MIN_HOLD_MS = 500;
export const MAX_RECORDING_MS = 60_000;

export function selectRecordingMimeType(MediaRecorderCtor = globalThis.MediaRecorder) {
  if (!MediaRecorderCtor?.isTypeSupported) return null;
  return ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg']
    .find((type) => MediaRecorderCtor.isTypeSupported(type)) || null;
}

export function shouldCancelHold(startY, currentY) { return startY - currentY >= HOLD_CANCEL_DISTANCE_PX; }

export async function recordingBlobToWav(blob) {
  const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextCtor) throw new Error('AUDIO_DECODE_UNAVAILABLE');
  const audioContext = new AudioContextCtor();
  try {
    const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
    if (!decoded.duration || decoded.duration > 60.5) throw new Error(decoded.duration > 60.5 ? 'AUDIO_TOO_LONG' : 'AUDIO_EMPTY');
    const targetRate = 16_000;
    const length = Math.ceil(decoded.duration * targetRate);
    const offline = new OfflineAudioContext(1, length, targetRate);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
    const rendered = await offline.startRendering();
    return new Blob([encodePcm16Wav(rendered.getChannelData(0), targetRate)], { type: 'audio/wav' });
  } finally { await audioContext.close().catch(() => {}); }
}

// 通话页边录边传按 2 秒自封带头 WAV：与语音消息共用同一编码口径（导出复用）。
export function encodePcm16Wav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2); const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, samples[index])) * 0x7fff, true);
  return buffer;
}
function writeAscii(view, offset, text) { for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index)); }
