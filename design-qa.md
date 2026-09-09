# Design QA — 对话消息语音入口

- Source visual truth: `C:\Users\ASUS\AppData\Local\Temp\codex-clipboard-f0a8d995-d2d4-48c8-a7e4-3a1d269a19d1.jpg`
- Source pixels: 1084 × 1505
- Verified preview: `http://127.0.0.1:3000/?ui=voice-v4`, Codex in-app Browser tab 4 capture on 2026-09-10
- Actual trial entry: `http://127.0.0.1:3101/`
- State: day-theme chat with one user message and one assistant Mock reply; generated-audio state is covered by API regression and client logic, while the temporary preview has no TTS provider
- Comparison scope: assistant-message voice affordance only. Background art, message-card palette, typography and composer remain in 栖语's existing design system.

## Visual comparison evidence

The source establishes a compact, dark play affordance associated with an assistant reply. Following the user's corrective screenshot, the implementation moves the visible pill to the assistant bubble's lower-right edge and reduces it to 34 × 26 CSS px. A transparent 44 × 44 CSS px hit target preserves touch accessibility without increasing the visible weight.

The source uses a white filled play symbol on charcoal. The implementation uses standalone Material Icons play and pause assets in white on the existing `--qy-plum` token, with a night-mode plum variant. No visible “生成角色语音” label remains; the accessible name changes between generate-and-play, play and pause states.

## Interaction verification

- First click creates the TTS job, downloads the private media Blob, re-renders the message, and requests playback.
- After media exists, the same control toggles play/pause and swaps the icon.
- If browser autoplay policy rejects playback after the asynchronous provider request, the generated audio remains available and the interface explicitly asks the user to click the same button once more.
- Starting one assistant message pauses any other playing assistant audio.
- The temporary 3000 preview correctly reaches the controlled no-TTS failure path; the actual 3101 Docker entry serves the updated autoplay and toggle code.
- API regression: 27/27 tests passed, including TTS persistence, private media delivery, failure gating and static asset allowlisting.
- Real provider probe passed: Tencent TTS returned a non-empty 13,824-byte audio payload, and Tencent ASR transcribed it successfully.
- The separate full closed-trial probe was blocked before TTS by `QWEN_NETWORK_ERROR`; this is an upstream Qwen reachability issue rather than an audio generation or playback-code failure.

## Findings and iteration history

- Initial pass: 48 × 38 visible pill at the upper-left; rejected by user as too large and incorrectly positioned.
- Corrective pass: 34 × 26 visible pill at lower-right with 44 × 44 hit target; verified in the in-app Browser.
- Stale browser shell cache initially retained the first pass. Versioned asset URLs plus a network-first `qiyu-shell-v3` service worker now make UI updates visible after reload while preserving offline fallback.
- Playback incident follow-up: the UI had received a live SSE assistant ID and text, but PostgreSQL had already committed and released the request-scoped connection before the stream producer wrote its terminal message. The SSE producer now opens a fresh account transaction and flushes the final assistant message before completion, so TTS can resolve the same message ID.
- Existing orphaned client-only replies are removed by reloading server history; if TTS encounters one, the client now synchronizes history instead of leaving an unusable play button.
- No actionable P0, P1 or P2 difference remains within the requested component scope.

final result: passed
