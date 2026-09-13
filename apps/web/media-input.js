export const HOLD_CANCEL_DISTANCE_PX = 70;
export const MIN_HOLD_MS = 500;
export const MAX_RECORDING_MS = 60_000;

export function selectRecordingMimeType(MediaRecorderCtor = globalThis.MediaRecorder) {
  if (!MediaRecorderCtor?.isTypeSupported) return null;
  return ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg']
    .find((type) => MediaRecorderCtor.isTypeSupported(type)) || null;
}

export function shouldCancelHold(startY, currentY) { return startY - currentY >= HOLD_CANCEL_DISTANCE_PX; }

// 微信 XWEB 等定制内核裁掉 MediaRecorder 的 webm/opus、ogg/opus 编码器
// （isTypeSupported 全为 false），但 getUserMedia + AudioContext 可用（通话页
// 同一栈已真机验证）：直接从麦克风采 PCM 自封 WAV，不经 MediaRecorder 容器
// 与 decodeAudioData，任何能开麦的 WebView 都能产出服务端原生支持的 audio/wav。
export async function createPcmWavRecorder(stream) {
  const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextCtor) throw new Error('AUDIO_CAPTURE_UNAVAILABLE');
  const audioContext = new AudioContextCtor();
  await audioContext.resume().catch(() => { /* 部分内核在手势栈内自动 running */ });
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  processor.onaudioprocess = (event) => { chunks.push(new Float32Array(event.inputBuffer.getChannelData(0))); };
  source.connect(processor);
  // ScriptProcessor 必须连到 destination 才会被驱动；直连会外放录音形成回声，
  // 中间串一个零增益 GainNode 静音输出。
  const mute = audioContext.createGain(); mute.gain.value = 0;
  processor.connect(mute); mute.connect(audioContext.destination);
  return {
    async stop() {
      try { processor.onaudioprocess = null; processor.disconnect(); source.disconnect(); mute.disconnect(); } catch { /* 已断开 */ }
      const samples = mergeFloat32Chunks(chunks);
      const sampleRate = audioContext.sampleRate;
      await audioContext.close().catch(() => { /* 已关闭 */ });
      if (!samples.length) throw new Error('AUDIO_EMPTY');
      if (samples.length / sampleRate > 60.5) throw new Error('AUDIO_TOO_LONG');
      return renderMonoWav(samples, sampleRate);
    },
  };
}

function mergeFloat32Chunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return merged;
}

// 任意采样率单声道 PCM → OfflineAudioContext 重采样 16k → PCM16 WAV。
async function renderMonoWav(samples, sourceRate) {
  const OfflineCtor = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OfflineCtor) throw new Error('AUDIO_DECODE_UNAVAILABLE');
  const targetRate = 16_000;
  const length = Math.max(1, Math.ceil(samples.length * targetRate / sourceRate));
  const offline = new OfflineCtor(1, length, targetRate);
  const buffer = offline.createBuffer(1, samples.length, sourceRate);
  buffer.getChannelData(0).set(samples);
  const node = offline.createBufferSource(); node.buffer = buffer; node.connect(offline.destination); node.start();
  const rendered = await offline.startRendering();
  return new Blob([encodePcm16Wav(rendered.getChannelData(0), targetRate)], { type: 'audio/wav' });
}

export async function recordingBlobToWav(blob) {
  const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextCtor) throw new Error('AUDIO_DECODE_UNAVAILABLE');
  const audioContext = new AudioContextCtor();
  try {
    const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
    if (!decoded.duration || decoded.duration > 60.5) throw new Error(decoded.duration > 60.5 ? 'AUDIO_TOO_LONG' : 'AUDIO_EMPTY');
    return await renderMonoWav(decoded.getChannelData(0), decoded.sampleRate);
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
