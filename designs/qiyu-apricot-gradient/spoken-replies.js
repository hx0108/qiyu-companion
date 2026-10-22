// Local prototype timeline only. No microphone, speech synthesis or provider call.
const qiyuReplyStates = new WeakMap();
let qiyuActiveReply = null;
let qiyuReplyClock = null;

function prepareSpokenReply(bubble, text) {
  bubble.classList.add('spoken-reply');
  const sample = text.includes('先把今天的忙碌放下来');
  const parts = sample
    ? ['好，', '先把今天的忙碌', '放下来。', '\n', '你已经做得很好了，', '\n', '现在可以好好放松一下。']
    : (text.match(/[^，。！？；\n]+[，。！？；]?|[，。！？；]|\n/g) || [text]);
  const duration = sample ? 12 : Math.max(4, Math.min(30, Math.ceil(text.replace(/\s/g, '').length / 4)));
  bubble.dataset.playback = 'idle';
  bubble.innerHTML = '<button class="spoken-toggle" type="button" data-action="spoken" aria-label="播放语音演示" aria-pressed="false"><span class="spoken-control-mark" data-icon="play" aria-hidden="true"></span></button>'
    + parts.map(part => part === '\n' ? '<br>' : '<span class="spoken-phrase">' + esc(part) + '</span>').join('')
    + '<span class="spoken-duration" aria-label="语音时长' + duration + '秒">' + Math.floor(duration / 60) + ':' + String(duration % 60).padStart(2, '0') + '</span>';
  const phrases = [...bubble.querySelectorAll('.spoken-phrase')];
  qiyuReplyStates.set(bubble, { bubble, button: bubble.querySelector('button'), phrases, duration: duration * 1000, elapsed: 0, started: 0, playing: false });
  icons();
}

function hydrateSpokenReplies() {
  document.querySelectorAll('#messages > .msg:not(.user) > .bubble:not(.voice)').forEach(bubble => {
    const text = [...bubble.childNodes].map(node => node.nodeName === 'BR' ? '\n' : node.textContent).join('');
    prepareSpokenReply(bubble, text);
  });
}

function paintSpokenReply(state, playing) {
  state.playing = playing;
  state.bubble.dataset.playback = playing ? 'playing' : state.elapsed >= state.duration ? 'ended' : state.elapsed > 0 ? 'paused' : 'idle';
  state.button.setAttribute('aria-pressed', String(playing));
  state.button.setAttribute('aria-label', playing ? '暂停语音演示' : state.elapsed >= state.duration ? '重新播放语音演示' : state.elapsed > 0 ? '继续播放语音演示' : '播放语音演示');
  state.button.querySelector('[data-icon]').dataset.icon = playing ? 'pause' : 'play';
  icons();
  highlightSpokenReply(state);
}

function highlightSpokenReply(state) {
  const total = state.phrases.reduce((sum, phrase) => sum + phrase.textContent.length, 0);
  const position = state.elapsed / state.duration * total;
  let cursor = 0;
  state.phrases.forEach(phrase => {
    const end = cursor + phrase.textContent.length;
    phrase.classList.toggle('is-current', state.elapsed > 0 && state.elapsed < state.duration && position >= cursor && position < end);
    cursor = end;
  });
}

function pauseSpokenReplies() {
  clearInterval(qiyuReplyClock);
  qiyuReplyClock = null;
  if (qiyuActiveReply?.playing) {
    qiyuActiveReply.elapsed = Math.min(qiyuActiveReply.duration, qiyuActiveReply.resumeAt + performance.now() - qiyuActiveReply.started);
    paintSpokenReply(qiyuActiveReply, false);
  }
}

function toggleSpokenReply(button) {
  const state = qiyuReplyStates.get(button.closest('.spoken-reply'));
  if (!state) return;
  if (state.playing) { pauseSpokenReplies(); return; }
  pauseSpokenReplies();
  if (state.elapsed >= state.duration) state.elapsed = 0;
  qiyuActiveReply = state;
  state.started = performance.now();
  state.resumeAt = state.elapsed;
  paintSpokenReply(state, true);
  const resumeAt = state.elapsed;
  qiyuReplyClock = setInterval(() => {
    if (!state.bubble.isConnected) { pauseSpokenReplies(); return; }
    state.elapsed = Math.min(state.duration, resumeAt + performance.now() - state.started);
    highlightSpokenReply(state);
    if (state.elapsed >= state.duration) {
      clearInterval(qiyuReplyClock);
      qiyuReplyClock = null;
      paintSpokenReply(state, false);
    }
  }, 100);
}

document.addEventListener('visibilitychange', () => { if (document.hidden) pauseSpokenReplies(); });
