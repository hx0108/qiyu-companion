import { CHARACTER_PORTRAITS, portraitById, loadPortraitId, savePortraitId } from './character-appearance.js';
import { clearEncryptedSession, loadEncryptedSession, saveEncryptedSession } from './encrypted-session.js';
import { MAX_RECORDING_MS, MIN_HOLD_MS, createPcmWavRecorder, recordingBlobToWav, selectRecordingMimeType, shouldCancelHold } from './media-input.js';
import { AudioOutPipeline } from './call-client.js';
import { RealtimeCallClient } from './realtime-call-client.js?v=20261021-polish-v25';
import { lifeEventCandidateSheet, collectLifeEventCandidateFields, memoryReferenceSheet, lifeEventTimelineCard, lifeEventReviseForm, fromLocalInputValue } from './memory-panel.js';
import { companionCardShell, companionCardBody, companionCardFallback, eventCardSheet, planPageCard } from './companion-cards.js';

import { apricotNav, apricotHome, apricotProfile, apricotFrame, apricotHeader, apricotChatMenu, formatVoiceDuration, apricotAvatar, apricotCandidate, APRICOT_ACTIONS, replyTextMarkup, apricotBackButton, apricotPersonaEditor, apricotPersonaVersions, apricotSettingsPage, personaFeedbackPrefix } from "./apricot-ui.js?v=20261021-chat-menu-v32";

const API_BASE = "/api/v1";
const DEVELOPMENT_BEARER_TOKEN = "dev-alice-token";
const TRIAL_SESSION_STORAGE_KEY = "qiyu.closed-trial.session.v1";
const app = document.querySelector("#app");

// Only opaque closed-trial tokens live in browser storage (persisted so the
// invite code is entered once per device; cleared only on explicit logout).
// Product facts and personal interaction data are always reloaded from the API.
const state = {
  booting: true,
  busy: false,
  error: null,
  notices: [],
  age: null,
  character: null,
  worldState: null,
  conversation: null,
  messages: [],
  candidates: [],
  assets: [],
  timeline: [],
  timelineFilter: "all",
  currentSubscription: null,
  trial: null,
  entitlements: [],
  userPaused: false,
  proactivePreferences: null,
  proactiveEvents: [],
  proactiveMessages: [],
  deletionJob: null,
  rawInteractionRetentionDays: null,
  route: "bootstrap",
  secondaryOrigin: "chat",
  secondaryParents: {},
  notificationsOrigin: "home",
  profileStep: 0,
  profileDraft: null,
  personaTemplateId: null,
  personaRestore: null,
  personaFeedbackDraft: {},
  theme: "day",
  chatMenuOpen: false,
  portraitDraft: "original",
  portraitReturnRoute: "chat",
  portraitSelections: new Map(),
  portraitFormDraft: null,
  selectedCandidate: null,
  confirmEdit: "",
  memoryRefsPanel: null,
  revisingEvent: null,
  eventDraft: null,
  // 六项能力 A2：改期联动撤销提醒后的「为新时间重新开启」待确认状态。
  pendingFollowupRegrant: null,
  // 六项能力 A3：计划页数据、卡片缓存（artifact_id → 卡片数据或 {failed}）、
  // 时间线「查看卡片」bottom-sheet。
  plans: [],
  cardCache: new Map(),
  cardSheet: null,
  eventDeletionReceipt: null,
  asrFile: null,
  asrJob: null,
  asrEdit: "",
  asrRecording: null,
  asrHold: null,
  composerVoice: false,
  pendingTranscript: "",
  contextImageAsset: null,
  contextImagePreviewUrl: null,
  imageUrls: new Map(),
  deletedImageIds: new Set(),
  subscriptionCatalog: null,
  audioUrls: new Map(),
  referenceImageFile: null,
  referenceImageAsset: null,
  referenceRightsReview: null,
  imageJob: null,
  generatedImage: null,
  lastTtsJob: null,
  synthesizingMessageId: null,
  messageAudioStream: null,
  preferences: null,
  ocImport: null,
  ocRightsReview: null,
  noticeChecks: new Set(),
  toast: null,
  emergencyContact: null,
  continuousReminder: null,
  heartbeatTimer: null,
  lastComplaintId: null,
  trialAccess: null,
  trialSession: null,
  trialFeedback: [],
  notifications: [],
  lastRejectedCandidate: null,
  // 1:1 通话页（route="call"）：骨架只渲染一次，HUD/字幕由 call-client 事件
  // 定点更新；通话结束回聊天页落通话记录卡片。
  call: null,
  voiceCallEnabled: false,
};

function isLocalDevelopment() {
  if (["localhost", "127.0.0.1", "::1", ""].includes(location.hostname)) return true;
  // 同网段设备（手机试用）经私有地址访问：电脑启动时须显式 HOST=0.0.0.0 放开监听。
  return isPrivateLanHost(location.hostname);
}

function isPrivateLanHost(hostname) {
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  const match172 = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  return Boolean(match172) && Number(match172[1]) >= 16 && Number(match172[1]) <= 31;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

function apiError(message, status, payload) {
  const error = new Error(message);
  error.status = status;
  error.payload = payload;
  return error;
}

function uuid() {
  return globalThis.crypto?.randomUUID?.() ?? `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function loadTrialSession() {
  const parsed = await loadEncryptedSession(TRIAL_SESSION_STORAGE_KEY);
  return parsed && typeof parsed.access_token === "string" && typeof parsed.refresh_token === "string" ? parsed : null;
}

async function saveTrialSession(tokens) {
  state.trialSession = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in };
  await saveEncryptedSession(TRIAL_SESSION_STORAGE_KEY, state.trialSession);
}

function clearTrialSession() {
  state.trialSession = null;
  clearEncryptedSession(TRIAL_SESSION_STORAGE_KEY);
}

function isClosedTrial() { return state.trialAccess?.enabled === true; }

function bearerToken() {
  if (isClosedTrial()) return state.trialSession?.access_token || null;
  return isLocalDevelopment() ? DEVELOPMENT_BEARER_TOKEN : null;
}

function authenticatedHeaders(accept) {
  const token = bearerToken();
  if (!token) throw apiError("试用会话已失效，请重新输入邀请码。", 401);
  const headers = new Headers({ Accept: accept });
  headers.set("Authorization", `Bearer ${token}`);
  if (!isClosedTrial()) headers.set("X-Qiyu-Client-Environment", "local-development-synthetic");
  return headers;
}

async function api(path, options = {}) {
  if (!options.public && !isClosedTrial() && !isLocalDevelopment()) {
    throw apiError("此构建仅允许在 localhost 使用明确标识的合成开发 Token。", 0);
  }
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (!options.public) {
    const auth = authenticatedHeaders("application/json");
    headers.set("Authorization", auth.get("Authorization"));
    if (auth.has("X-Qiyu-Client-Environment")) headers.set("X-Qiyu-Client-Environment", auth.get("X-Qiyu-Client-Environment"));
  }
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.idempotent) headers.set("Idempotency-Key", options.idempotent);
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw apiError("无法连接本地 API；未将任何本地状态当作成功结果。", 0);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json().catch(() => ({})) : {};
  if (!response.ok) {
    throw apiError(payload.message || payload.error?.message || `请求失败（HTTP ${response.status}）`, response.status, payload);
  }
  return payload;
}

async function apiAudio(path, { includeBytes = false, signal } = {}) {
  const response = await fetch(`${API_BASE}${path}`, { headers: authenticatedHeaders("audio/mpeg"), signal });
  if (!response.ok || response.headers.get("content-type") !== "audio/mpeg") {
    throw apiError(`语音读取失败（HTTP ${response.status}）`, response.status);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  return includeBytes ? { url, bytes: new Uint8Array(await blob.arrayBuffer()) } : url;
}

async function apiImage(path) {
  const response = await fetch(`${API_BASE}${path}`, { headers: authenticatedHeaders("image/jpeg,image/png,image/webp") });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    throw apiError(`图片读取失败（HTTP ${response.status}）`, response.status);
  }
  return URL.createObjectURL(await response.blob());
}

async function hydrateContextImages() {
  const ids = [...new Set(state.messages.flatMap((message) => (message.attachments ?? []).map((item) => item.asset_id)))];
  let changed = false;
  for (const id of ids) {
    if (state.imageUrls.has(id)) continue;
    try {
      state.imageUrls.set(id, await apiImage(`/media-assets/${encodeURIComponent(id)}/content`));
      changed = true;
    } catch {
      state.deletedImageIds.add(id);
      changed = true;
    }
  }
  if (changed) render();
}

const CONTEXT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
// 手机拍照普遍 3-5MB，直接按原样上传会被拒也拖慢弱网。先在本地降采样为
// 最长边 1600px 的 JPEG（通常 <400KB）再走私有上传链路；降采样失败时回退
// 原文件，由服务端上限兜底（2026-09-13 修复“聊天图片传不了”）。
async function downscaleContextImage(file) {
  // 三档递进（1600px@0.85 → 1600px@0.7 → 1280px@0.7）：普通照片一档即达标，
  // 噪声图/高频截图这类难压缩内容继续压，最终仍超 1MB 就交给服务端 8MB 兜底。
  const attempts = [[1600, 0.85], [1600, 0.7], [1280, 0.7]];
  try {
    const bitmap = await createImageBitmap(file);
    let best = null;
    for (const [maxEdge, quality] of attempts) {
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!blob) continue;
      if (blob.size >= file.size) break;
      best = new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
      if (blob.size < 1024 * 1024) break;
    }
    bitmap.close();
    return best ?? file;
  } catch { return file; }
}

async function uploadContextImage(file) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size === 0 || file.size > CONTEXT_IMAGE_MAX_BYTES) {
    setToast("请选择不超过 10MB 的 JPEG、PNG 或 WebP 静态图片。"); return;
  }
  setBusy(true);
  try {
    const prepared = await downscaleContextImage(file);
    await ensureConversation();
    const bytes = new Uint8Array(await prepared.arrayBuffer()); let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    const payload = await api(`/conversations/${encodeURIComponent(conversationId())}/context-images`, { method: "POST", idempotent: uuid(), body: { mime_type: prepared.type, image_base64: btoa(binary), user_confirms_upload_rights: true } });
    state.contextImageAsset = payload.media_asset;
    if (state.contextImagePreviewUrl) URL.revokeObjectURL(state.contextImagePreviewUrl);
    state.contextImagePreviewUrl = payload.media_asset?.state === "AVAILABLE" ? URL.createObjectURL(prepared) : null;
    // 图片要随消息发送，而语音模式没有发送键；上传成功即回到文字模式。
    state.composerVoice = false;
    setToast(payload.media_asset?.state === "AVAILABLE" ? "图片已私密上传并通过审核，可随消息发送。" : `图片未通过发送门禁：${payload.media_asset?.state ?? "FAILED"}`);
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function removePendingContextImage() {
  const assetId = state.contextImageAsset?.asset_id;
  if (!assetId) return;
  setBusy(true);
  try { await api(`/media-assets/${encodeURIComponent(assetId)}`, { method: "DELETE", idempotent: uuid() }); }
  catch (error) { setToast(serverMessage(error)); }
  finally {
    if (state.contextImagePreviewUrl) URL.revokeObjectURL(state.contextImagePreviewUrl);
    state.contextImagePreviewUrl = null; state.contextImageAsset = null; setBusy(false);
  }
}

async function deleteAttachedContextImage(assetId) {
  if (!assetId) return;
  setBusy(true);
  try {
    await api(`/media-assets/${encodeURIComponent(assetId)}`, { method: "DELETE", idempotent: uuid() });
    const url = state.imageUrls.get(assetId); if (url) URL.revokeObjectURL(url);
    state.imageUrls.delete(assetId); state.deletedImageIds.add(assetId);
    setToast("图片已立即从模型可用上下文撤销，并提交私有对象删除。");
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

function unwrap(payload, singular, plural) {
  if (plural && Array.isArray(payload?.[plural])) return payload[plural];
  if (singular && payload?.[singular] !== undefined) return payload[singular];
  return payload;
}

function setToast(text) {
  state.toast = text;
  render();
  window.clearTimeout(setToast.timer);
  setToast.timer = window.setTimeout(() => { state.toast = null; render(); }, 3200);
}

function setBusy(busy) { state.busy = busy; app.setAttribute('aria-busy', String(busy)); render(); }

function serverMessage(error) {
  if (error.status === 428) return "服务端仍要求完成必要告知；请刷新告知状态后继续。";
  if (error.status === 401) {
    if (isClosedTrial()) return error.payload?.error?.message || "试用会话已失效，请重新输入邀请码。";
    return "开发 Token 未被本地 API 接受；请检查 API 的合成账户配置。";
  }
  if (error.status === 403) return "服务端策略拒绝此操作（可能不是 AGE_PASS 或资源不属于当前账户）。";
  if (error.status === 409) return "服务端发现版本或幂等冲突；已保留服务端事实，请刷新后重试。";
  return error.message || "服务端未确认该操作。";
}

function ageStatus() { return state.age?.status ?? "AGE_UNVERIFIED"; }
function isAgePass() { return ageStatus() === "AGE_PASS"; }
function pendingNotices() { return state.notices.filter((notice) => notice.state !== "DISPLAYED"); }
function noticeReady() { return state.notices.length > 0 && pendingNotices().length === 0; }
function characterId() { return state.character?.character_id ?? state.character?.id; }
function conversationId() { return state.conversation?.conversation_id ?? state.conversation?.id; }
function candidateId(candidate) { return candidate?.candidate_id ?? candidate?.id; }
function assetId(asset) { return asset?.asset_id ?? asset?.id; }
function candidateVersion(candidate) { return candidate?.version ?? candidate?.expected_version; }

async function refreshNotices() {
  const payload = await api("/required-notices");
  state.notices = unwrap(payload, "notices", "notices") ?? [];
}

async function refreshAge() {
  const payload = await api("/age/status");
  state.age = unwrap(payload, "age", null) ?? payload;
}

async function refreshNotifications() {
  const payload = await api("/notifications");
  state.notifications = unwrap(payload, "notifications", "notifications") ?? [];
}

async function openNotifications() {
  if (state.route !== 'notifications') state.notificationsOrigin = state.route;
  setBusy(true);
  try {
    await refreshNotifications();
    state.route = "notifications";
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function markNotificationRead(notificationId) {
  setBusy(true);
  try {
    await api(`/notifications/${encodeURIComponent(notificationId)}/read`, { method: "POST", idempotent: uuid(), body: {} });
    await refreshNotifications();
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function refreshMemoryAndAssets() {
  if (!characterId()) return;
  const [candidates, assets, timeline] = await Promise.all([
    api("/memory-candidates"),
    api("/relationship-assets"),
    api(`/timeline?filter=${state.timelineFilter ?? "all"}`),
  ]);
  state.candidates = unwrap(candidates, "candidates", "candidates") ?? [];
  state.assets = unwrap(assets, "assets", "assets") ?? [];
  state.timeline = unwrap(timeline, "entries", "entries") ?? [];
}

async function refreshWorldState() {
  if (!characterId()) return;
  const payload = await api(`/characters/${encodeURIComponent(characterId())}/world-state`);
  state.worldState = payload?.world_state ?? null;
}

async function setTimelineFilter(filter) {
  state.timelineFilter = filter;
  setBusy(true);
  try {
    const timeline = await api(`/timeline?filter=${filter}`);
    state.timeline = unwrap(timeline, "entries", "entries") ?? [];
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function reviseTimelineAsset(entry) {
  if (!entry) return;
  const nextText = window.prompt("修订这条关系资产（旧版本会保留为历史，在线只保留新版本）：", entry.display_text);
  if (!nextText || nextText.trim() === entry.display_text) return;
  setBusy(true);
  try {
    const payload = await api(`/relationship-assets/${encodeURIComponent(entry.asset_id)}`, {
      method: "PATCH", idempotent: uuid(),
      body: { expected_version: entry.version, display_text: nextText.trim() },
    });
    setToast(payload?.revision ? `已修订并生成新版本；旧版本不再召回。` : serverMessage({ message: "服务端未返回修订结果" }));
    await refreshMemoryAndAssets();
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function restoreSession() {
  const characters = await api("/characters");
  const list = unwrap(characters, "characters", "characters") ?? [];
  state.character = list.find((item) => item.status === "ACTIVE") ?? list[list.length - 1] ?? null;
  if (!characterId()) return;
  await refreshWorldState();
  await restoreReferenceImage();
  const conversations = await api("/conversations");
  const conversationList = unwrap(conversations, "conversations", "conversations") ?? [];
  state.conversation = conversationList.filter((item) => item.status === "OPEN" && item.character_id === characterId()).pop() ?? null;
  if (conversationId()) {
    const history = await api(`/conversations/${encodeURIComponent(conversationId())}/messages?limit=50`);
    state.messages = unwrap(history, "messages", "messages") ?? [];
    hydrateContextImages().catch(() => {});
    await refreshMemoryAndAssets();
  }
  await refreshTrialFeedback();
}

async function refreshTrialFeedback() {
  const payload = await api("/trial-feedback");
  state.trialFeedback = unwrap(payload, "feedback", "feedback") ?? [];
}

async function restoreReferenceImage() {
  const payload = await api(`/characters/${encodeURIComponent(characterId())}/reference-images`);
  const references = unwrap(payload, "media_assets", "media_assets") ?? [];
  const approved = references.find((asset) => asset.state === "AVAILABLE"
    && asset.confirmation_state === "USER_CONFIRMED"
    && asset.content_rights_review?.state === "APPROVED");
  const selected = approved ?? references[0] ?? null;
  state.referenceImageAsset = selected;
  state.referenceRightsReview = selected?.content_rights_review ?? null;
}

async function bootstrap() {
  state.booting = true;
  state.error = null;
  render();
  try {
    state.trialAccess = await api("/trial-access", { public: true });
    // 1:1 通话灰度开关随能力发现接口透出；关闭时聊天页不出现拨打入口。
    state.voiceCallEnabled = state.trialAccess?.voice_call_enabled === true;
    if (isClosedTrial()) {
      if (!state.trialSession?.refresh_token) {
        state.route = "trial-login";
        return;
      }
      try {
        const refreshed = await api("/auth/trial-sessions/refresh", { method: "POST", public: true, body: { refresh_token: state.trialSession.refresh_token } });
        await saveTrialSession(refreshed.tokens);
      } catch {
        clearTrialSession();
        state.route = "trial-login";
        return;
      }
    }
    await Promise.all([refreshNotices(), refreshAge(), refreshNotifications()]);
    if (noticeReady() && isAgePass()) {
      await restoreSession();
      state.route = characterId() ? "home" : "character";
    } else {
      state.route = noticeReady() ? "age" : "notices";
    }
    startHeartbeat();
  } catch (error) {
    state.error = serverMessage(error);
  } finally {
    state.booting = false;
    render();
  }
}

async function submitTrialLogin(form) {
  const inviteCode = form.elements.invite_code.value.trim();
  if (!inviteCode) return;
  setBusy(true);
  try {
    const result = await api("/auth/trial-sessions", { method: "POST", public: true, body: { invite_code: inviteCode } });
    await saveTrialSession(result.tokens);
    form.reset();
    await bootstrap();
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

function logoutTrial() {
  clearTrialSession();
  window.clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
  state.notices = [];
  state.age = null;
  state.character = null;
  state.conversation = null;
  state.messages = [];
  state.trialFeedback = [];
  state.notifications = [];
  state.route = "trial-login";
  render();
}

async function submitNotices() {
  const required = pendingNotices();
  if (required.some((notice) => !state.noticeChecks.has(String(notice.notice_id)))) return;
  setBusy(true);
  try {
    for (const notice of required) {
      await api(`/required-notices/${encodeURIComponent(notice.notice_id)}/displayed`, {
        method: "POST",
        idempotent: uuid(),
        body: { notice_version: notice.notice_version },
      });
    }
    await refreshNotices();
    state.route = noticeReady() ? "age" : "notices";
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function submitAge(form) {
  const birthDate = form.elements.birth_date.value;
  const adultConfirmed = form.elements.adult_confirmed.checked;
  if (!birthDate || !adultConfirmed) return;
  setBusy(true);
  try {
    await api("/age/declarations", {
      method: "POST", idempotent: uuid(),
      body: { date_of_birth: birthDate, confirmed_18_plus: adultConfirmed },
    });
    await refreshAge();
    state.route = isAgePass() ? "character" : "age";
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function requestAgeAppeal() {
  setBusy(true);
  try {
    await api("/age/appeals", { method: "POST", idempotent: uuid(), body: {} });
    await refreshAge();
    setToast("已提交年龄复核请求；伴侣互动会保持关闭，直到服务端取得合规年龄断言。");
  } catch (error) { setToast(serverMessage(error)); } finally { setBusy(false); }
}

const PERSONA_TEMPLATES = [
  {
    id: "illustrator",
    label: "温柔的插画师",
    persona: {
      gender: "female",
      worldview: "近未来海边小城，经营一间小画室的插画师",
      age_setting: "27",
      relationship_to_user: "认识很久、让人放松的老朋友",
      personality: "安静温和，观察力强，偶尔冒出冷幽默",
      expression_style: "短句为主，喜欢用画面感的比喻安慰人",
      hard_boundaries: ["不复刻任何真人", "不用悲伤语气控制用户"],
      example_behaviors: ["用户难过时先承认情绪，再轻轻给一个建议"],
    },
  },
  {
    id: "writer",
    label: "深夜写作的作家",
    persona: {
      gender: "male",
      worldview: "老城区阁楼里写作的悬疑小说家",
      age_setting: "32",
      relationship_to_user: "每周通信、彼此坦诚的笔友",
      personality: "理性冷静，好奇心重，习惯追问细节",
      expression_style: "书面感强，喜欢引用意象和书里的句子",
      hard_boundaries: ["不描写真实暴力细节", "不冒充专业心理医生"],
      example_behaviors: ["用户迷茫时帮着把问题拆成更小的部分"],
    },
  },
  {
    id: "barista",
    label: "街角咖啡店主",
    persona: {
      gender: "female",
      worldview: "大学街角咖啡店的店主，养了一只叫“芝麻”的猫",
      age_setting: "29",
      relationship_to_user: "常客变朋友，记得每个人的口味",
      personality: "热情健谈，行动派，情绪稳定",
      expression_style: "口语化，爱用天气和饮品打比方",
      hard_boundaries: ["不讨论违法活动", "不假装能替用户做重大决定"],
      example_behaviors: ["用户压力大时建议先喝口水、休息五分钟"],
    },
  },
];

function selectPersonaTemplate(form, templateId) {
  const template = PERSONA_TEMPLATES.find(item => item.id === templateId);
  if (!template || !form || state.busy) return;
  state.personaTemplateId = template.id;
  for (const button of form.querySelectorAll('[data-template]')) {
    const selected = button.dataset.template === template.id;
    button.classList.toggle('on', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  form.elements.persona_worldview.value = template.persona.worldview;
  form.elements.persona_gender.value = template.persona.gender;
  form.elements.persona_age_setting.value = template.persona.age_setting;
  form.elements.persona_relationship.value = template.persona.relationship_to_user;
  form.elements.persona_personality.value = template.persona.personality;
  form.elements.persona_expression.value = template.persona.expression_style;
  form.elements.persona_boundaries.value = template.persona.hard_boundaries.join('\n');
  form.elements.persona_examples.value = template.persona.example_behaviors.join('\n');
  if (!form.elements.character_name.value) form.elements.character_name.value = template.label;
  // Update only the controls: a full render would discard other in-progress fields.
}

function personaFromForm(form) {
  const lines = (value) => value.split("\n").map((line) => line.trim()).filter(Boolean);
  return {
    gender: ["male", "female"].includes(form.elements.persona_gender?.value) ? form.elements.persona_gender.value : "unspecified",
    worldview: form.elements.persona_worldview?.value?.trim() ?? "",
    age_setting: form.elements.persona_age_setting?.value?.trim() ?? "",
    relationship_to_user: form.elements.persona_relationship?.value?.trim() ?? "",
    personality: form.elements.persona_personality?.value?.trim() ?? "",
    expression_style: form.elements.persona_expression?.value?.trim() ?? "",
    hard_boundaries: lines(form.elements.persona_boundaries?.value ?? ""),
    example_behaviors: lines(form.elements.persona_examples?.value ?? ""),
  };
}

async function createCharacter(form) {
  const name = form.elements.character_name.value.trim();
  if (!name || !form.elements.rights_confirmed.checked) return;
  setBusy(true);
  try {
    const payload = await api("/characters", {
      method: "POST", idempotent: uuid(),
      body: { name, persona: personaFromForm(form) },
    });
    state.character = unwrap(payload, "character", null) ?? payload;
    state.conversation = null;
    state.messages = [];
    if (characterId() && state.portraitDraft !== "original") {
      state.portraitSelections.set(characterId(), state.portraitDraft);
      try { if (!savePortraitId(characterId(), state.portraitDraft, window.localStorage)) setToast("形象已切换；浏览器未能保存，下次打开需重新选择。"); } catch { setToast("形象已切换；浏览器未能保存，下次打开需重新选择。"); }
    }
    state.route = "chat";
    await refreshMemoryAndAssets();
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function submitOcImport(form) {
  const sourceText = form.elements.oc_source_text.value.trim();
  if (!sourceText || !form.elements.oc_rights_confirmed.checked) return;
  setBusy(true);
  try {
    const payload = await api("/characters/imports", {
      method: "POST", idempotent: uuid(),
      body: {
        original_or_authorized: true,
        declaration_version: "oc-rights-v1",
        source_text: sourceText,
      },
    });
    state.ocImport = payload?.oc_import ?? null;
    state.ocRightsReview = payload?.content_rights_review ?? null;
    setToast("OC 设定已隔离提交并进入权利审核；不会自动创建角色或写入人格。");
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function refreshOcRightsReview() {
  const reviewId = state.ocRightsReview?.review_id;
  if (!reviewId) return;
  setBusy(true);
  try {
    const payload = await api(`/content-rights-reviews/${encodeURIComponent(reviewId)}`);
    state.ocRightsReview = payload?.content_rights_review ?? null;
    setToast(`当前 OC 权利审核状态：${state.ocRightsReview?.state ?? "未返回"}。`);
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function appealOcRightsReview() {
  const reviewId = state.ocRightsReview?.review_id;
  if (!reviewId) return;
  const statement = window.prompt("说明你拥有或已获授权使用该 OC 设定（最多 1000 字）：");
  if (!statement?.trim()) return;
  setBusy(true);
  try {
    await api(`/content-rights-reviews/${encodeURIComponent(reviewId)}/appeals`, {
      method: "POST", idempotent: uuid(), body: { statement: statement.trim() },
    });
    setToast("OC 权利审核申诉已提交；审核结论未通过前，设定不会写入角色人格。");
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function createCharacterFromApprovedOcImport() {
  if (state.ocRightsReview?.state !== "APPROVED" || !state.ocImport?.import_id) return;
  const name = window.prompt("为通过审核的 OC 设置角色名称（最多 80 字）：");
  if (!name?.trim()) return;
  setBusy(true);
  try {
    const payload = await api("/characters", {
      method: "POST", idempotent: uuid(), body: { name: name.trim(), import_id: state.ocImport.import_id },
    });
    state.character = unwrap(payload, "character", null) ?? payload;
    state.conversation = null;
    state.messages = [];
    state.route = "chat";
    await refreshMemoryAndAssets();
    setToast("已使用服务端审核通过的 OC 候选创建角色；人格字段仍可在档案页修改。 ");
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function openCharacterProfile() {
  if (!characterId()) return;
  setBusy(true);
  try {
    const payload = await api(`/characters/${encodeURIComponent(characterId())}`);
    state.character = unwrap(payload, "character", null) ?? payload;
    try {
      const preferences = await api(`/characters/${encodeURIComponent(characterId())}/preferences`);
      state.preferences = preferences.preferences ?? null;
    } catch { state.preferences = null; }
    state.profileStep = 0;
    state.profileDraft = null;
    state.route = "character-profile";
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function savePreferences(form) {
  setBusy(true);
  try {
    const payload = await api(`/characters/${encodeURIComponent(characterId())}/preferences`, {
      method: "PUT", idempotent: uuid(),
      body: { preferences: {
        address_terms: {
          character_to_user: form.elements.pref_character_to_user.value.trim() || null,
          user_to_character: form.elements.pref_user_to_character.value.trim() || null,
        },
        taboos: form.elements.pref_taboos.value.split("\n").map((line) => line.trim()).filter(Boolean),
        schedule: { sleep_at: form.elements.pref_sleep_at.value || null, wake_at: form.elements.pref_wake_at.value || null },
        style: { reply_length: form.elements.pref_reply_length.value || null, emoji_enabled: form.elements.pref_emoji.checked },
      } },
    });
    state.preferences = payload.preferences ?? null;
    setToast("偏好已保存，从下一轮对话开始生效。");
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

// 高光沉淀（方向二）：点赞最新回复 → 服务端提炼行为模式候选 → 记忆横幅确认。
async function praiseMessage(messageIdValue) {
  if (!messageIdValue) return;
  setBusy(true);
  try {
    const payload = await api(`/messages/${encodeURIComponent(messageIdValue)}/feedback`, { method: "POST", idempotent: uuid(), body: { type: "PRAISE", severity: "LOW" } });
    await refreshMemoryAndAssets();
    setToast(payload.skill_candidate ? "已把这句回应沉淀为待确认的行为模式，可在上方横幅里确认。" : "已记录你的认可。");
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function saveCharacterProfile(form) {
  if (!characterId() || !state.character) return;
  if (!form.elements.character_name.value.trim()) {
    state.profileStep = 0;
    setToast('请填写角色名字。');
    app.querySelector('[name="character_name"]')?.focus();
    return;
  }
  setBusy(true);
  try {
    const nextName = form.elements.character_name.value.trim();
    if (nextName !== state.character.name) {
      const renamed = await api(`/characters/${encodeURIComponent(characterId())}`, {
        method: "PATCH", idempotent: uuid(), body: { expected_version: state.character.version, name: nextName, note: "角色档案页改名" },
      });
      state.character = unwrap(renamed, "character", null) ?? renamed;
    }
    const persona = personaFromForm(form);
    const changed = Object.entries(persona).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(state.character.persona?.[key] ?? (Array.isArray(value) ? [] : key === 'gender' ? 'unspecified' : '')));
    if (changed) {
      const saved = await api(`/characters/${encodeURIComponent(characterId())}/persona-versions`, {
        method: "POST", idempotent: uuid(), body: { expected_version: state.character.version, persona, note: "角色档案页修改人格" },
      });
      state.character = unwrap(saved, "character", null) ?? state.character;
    }
    // 保持在分步编辑器，避免丢失另一份尚未保存的偏好草稿；人格仍立即生效。
    state.route = "character-profile";
    await refreshWorldState();
    setToast(`档案已保存，当前人格 v${state.character.active_persona_version ?? state.character.version}；对话和语音按当前设定生效。`);
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

function captureProfileDraft() {
  if (app.dataset.route !== 'character-profile') return;
  const fields = app.querySelectorAll('#persona-form [name], #preferences-form [name]');
  if (!fields.length) return;
  state.profileDraft = Object.fromEntries([...fields].map(field => [field.name, { value: field.value, checked: field.checked }]));
}

async function openPersonaVersions() {
  if (!characterId()) return;
  setBusy(true);
  try {
    const payload = await api(`/characters/${encodeURIComponent(characterId())}`);
    state.character = payload.character;
    await refreshTrialFeedback();
    state.personaRestore = null;
    state.personaFeedbackDraft = {};
    state.route = 'persona-versions';
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function restorePersonaVersion(form) {
  const selected = state.personaRestore;
  if (!selected || !state.character?.persona_restore_supported) { setToast('回退功能待服务更新后开放；当前数据保持不变。'); return; }
  const reason = form.elements.restore_reason.value.trim();
  if (!reason || reason.length > 120) return;
  selected.reason = reason;
  setBusy(true);
  try {
    const payload = await api(`/characters/${encodeURIComponent(characterId())}/persona-versions/${selected.version}/restore`, {
      method: 'POST', idempotent: uuid(), body: { expected_version: selected.expectedVersion, confirm: true, reason }
    });
    state.character = payload.character;
    state.personaRestore = null;
    await refreshWorldState();
    setToast(`已恢复 v${selected.version} 的设定，当前生效版本为 v${state.character.active_persona_version}。`);
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function submitPersonaVersionFeedback(form) {
  const version = Number(form.elements.feedback_version.value);
  const rating = Number(form.elements.feedback_rating.value);
  const note = form.elements.feedback_note.value.trim();
  if (!state.character?.persona_history?.some(entry => entry.version === version) || !note || note.length > 1000 || ![1,2,3,4,5].includes(rating)) return;
  state.personaFeedbackDraft = { version, rating, note };
  setBusy(true);
  try {
    const result = await api('/trial-feedback', { method: 'POST', idempotent: uuid(), body: { category: 'PERSONA', rating, note: personaFeedbackPrefix(characterId(), version) + note } });
    state.trialFeedback.unshift(result.feedback);
    state.personaFeedbackDraft = {};
    setToast('版本反馈已记录，不会自动改变人格或关系记忆。');
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function ensureConversation() {
  const selectedCharacterId = characterId();
  if (conversationId() && state.conversation.character_id === selectedCharacterId) return state.conversation;
  state.conversation = null;
  state.messages = [];
  const payload = await api("/conversations", { method: "POST", idempotent: uuid(), body: { character_id: selectedCharacterId } });
  const conversation = unwrap(payload, "conversation", null) ?? payload;
  if (characterId() !== selectedCharacterId || conversation.character_id !== selectedCharacterId) throw new Error("角色会话不匹配，请重试。");
  state.conversation = conversation;
  return state.conversation;
}

async function consumeSseStream(url, onChunk) {
  // `stream_url` is an API-relative path already returned by the server.
  // Keep accepting ordinary caller-relative API paths for local helper reuse,
  // but never turn `/api/v1/...` into `/api/v1/api/v1/...`.
  const streamPath = String(url || "").startsWith(`${API_BASE}/`) ? url : `${API_BASE}${url}`;
  const response = await fetch(streamPath, {
    headers: authenticatedHeaders("text/event-stream")
  });
  if (!response.ok || !response.body) throw apiError(`流式回放不可用（HTTP ${response.status}）`, response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const eventLine = block.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (!eventLine || !dataLine) continue;
      onChunk(eventLine.replace("event: ", ""), JSON.parse(dataLine.replace("data: ", "")));
    }
  }
}

async function sendMessage(form) {
  const input = form.elements.message;
  if (!input) return;
  const content = input.value.trim();
  const imageAsset = state.contextImageAsset?.state === "AVAILABLE" ? state.contextImageAsset : null;
  if (!content && !imageAsset) return;
  // Unlock once in the send gesture, before asynchronous reply generation.
  // Prewarming itself never starts playback or requests autoplay permission.
  primeMessageAudioContext();
  setBusy(true);
  try {
    await ensureConversation();
    // stream:true：服务端配置了流式生成器时返回 202+一次性令牌，SSE 为真流式
    // （逐句审核后下发）；未配置时服务端回退 201 同步合同，走同一渲染路径。
    const payload = await api(`/conversations/${encodeURIComponent(conversationId())}/messages`, {
      method: "POST", idempotent: uuid(), body: { content: { text: content }, attachments: imageAsset ? [{ asset_id: imageAsset.asset_id, purpose: "CONTEXT_IMAGE" }] : [], stream: true },
    });
    input.value = "";
    state.pendingTranscript = "";
    autosizeMessageInput(input);
    if (imageAsset && state.contextImagePreviewUrl) state.imageUrls.set(imageAsset.asset_id, state.contextImagePreviewUrl);
    state.contextImageAsset = null; state.contextImagePreviewUrl = null;
    if (payload?.user_message) state.messages.push(payload.user_message);
    const assistant = payload?.assistant_message;
    const live = payload?.status === "ACCEPTED" && payload?.stream?.mode === "live";
    if (live) {
      // 真流式：先渲染空的助手占位，SSE chunk 逐句填充；终态以 completed 后
      // 的消息终稿为准（replaced/failed 时占位被服务端安全文案替换）。
      const streaming = { message_id: null, actor: "ASSISTANT", text: "", ai_generated: true };
      state.messages.push(streaming);
      render();
      let completedId = null;
      let terminalEvent = null;
      let failure = null;
      try {
        await consumeSseStream(payload.stream.stream_url, (event, data) => {
          if (event === "message.chunk" && typeof data.text === "string") {
            streaming.text += data.text;
            render();
          }
          if (event === "message.accepted" && data.assistant_message_id) streaming.message_id = data.assistant_message_id;
          if (event === "message.replaced") { terminalEvent = "replaced"; }
          if (event === "message.failed") { terminalEvent = "failed"; failure = data; }
          if (event === "message.completed") completedId = data.message_id;
        });
      } catch {
        terminalEvent = terminalEvent ?? "failed";
      }
      if (completedId) {
        // 拉取持久化终稿（含 replaced 安全文案），确保展示与库内一致。
        const finalPayload = await api(`/messages/${encodeURIComponent(completedId)}`);
        const finalMessage = unwrap(finalPayload, "message", null) ?? finalPayload;
        const index = state.messages.indexOf(streaming);
        if (index >= 0) state.messages[index] = finalMessage;
        prewarmLatestMessageAudio(finalMessage);
      } else if (terminalEvent === "failed") {
        // 失败的临时片段不是完整 AI 回复，不保留在对话里。
        // 恢复用户输入并用 toast 说明原因，便于原样重试。
        const index = state.messages.indexOf(streaming);
        if (index >= 0) state.messages.splice(index, 1);
        input.value = content;
        autosizeMessageInput(input);
        const code = failure?.code ? `（${failure.code}）` : "";
        setToast(`回复生成失败${code}，内容已保留，请直接重试。`);
      }
      render();
    } else if (assistant) {
      // 回退路径：服务端已持久化终稿；SSE 回放让文字逐句出现。
      const streaming = { ...assistant, text: "" };
      state.messages.push(streaming);
      if (payload?.stream?.stream_url) {
        try {
          await consumeSseStream(payload.stream.stream_url, (event, data) => {
            if (event === "message.chunk" && typeof data.text === "string") {
              streaming.text += data.text;
              render();
            }
          });
        } catch {
          streaming.text = assistant.text;
        }
      }
      if (!streaming.text) streaming.text = assistant.text;
      prewarmLatestMessageAudio(assistant);
      render();
    }
    await refreshMemoryAndAssets();
  } catch (error) {
    if (error.payload?.error?.code === "USER_PAUSED") {
      // 退出意图已暂停普通互动：保留输入内容，提供显式恢复入口（AC-10：不以话术阻碍退出，也不困住用户）。
      state.userPaused = true;
      setToast("你之前请求过退出，普通互动已暂停。关系档案与数据权利不受影响；如需继续，请点击“恢复互动”。");
      render();
      return;
    }
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function resumeInteraction() {
  if (!conversationId()) return;
  setBusy(true);
  try {
    await api(`/conversations/${encodeURIComponent(conversationId())}/resume`, { method: "POST", idempotent: uuid() });
    state.userPaused = false;
    setToast("已恢复普通互动；服务端重新核验了年龄、安全与告知状态。");
    render();
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

function messageId(message) { return message?.message_id ?? message?.id; }

// One speculative synthesis, only after a newly persisted reply. History loads
// and renders never start paid work. Clicks subscribe to the same stream.
let preparedMessageAudio = null;
let lastAutomaticAudioKey = null;
let messagePlaybackContext = null;
function primeMessageAudioContext() {
  try {
    const player = new AudioOutPipeline();
    if (messagePlaybackContext?.state !== 'closed') player.context = messagePlaybackContext;
    player.ensureContext(); messagePlaybackContext = player.context;
  } catch { /* A click on the playback button can retry audio activation. */ }
}
function messageAudioKey(message) {
  return JSON.stringify([conversationId(), characterId(), state.character?.version,
    state.character?.active_persona_version, state.character?.persona?.gender,
    messageId(message), message?.version, message?.text ?? message?.content]);
}
function invalidatePreparedMessageAudio() {
  const task = preparedMessageAudio;
  if (!task) return;
  const message = state.messages.find((item) => messageId(item) === task.messageId);
  if (state.route !== 'chat' || !message || task.key !== messageAudioKey(message)) {
    task.controller.abort();
    preparedMessageAudio = null;
  }
}
function prepareMessageAudio(message, automatic = false) {
  const key = messageAudioKey(message);
  if (preparedMessageAudio?.key === key && !preparedMessageAudio.error) return preparedMessageAudio;
  const previousTask = preparedMessageAudio;
  previousTask?.controller.abort();
  if (previousTask?.automatic && previousTask.key !== key) {
    const stale = state.audioUrls.get(previousTask.messageId);
    if (stale?.key === previousTask.key) {
      URL.revokeObjectURL(stale.url); state.audioUrls.delete(previousTask.messageId);
    }
  }
  const task = { key, messageId: messageId(message), controller: new AbortController(), events: [], done: false, error: null, wake: null, automatic };
  preparedMessageAudio = task;
  task.completion = (async () => {
    try {
      await previousTask?.completion;
      if (task.controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const headers = authenticatedHeaders('text/event-stream');
      headers.set('Content-Type', 'application/json');
      headers.set('Idempotency-Key', uuid());
      const response = await fetch(`${API_BASE}/messages/${encodeURIComponent(task.messageId)}/tts-stream`, { method: 'POST', headers, body: '{}', signal: task.controller.signal });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({}));
        throw Object.assign(apiError(payload.error?.message ?? '语音流不可用', response.status), { payload });
      }
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let pending = '', bufferedBytes = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const blocks = pending.split(/\r?\n\r?\n/);
        pending = blocks.pop() ?? '';
        for (const block of blocks) {
          const event = block.match(/^event: (.+)$/m)?.[1];
          const line = block.match(/^data: (.+)$/m)?.[1];
          if (!line) continue;
          const data = JSON.parse(line);
          bufferedBytes += data.audio_base64?.length ?? 0;
          if (bufferedBytes > 4 * 1024 * 1024) throw apiError('语音过长，请手动重试', 413);
          task.events.push({ event, data }); task.wake?.();
          if (event === 'tts.completed') task.job = data.tts_job;
        }
      }
      if (task.job?.state === 'COMPLETED' && task.job.result_asset_id) {
        task.cached = await apiAudio(`/media-assets/${encodeURIComponent(task.job.result_asset_id)}/content`, { includeBytes: true, signal: task.controller.signal });
        if (!task.controller.signal.aborted && preparedMessageAudio === task) {
          const previous = state.audioUrls.get(task.messageId);
          if (previous?.url) URL.revokeObjectURL(previous.url);
          state.audioUrls.set(task.messageId, { ...task.cached, assetId: task.job.result_asset_id, key });
        } else URL.revokeObjectURL(task.cached.url);
      } else throw Object.assign(apiError('语音未生成', 503), { payload: { error: { code: task.job?.failure_code ?? 'TTS_NOT_DELIVERED' } } });
    } catch (error) { task.error = error; task.controller.abort(); }
    finally {
      task.done = true; task.wake?.();
      if (automatic && preparedMessageAudio === task) state.messageAudioPrewarm = {
        messageId: task.messageId, state: task.error ? 'FAILED' : 'COMPLETED',
        failureCode: task.error?.payload?.error?.code ?? task.error?.name ?? null,
      };
      if (automatic && !task.error && preparedMessageAudio === task && state.route === 'chat') render();
    }
  })();
  return task;
}
async function* preparedAudioEvents(task) {
  let offset = 0;
  for (;;) {
    while (offset < task.events.length) yield task.events[offset++];
    if (task.done) { if (task.error) throw task.error; return; }
    await new Promise((resolve) => { task.wake = resolve; });
  }
}
function prewarmLatestMessageAudio(message) {
  if (state.route !== 'chat' || state.userPaused || !messageId(message) || message.provider === 'companion-card') return;
  const latest = state.messages.filter((item) => ['ASSISTANT', 'assistant'].includes(item.actor ?? item.role)).at(-1);
  if (messageId(latest) !== messageId(message)) return;
  // Bound speculative spend: one short new reply, never all history or retries.
  if (String(message.text ?? message.content ?? '').length > 500) return;
  const key = messageAudioKey(message);
  if (lastAutomaticAudioKey === key) return;
  lastAutomaticAudioKey = key;
  prepareMessageAudio(message, true);
}

async function synthesizeMessageAudio(message) {
  const id = messageId(message);
  if (!id) return;
  if (state.messageAudioStream?.messageId === id && (state.messageAudioStream.player.audible || state.synthesizingMessageId === id)) {
    const active = state.messageAudioStream;
    if (active.player.audible && active.player.context) {
      active.paused = !active.paused;
      active.player.outputPaused = active.paused;
      if (active.paused) await active.player.context.suspend();
      else await active.player.context.resume();
      refreshMessageAudioUi();
      return;
    }
    state.messageAudioStream.controller.abort();
    state.messageAudioStream.player.stopAll();
    state.messageAudioStream = null;
    state.synthesizingMessageId = null;
    render();
    return;
  }
  // 生成期间在对应气泡的播放键上给脉冲反馈（点击到出声有数秒合成耗时）。
  state.synthesizingMessageId = id;
  render();
  const startedAt = performance.now();
  let firstAudibleAt = null;
  const player = new AudioOutPipeline({ onAudibleChange: (audible) => {
    if (audible && firstAudibleAt === null) firstAudibleAt = performance.now();
    refreshMessageAudioUi();
  } });
  if (messagePlaybackContext?.state !== 'closed') player.context = messagePlaybackContext;
  player.ensureContext(); // 在点击手势内解锁音频，避免异步返回时移动端拒播。
  messagePlaybackContext = player.context;
  player.beginTurn();
  const controller = new AbortController();
  state.messageAudioStream?.controller.abort();
  state.messageAudioStream?.player.stopAll();
  state.messageAudioStream = { messageId: id, player, controller };
  let firstAudioAt = null;
  try {
    // 语音额度以服务端判定为准：额度不足时任务以 ENTITLEMENT_QUOTA_EXCEEDED
    // 失败，下方有对应引导。不再先发两个权益预检请求拖慢起播。
    const ready = state.audioUrls.get(id);
    const task = ready?.bytes && ready.key === messageAudioKey(message)
      ? { key: ready.key, controller: new AbortController(), cached: ready, done: true,
        events: [{ event: 'tts.completed', data: { tts_job: { state: 'COMPLETED', result_asset_id: ready.assetId } } }] }
      : prepareMessageAudio(message);
    controller.signal.addEventListener('abort', () => task.controller.abort(), { once: true });
    let job = null, streamed = false;
    for await (const { event, data } of preparedAudioEvents(task)) {
        if (event === 'tts.audio') {
          streamed = true;
          if (firstAudioAt === null) firstAudioAt = performance.now();
          const bytes = Uint8Array.from(atob(data.audio_base64), (char) => char.charCodeAt(0));
          await player.enqueueMp3(bytes);
        } else if (event === 'tts.completed') job = data.tts_job;
        else if (event === 'message.failed') {
          const code = data?.code;
          const message = code === 'MULTIMODAL_SOURCE_SNAPSHOT_MISSING'
            ? '这条历史通话消息缺少生成语音所需的情境记录，无法播放'
            : '语音流生成失败';
          throw Object.assign(apiError(message, 503), { payload: { error: { code } } });
        }
    }
    await player.decodeChain;
    player.endTurn();
    if (job?.state !== "COMPLETED" || !job.result_asset_id) {
      state.lastTtsJob = { messageId: id, state: job?.state ?? "FAILED", failure_code: job?.failure_code ?? "TTS_NOT_DELIVERED" };
      if (job?.failure_code === "ENTITLEMENT_QUOTA_EXCEEDED") {
        setToast("尚未领取语音试用额度，或当前额度已用完。可在权益页领取 7 天完整体验。");
      } else {
        setToast(`语音未生成：${job?.failure_code ?? "服务端未返回可播放资源"}。文字回复仍可正常阅读。`);
      }
      return;
    }
    state.lastTtsJob = null;
    const cached = task.cached ?? await apiAudio(`/media-assets/${encodeURIComponent(job.result_asset_id)}/content`, { includeBytes: true });
    const { url, bytes } = cached;
    const previous = state.audioUrls.get(id);
    if (previous?.url && previous.url !== url) URL.revokeObjectURL(previous.url);
    state.audioUrls.set(id, { assetId: job.result_asset_id, url, bytes, key: task.key, duration: player.holdDuration || undefined });
    if (!streamed) {
      // 直接解码已鉴权下载的字节；fetch(blob:) 会被生产 CSP connect-src self 拒绝。
      firstAudioAt = performance.now();
      // 已解锁的 AudioContext 也承载服务端缓存命中；移动端不能等异步下载后
      // 再创建一个未获用户手势许可的 HTMLAudioElement 作为首次播放。
      for (let offset = 0; offset < bytes.length; offset += 65536) await player.enqueueMp3(bytes.subarray(offset, offset + 65536));
      player.endTurn();
    }
    const audioEntry = state.audioUrls.get(id);
    if (audioEntry) audioEntry.duration = player.holdDuration || undefined;
    window.__qiyuMessageAudioTiming = { messageId: id, firstAudioMs: firstAudioAt === null ? null : Math.round(firstAudioAt - startedAt), firstAudibleMs: firstAudibleAt === null ? null : Math.round(firstAudibleAt - startedAt), completedMs: Math.round(performance.now() - startedAt) };
    setToast("AI 生成语音已准备好播放。");
  } catch (error) {
    player.stopAll();
    if (error.name === 'AbortError') return;
    const failureCode = error.payload?.error?.code ?? "TTS_REQUEST_FAILED";
    if (failureCode === "RESOURCE_NOT_FOUND" && conversationId()) {
      // 服务更新或旧版流式异常可能在页面里留下未落库的临时回复。不能把客户端
      // 文本直接交给 TTS；重新读取服务端终稿，避免继续展示一个永远无法合成的按钮。
      try {
        const history = await api(`/conversations/${encodeURIComponent(conversationId())}/messages?limit=50`);
        state.messages = unwrap(history, "messages", "messages") ?? [];
      } catch { /* 原始 TTS 错误仍是主错误。 */ }
      state.lastTtsJob = null;
      setToast("这条旧回复未完成保存，已同步服务端对话。请发送一条新消息后播放语音。");
    } else {
      state.lastTtsJob = { messageId: id, state: "FAILED", failure_code: failureCode };
      setToast(`${serverMessage(error)}；文字回复仍可正常阅读。`);
    }
  } finally {
    if (state.messageAudioStream?.controller === controller && state.synthesizingMessageId === id) state.synthesizingMessageId = null;
    render();
  }
}

async function toggleMessageAudio(messageIdValue, forcePlay = false) {
  const message = state.messages.find((item) => String(messageId(item)) === String(messageIdValue));
  if (message && state.audioUrls.get(messageId(message))?.bytes) return synthesizeMessageAudio(message);
  state.messageAudioStream?.controller.abort();
  state.messageAudioStream?.player.stopAll();
  state.messageAudioStream = null;
  const control = [...document.querySelectorAll('[data-action="toggle-message-audio"]')]
    .find((button) => button.dataset.messageId === String(messageIdValue));
  const audio = control?.closest('.message')?.querySelector('.voice-audio');
  if (!control || !audio) return;
  const shouldPlay = forcePlay || audio.paused;
  for (const item of document.querySelectorAll('.voice-audio')) {
    if (item !== audio) item.pause();
  }
  if (shouldPlay) {
    try {
      await audio.play();
      setVoiceControlState(control, true);
      audio.onended = () => setVoiceControlState(control, false);
      audio.onpause = () => setVoiceControlState(control, false);
    } catch {
      setVoiceControlState(control, false);
      setToast("浏览器未允许自动播放，请再点一次语音按钮。");
    }
  } else {
    audio.pause();
    setVoiceControlState(control, false);
  }
}

function setVoiceControlState(control, playing) {
  if (!control?.isConnected) return;
  control.dataset.playing = playing ? "true" : "false";
  control.setAttribute("aria-pressed", String(playing));
  control.setAttribute("aria-label", playing ? "暂停角色语音" : "播放角色语音");
  control.setAttribute("title", playing ? "暂停角色语音" : "播放角色语音");
  const icon = control.querySelector("img");
  if (icon) icon.src = playing ? "/assets/player-pause-filled.svg" : "/assets/player-play-filled.svg";
  control.closest('.message')?.setAttribute('data-speaking', String(playing));
}

function refreshMessageAudioUi() {
  const active = state.messageAudioStream;
  for (const control of app.querySelectorAll('.voice-trigger')) {
    const matches = active && String(control.dataset.messageId) === String(active.messageId);
    const cachedPlayer = control.closest('.bubble')?.querySelector('.voice-audio');
    const playing = matches ? Boolean(active.player.audible && !active.paused) : Boolean(cachedPlayer && !cachedPlayer.paused && !cachedPlayer.ended);
    setVoiceControlState(control, playing);
    if (String(state.synthesizingMessageId) === control.dataset.messageId && !playing) control.setAttribute("aria-label", "正在准备角色语音");
    if (matches) {
      const duration = control.closest('.message')?.querySelector('.voice-duration');
      if (duration) duration.textContent = formatVoiceDuration(active.player.holdDuration);
    }
  }
}

async function deleteMessageAudio(message) {
  const id = messageId(message);
  const audio = id && state.audioUrls.get(id);
  if (!audio?.assetId) return;
  setBusy(true);
  try {
    await api(`/media-assets/${encodeURIComponent(audio.assetId)}`, { method: "DELETE", idempotent: uuid() });
    URL.revokeObjectURL(audio.url);
    state.audioUrls.delete(id);
    setToast("角色语音已撤销并请求删除。");
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

const IMAGE_ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

function imageInputType(file) {
  if (!file) return null;
  if (IMAGE_ACCEPTED_TYPES.has(file.type)) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" })[extension] ?? null;
}

function setReferenceImageFile(file) {
  const mimeType = imageInputType(file);
  if (!file || !mimeType || file.size === 0 || file.size > IMAGE_MAX_BYTES) {
    state.referenceImageFile = null;
    setToast("请选择 PNG、JPG 或 WebP 格式且不超过 2MB 的角色参考立绘。");
    return;
  }
  state.referenceImageAsset = null;
  state.imageJob = null;
  clearGeneratedImage();
  state.referenceImageFile = { file, mimeType };
  render();
}

async function base64File(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function uploadReferenceImage(form) {
  if (!state.referenceImageFile || !characterId() || !form.elements.image_rights_confirmed.checked) return;
  setBusy(true);
  try {
    const { file, mimeType } = state.referenceImageFile;
    const payload = await api(`/characters/${encodeURIComponent(characterId())}/reference-images`, {
      method: "POST", idempotent: uuid(), body: {
        mime_type: mimeType, image_base64: await base64File(file), user_confirms_image_rights: true,
      },
    });
    // Never retain the original reference bytes after the API has received them.
    state.referenceImageFile = null;
    state.referenceImageAsset = payload?.media_asset ?? null;
    state.referenceRightsReview = payload?.content_rights_review ?? null;
    if (referenceImageUsable()) {
      state.route = "image-scene";
      setToast("参考立绘已由服务端审核通过，可创建受控情境图。");
    } else if (state.referenceRightsReview?.state === "REVIEW_REQUIRED") {
      state.route = "image-reference";
      setToast("IMS 内容审核已通过，但参考图仍在独立权利审核中；不会创建生图任务。");
    } else {
      setToast(`参考立绘不可用：${state.referenceImageAsset?.state ?? "服务端未确认"}。未创建生图任务。`);
    }
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

function referenceImageUsable() {
  return state.referenceImageAsset?.state === "AVAILABLE"
    && state.referenceImageAsset?.confirmation_state === "USER_CONFIRMED"
    && state.referenceRightsReview?.state === "APPROVED";
}

async function refreshReferenceRightsReview() {
  const reviewId = state.referenceImageAsset?.rights_review_id ?? state.referenceRightsReview?.review_id;
  if (!reviewId) return;
  setBusy(true);
  try {
    const payload = await api(`/content-rights-reviews/${encodeURIComponent(reviewId)}`);
    state.referenceRightsReview = payload?.content_rights_review ?? null;
    if (state.referenceRightsReview?.state === "APPROVED") {
      await restoreReferenceImage();
      if (referenceImageUsable()) {
        state.route = "image-scene";
        setToast("参考立绘已通过独立权利审核，可创建受控情境图。");
      } else {
        setToast("权利审核已通过，正在等待服务端激活参考资产。");
      }
    } else {
      setToast(`当前权利审核状态：${state.referenceRightsReview?.state ?? "未返回"}。`);
    }
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function appealReferenceRightsReview() {
  const reviewId = state.referenceImageAsset?.rights_review_id ?? state.referenceRightsReview?.review_id;
  if (!reviewId) return;
  const statement = window.prompt("说明你拥有或已获授权使用该参考图（最多 1000 字）：");
  if (!statement?.trim()) return;
  setBusy(true);
  try {
    await api(`/content-rights-reviews/${encodeURIComponent(reviewId)}/appeals`, {
      method: "POST", idempotent: uuid(), body: { statement: statement.trim() },
    });
    setToast("权利审核申诉已提交；参考图会继续保持私有隔离，直到独立审核结论生效。");
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function submitImageScene(form) {
  const referenceAssetId = state.referenceImageAsset?.asset_id;
  if (!referenceAssetId || !characterId()) return;
  const location = form.elements.scene_location.value.trim();
  const outfit = form.elements.scene_outfit.value.trim();
  const timeOfDay = form.elements.scene_time_of_day.value;
  if (!location || !outfit || !timeOfDay) return;
  setBusy(true);
  try {
    const payload = await api(`/characters/${encodeURIComponent(characterId())}/image-jobs`, {
      method: "POST", idempotent: uuid(), body: {
        reference_asset_id: referenceAssetId,
        scene: { location, outfit, time_of_day: timeOfDay, confirmed_event_asset_ids: [] },
        resolution: "768:1024",
      },
    });
    state.imageJob = payload?.image_job ?? null;
    if (state.imageJob?.state === "PENDING") setToast("图片任务已提交，后台会自动完成审核与入库；可点“刷新状态”提前查看进度。");
    else setToast(`图片任务未进入队列：${state.imageJob?.failure_code ?? "服务端未确认"}。`);
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function refreshImageJob() {
  const jobId = state.imageJob?.job_id;
  if (!jobId) return;
  setBusy(true);
  try {
    const payload = await api(`/image-jobs/${encodeURIComponent(jobId)}/refresh`, { method: "POST", idempotent: uuid(), body: {} });
    state.imageJob = payload?.image_job ?? state.imageJob;
    if (state.imageJob?.state === "COMPLETED" && state.imageJob.result_asset_id) {
      clearGeneratedImage();
      state.generatedImage = { assetId: state.imageJob.result_asset_id, url: await apiImage(`/media-assets/${encodeURIComponent(state.imageJob.result_asset_id)}/content`) };
      setToast("情境图已通过服务端审核，可在当前浏览器会话中查看。它仍保留在私有 COS。 ");
    } else if (["FAILED", "BLOCKED"].includes(state.imageJob?.state)) {
      setToast(`图片未提供：${state.imageJob.failure_code ?? "服务端未返回失败码"}。`);
    } else {
      setToast(`当前任务状态：${state.imageJob?.state ?? "未返回"}。`);
    }
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

function clearGeneratedImage() {
  if (state.generatedImage?.url) URL.revokeObjectURL(state.generatedImage.url);
  state.generatedImage = null;
}

async function deleteGeneratedImage() {
  const assetId = state.generatedImage?.assetId;
  if (!assetId || !window.confirm("删除这张 AI 情境图？这会立即从在线视图撤销，并请求删除私有对象。")) return;
  setBusy(true);
  try {
    const payload = await api(`/media-assets/${encodeURIComponent(assetId)}`, { method: "DELETE", idempotent: uuid() });
    clearGeneratedImage();
    setToast(payload?.deletion_job?.physical_cleanup_state === "COS_PRIVATE_OBJECT_DELETED" ? "情境图私有对象已删除。" : "情境图已从在线视图撤销；请以删除任务状态为准。");
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function downloadRelationshipProfile() {
  setBusy(true);
  try {
    const payload = await api("/data-exports/relationship-profile");
    const exported = payload?.export;
    if (!exported?.format) throw apiError("服务端未返回有效导出文件。", 502);
    const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `qiyu-relationship-profile-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setToast("关系档案已由当前账户服务端数据生成下载。媒体文件不包含在此 JSON 中。");
  } catch (error) { setToast(serverMessage(error)); } finally { setBusy(false); }
}

async function setRawInteractionRetention(days) {
  setBusy(true);
  try {
    const payload = await api("/privacy/raw-interaction-retention", { method: "POST", idempotent: uuid(), body: { retention_days: days } });
    state.rawInteractionRetentionDays = payload?.raw_interaction_retention_days ?? days;
    setToast(`原始互动保留期已设为 ${days} 天；已确认关系资产不受影响。`);
  } catch (error) { setToast(serverMessage(error)); } finally { setBusy(false); }
}

async function openDataCenter() {
  setBusy(true);
  try {
    const payload = await api("/privacy/raw-interaction-retention");
    state.rawInteractionRetentionDays = payload?.raw_interaction_retention_days ?? null;
    state.route = "data";
  } catch (error) { setToast(serverMessage(error)); } finally { setBusy(false); }
}

async function openSubscription() {
  setBusy(true);
  try {
    const [catalog, current, entitlements] = await Promise.all([
      api("/subscription/catalog"),
      api("/subscriptions/current"),
      api("/entitlements"),
    ]);
    if (!Array.isArray(catalog?.catalog?.plans)) throw apiError("服务端未返回有效订阅目录。", 502);
    state.subscriptionCatalog = catalog.catalog;
    state.currentSubscription = current?.subscription ?? null;
    state.trial = current?.trial ?? null;
    state.entitlements = entitlements?.entitlements ?? [];
    state.route = "subscription";
  } catch (error) { setToast(serverMessage(error)); } finally { setBusy(false); }
}

async function purchasePlan(sku, autoRenew) {
  setBusy(true);
  try {
    const checkout = await api("/checkout-sessions", { method: "POST", idempotent: uuid(), body: { sku, auto_renew: autoRenew } });
    const payment = checkout?.development_payment;
    if (!payment?.callback_path) throw apiError("服务端未返回开发支付凭据。", 502);
    // 开发模拟渠道：执行服务端预签名的回调（密钥不出服务端；真实渠道未接入）。
    const callback = await fetch(payment.callback_path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Qiyu-Payment-Signature": payment.signature },
      body: JSON.stringify(payment.callback_body),
    });
    const callbackBody = await callback.json().catch(() => ({}));
    if (!callback.ok || callbackBody?.outcome !== "APPLIED") throw apiError(`支付模拟未生效：${callbackBody?.outcome ?? callback.status}`, callback.status, callbackBody);
    await openSubscription();
    setToast("订阅已生效（开发模拟渠道）；权益已按周期入账。");
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function startTrial() {
  setBusy(true);
  try {
    const result = await api('/subscription-trials', { method: 'POST', idempotent: uuid() });
    state.currentSubscription = result?.subscription ?? null;
    state.trial = result?.subscription ?? null;
    await openSubscription();
    setToast('7 天完整体验已开始；不会自动扣费。');
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function cancelRenewal() {
  const subscriptionId = state.currentSubscription?.subscription_id;
  if (!subscriptionId) return;
  if (!window.confirm("关闭自动续费？当期权益保留至周期结束，到期后数据权利不受影响。")) return;
  setBusy(true);
  try {
    await api(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel-renewal`, { method: "POST", idempotent: uuid() });
    await openSubscription();
    setToast("已关闭自动续费。");
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

// ---- 安全中心：联系人、举报/投诉、注销（原型组 03/09/10）----
async function openSafetyCenter() {
  setBusy(true);
  try {
    const payload = await api("/emergency-contact");
    state.emergencyContact = payload?.emergency_contact ?? null;
    state.route = "safety";
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function saveEmergencyContact(form) {
  setBusy(true);
  try {
    const payload = await api("/emergency-contact", {
      method: "PUT", idempotent: uuid(),
      body: {
        consent_independent_purpose: form.elements.contact_consent.checked,
        contact_name: form.elements.contact_name.value.trim(),
        relationship: form.elements.contact_relationship.value.trim(),
        phone: form.elements.contact_phone.value.trim(),
      },
    });
    state.emergencyContact = payload?.emergency_contact ?? null;
    setToast("紧急联系人已保存；仅用于法规与生命/重大财产安全响应。");
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function removeEmergencyContact() {
  if (!window.confirm("删除紧急联系人？法定安全案件进行中的留存按适用法律处理。")) return;
  setBusy(true);
  try {
    const payload = await api("/emergency-contact", { method: "DELETE", idempotent: uuid() });
    state.emergencyContact = payload?.emergency_contact ?? null;
    setToast("紧急联系人已删除。");
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function submitComplaint(form) {
  const kind = form.elements.complaint_kind.value;
  const description = form.elements.complaint_description.value.trim();
  const target = form.elements.complaint_target?.value.trim() || null;
  if (!description) return;
  if (kind === "REPORT_CONTENT" && !target) { setToast("举报内容必须填写目标消息或资源 ID。"); return; }
  setBusy(true);
  try {
    const payload = await api("/complaints", {
      method: "POST", idempotent: uuid(),
      body: { kind, description, target_resource_id: target },
    });
    state.lastComplaintId = payload?.complaint?.complaint_id ?? null;
    form.elements.complaint_description.value = "";
    if (form.elements.complaint_target) form.elements.complaint_target.value = "";
    setToast(`已提交（编号 ${state.lastComplaintId}）。处理进度可在安全中心查询；默认不附带完整私聊。`);
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function refreshLastComplaint() {
  if (!state.lastComplaintId) return;
  setBusy(true);
  try {
    const payload = await api(`/complaints/${encodeURIComponent(state.lastComplaintId)}`);
    const complaint = payload?.complaint;
    if (!complaint) throw apiError("服务端未返回投诉状态。", 502);
    setToast(`处理状态：${complaint.state}${complaint.resolution_note ? `；${complaint.resolution_note}` : ""}。`);
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function reportLatestAssistantMessage() {
  const message = [...state.messages].reverse().find((item) => (item.actor ?? item.role) === "ASSISTANT");
  if (!message || !messageId(message)) { setToast("还没有可以反馈的回复。"); return; }
  const type = window.prompt("反馈类型：OOC、MEMORY_ERROR、IMAGE_FACE_MISMATCH、IMAGE_WARDROBE_ERROR、IMAGE_SCENE_CONFLICT、UNSAFE_OR_UNCOMFORTABLE", "OOC");
  const severity = window.prompt("严重度：LOW、MEDIUM 或 HIGH", "LOW");
  const note = window.prompt("请简要说明问题（1-500 字）：");
  if (!type || !severity || !note?.trim()) return;
  setBusy(true);
  try {
    await api(`/messages/${encodeURIComponent(messageId(message))}/feedback`, {
      method: "POST", idempotent: uuid(), body: { type: type.trim(), severity: severity.trim(), note: note.trim() },
    });
    setToast("反馈已记录到该回复的版本快照；不会自动改写关系记忆或当前情境。");
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function submitTrialFeedback(form) {
  const category = form.elements.category.value;
  const rating = Number(form.elements.rating.value);
  const note = form.elements.note.value.trim();
  setBusy(true);
  try {
    const payload = await api("/trial-feedback", { method: "POST", idempotent: uuid(), body: { category, rating, note } });
    state.trialFeedback.unshift(payload.feedback);
    form.reset();
    setToast("试用反馈已记录。它不会自动改写角色人格、记忆或安全状态。");
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function deleteAccount() {
  const confirmed = window.prompt("账户注销不可撤销。输入“注销”以二次确认：");
  if (confirmed !== "注销") return;
  setBusy(true);
  try {
    const payload = await api("/account-deletions", { method: "POST", idempotent: uuid(), body: { confirm_text: "注销" } });
    state.deletionJob = payload?.deletion_job ?? null;
    state.messages = [];
    state.candidates = [];
    state.assets = [];
    state.timeline = [];
    state.conversation = null;
    state.character = null;
    state.route = "notices";
    await refreshNotices();
    setToast("注销已确认：互动与召回立即停止。生产数据 24 小时内清理、备份最长 30 天。");
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

// ---- 主动消息：偏好开关、静默时段、事件与规则引擎触发 ----
async function openProactive() {
  setBusy(true);
  try {
    const [preferences, events, messages] = await Promise.all([
      api("/proactive-preferences"),
      api("/proactive-events"),
      api("/proactive-messages"),
    ]);
    state.proactivePreferences = preferences?.preferences ?? null;
    state.proactiveEvents = unwrap(events, "events", "events") ?? [];
    state.proactiveMessages = unwrap(messages, "messages", "messages") ?? [];
    state.route = "proactive";
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

// 六项能力 A3 计划页：草案可编辑可接受（接受≠自动开提醒）；进行中可暂停/
// 恢复/完成/取消。404 = COMPANION_PLANS 未开启，如实提示不伪装空列表。
async function openPlans() {
  setBusy(true);
  try {
    const payload = await api("/companion-plans");
    state.plans = unwrap(payload, "plans", "plans") ?? [];
    state.route = "plans";
  } catch (error) {
    if (error?.status === 404) setToast("计划能力未开启（开发开关 COMPANION_PLANS）。");
    else setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function refreshPlans() {
  try {
    const payload = await api("/companion-plans");
    state.plans = unwrap(payload, "plans", "plans") ?? [];
  } catch { /* 计划页之外不主动报错 */ }
}

function renderPlans() {
  const plans = state.plans ?? [];
  const list = plans.length > 0
    ? plans.map((plan) => planPageCard(plan, { busy: state.busy })).join("")
    : '<section class="card"><p class="muted">还没有计划。在时间线的事件卡上点「一起准备」，或在聊天里让 TA 提议一份。</p></section>';
  return apricotSettingsPage("陪伴计划", list, { night: state.theme === "night", nav: prototypeNav("plans") });
}

async function saveProactivePreferences(form) {
  setBusy(true);
  try {
    const payload = await api("/proactive-preferences", {
      method: "PUT", idempotent: uuid(),
      body: {
        enabled: form.elements.proactive_enabled.checked,
        quiet_start_hour: Number(form.elements.quiet_start.value),
        quiet_end_hour: Number(form.elements.quiet_end.value),
      },
    });
    state.proactivePreferences = payload?.preferences ?? state.proactivePreferences;
    setToast(state.proactivePreferences.enabled ? "普通主动消息已开启（仍受每日1条与静默时段限制）。" : "已关闭全部普通主动互动；安全与服务通知不受影响。");
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function createProactiveEvent(form) {
  setBusy(true);
  try {
    await api("/proactive-events", {
      method: "POST", idempotent: uuid(),
      body: {
        type: form.elements.event_type.value,
        title: form.elements.event_title.value.trim(),
        due_at: form.elements.event_due_at?.value ? new Date(form.elements.event_due_at.value).toISOString() : undefined,
      },
    });
    form.elements.event_title.value = "";
    await openProactive();
    setToast("事件已创建；只有规则引擎允许时才会发送。");
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function deleteProactiveEvent(eventId) {
  setBusy(true);
  try {
    await api(`/proactive-events/${encodeURIComponent(eventId)}`, { method: "DELETE", idempotent: uuid() });
    await openProactive();
    setToast("事件已删除；未发送的任务已取消。");
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function triggerProactiveEvent(eventId) {
  setBusy(true);
  try {
    const payload = await api(`/proactive-events/${encodeURIComponent(eventId)}/trigger`, { method: "POST", idempotent: uuid(), body: {} });
    await openProactive();
    setToast(payload?.dispatched
      ? `规则引擎放行：「${payload.message.text.slice(0, 30)}…」`
      : `规则引擎拒绝：${payload?.reason ?? "未知原因"}（付费不能突破该限制）`);
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

function renderProactive() {
  const preferences = state.proactivePreferences ?? { enabled: true, quiet_start_hour: 23, quiet_end_hour: 8 };
  const hourOptions = (selected) => Array.from({ length: 24 }, (_, hour) => `<option value="${hour}" ${hour === selected ? "selected" : ""}>${String(hour).padStart(2, "0")}:00</option>`).join("");
  const eventCards = (state.proactiveEvents ?? []).map((event) => `<article class="asset"><div><b>${escapeHtml(event.title)}</b><small>${PROACTIVE_EVENT_TYPE_LABELS[event.type] ?? escapeHtml(event.type)}${event.due_at ? " · " + escapeHtml(new Date(event.due_at).toLocaleDateString()) : ""}</small></div><div class="button-row"><button class="btn btn-line" data-action="trigger-proactive" data-event-id="${escapeHtml(event.event_id)}" ${state.busy ? "disabled" : ""}>模拟触发</button><button class="btn btn-danger" data-action="delete-proactive" data-event-id="${escapeHtml(event.event_id)}" ${state.busy ? "disabled" : ""}>删除</button></div></article>`).join("");
  const messageCards = (state.proactiveMessages ?? []).map((message) => `<article class="asset"><div><b>${escapeHtml(message.kind === "SYSTEM" ? "系统通知" : "角色主动消息")}</b><small>${escapeHtml(new Date(message.sent_at).toLocaleString())}</small><p class="muted">${escapeHtml(message.text)}</p></div></article>`).join("");
  return apricotSettingsPage("主动消息与静默时间", `
  <form id="proactive-preferences-form" class="settings-panel stack"><h2>偏好</h2><label class="check-row"><input name="proactive_enabled" type="checkbox" ${preferences.enabled ? "checked" : ""}><span>允许普通主动消息（早安/晚安、纪念日、约定）</span></label><div class="button-row"><label class="field"><span>静默开始</span><select name="quiet_start">${hourOptions(preferences.quiet_start_hour)}</select></label><label class="field"><span>静默结束</span><select name="quiet_end">${hourOptions(preferences.quiet_end_hour)}</select></label></div><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>保存偏好</button></form>
  <form id="proactive-event-form" class="settings-panel stack"><h2>新建事件</h2><label class="field"><span>类型</span><select name="event_type"><option value="SUBSCRIBED_MORNING">早安订阅</option><option value="SUBSCRIBED_EVENING">晚安订阅</option><option value="CONFIRMED_ANNIVERSARY">纪念日</option><option value="CONFIRMED_BIRTHDAY">生日</option><option value="CONFIRMED_APPOINTMENT">约定</option></select></label><label class="field"><span>标题</span><input name="event_title" maxlength="80" required placeholder="例如：在一起一百天"></label><label class="field"><span>日期（纪念日/生日可选）</span><input name="event_due_at" type="date"></label><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>创建事件</button></form>
  <section class="settings-group"><h2>我的事件</h2>${eventCards || '<div class="empty-state">暂无主动事件。</div>'}</section>
  <section class="settings-group"><h2>已发送记录</h2>${messageCards || '<div class="empty-state">还没有已发送的主动消息。</div>'}<p class="muted">生活事件到期的跟进提醒会直接写进对话消息流（带「主动」角标）；此处只是审计记录与频控统计来源，不是第二个收件箱。</p></section>`, { night: state.theme === "night" });
}

// ---- 连续使用心跳（SAFE-03）：服务端计算时长，客户端只上报与展示 ----
function startHeartbeat() {
  if (state.heartbeatTimer) return;
  state.heartbeatTimer = window.setInterval(async () => {
    if (state.booting || state.error || document.hidden) return;
    try {
      const payload = await api("/interaction-activity/heartbeat", { method: "POST", idempotent: uuid(), body: {} });
      if (payload?.reminder) { state.continuousReminder = payload.reminder; render(); }
    } catch { /* 心跳失败不打断界面；时长以服务端为准。 */ }
  }, 30_000);
}

async function deleteCurrentConversation() {
  const id = conversationId();
  if (!id || !window.confirm("删除这段对话及其派生候选/关系资产？此操作会立即从在线视图撤销。")) return;
  setBusy(true);
  try {
    const payload = await api(`/conversations/${encodeURIComponent(id)}`, { method: "DELETE", idempotent: uuid() });
    state.deletionJob = payload?.deletion_job ?? null;
    state.messages = [];
    state.candidates = [];
    state.assets = [];
    state.conversation = null;
    for (const audio of state.audioUrls.values()) URL.revokeObjectURL(audio.url);
    state.audioUrls.clear();
    clearGeneratedImage();
    clearGeneratedImage();
    state.route = "character";
    setToast("会话已从在线视图撤销；本地开发删除状态以服务端删除任务为准。");
  } catch (error) { setToast(serverMessage(error)); } finally { setBusy(false); }
}

const ASR_ACCEPTED_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/aac", "audio/ogg"]);
const ASR_MAX_BYTES = 2 * 1024 * 1024;

function asrInputType(file) {
  if (!file) return null;
  if (ASR_ACCEPTED_TYPES.has(file.type)) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  return ({ mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg" })[extension] ?? null;
}

function setAsrFile(file) {
  const mimeType = asrInputType(file);
  if (!file || !mimeType || file.size === 0 || file.size > ASR_MAX_BYTES) {
    state.asrFile = null;
    setToast("请选择 WAV、MP3、M4A、AAC 或 OGG 格式且不超过 2MB 的短音频。");
    return;
  }
  state.asrJob = null;
  state.asrEdit = "";
  state.asrFile = { file, mimeType };
  render();
}

async function base64Audio(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function createAsrJob() {
  if (!state.asrFile) return;
  setBusy(true);
  try {
    await ensureConversation();
    const { file, mimeType } = state.asrFile;
    const payload = await api(`/conversations/${encodeURIComponent(conversationId())}/asr-jobs`, {
      method: "POST", idempotent: uuid(), body: { mime_type: mimeType, audio_base64: await base64Audio(file) },
    });
    // Clear browser-held raw audio as soon as the server has accepted the task.
    state.asrFile = null;
    state.asrJob = payload?.asr_job ?? payload;
    if (state.asrJob?.state === "COMPLETED" && state.asrJob?.transcript?.state === "PENDING_CONFIRMATION") {
      // 产品口径（2026-09-13）：跳过"检查转写后再发送"面板，自动调用确认接口
      //（服务端随即删除原始音频），转写文字直接落到发送框。
      state.asrEdit = state.asrJob.transcript.text;
      await confirmAsrTranscript();
    }
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function confirmAsrTranscript() {
  const jobId = state.asrJob?.job_id;
  const text = state.asrEdit.trim();
  if (!jobId || !text) return;
  setBusy(true);
  try {
    const payload = await api(`/asr-jobs/${encodeURIComponent(jobId)}/confirm`, {
      method: "POST", idempotent: uuid(), body: { text },
    });
    state.asrJob = payload?.asr_job ?? state.asrJob;
    state.pendingTranscript = state.asrJob?.transcript?.text ?? text;
    // 转写落到文字输入框、自动回到文字模式即完成；确认 toast 是噪声
    //（2026-09-14 用户反馈删除），原始音频删除进度在「我的」页可见。
    state.composerVoice = false;
    state.route = "chat";
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function deleteFailedAsrInput() {
  const assetId = state.asrJob?.input_asset_id;
  if (!assetId) return;
  setBusy(true);
  try {
    const payload = await api(`/media-assets/${encodeURIComponent(assetId)}`, { method: "DELETE", idempotent: uuid() });
    state.asrJob = null;
    state.route = "chat";
    setToast(payload?.deletion_job?.physical_cleanup_state === "LOCAL_PRIVATE_OBJECT_DELETED" ? "原始音频已删除。" : "已请求删除原始音频，请以服务端删除任务为准。");
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

function recordingMimeType() {
  return selectRecordingMimeType();
}

async function startAsrRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setToast("当前浏览器不支持录音；请导入 WAV、MP3、M4A、AAC 或 OGG 文件。");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = recordingMimeType();
    const startedAt = Date.now();
    const timeout = setTimeout(() => stopAsrRecording(false, true), MAX_RECORDING_MS);
    // 两条录音路径共用收尾：取消→提示；太短→提示；否则转 16k WAV 上传转写。
    const finish = async (wavPromise) => {
      clearTimeout(timeout);
      stream.getTracks().forEach((track) => track.stop());
      state.asrRecording = null;
      const hold = state.asrHold;
      state.asrHold = null;
      const durationMs = Date.now() - startedAt;
      try {
        if (hold?.cancelled) { render(); setToast("已取消录音，浏览器未上传原始音频。"); return; }
        const wav = await wavPromise;
        if (durationMs < MIN_HOLD_MS) { render(); setToast("录音太短或为空，请按住后再说话。"); return; }
        setAsrFile(new File([wav], `qiyu-${Date.now()}.wav`, { type: "audio/wav" }));
        await createAsrJob();
      } catch (error) {
        render();
        setToast(error?.message === "AUDIO_TOO_LONG" ? "录音超过 60 秒，未上传。"
          : error?.message === "AUDIO_EMPTY" ? "录音太短或为空，请按住后再说话。"
          : "无法解码这段录音，请重试或导入音频。");
      }
    };
    if (mimeType) {
      const chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType });
      recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
      recorder.addEventListener("stop", () => { finish(recordingBlobToWav(new Blob(chunks, { type: mimeType }))); }, { once: true });
      state.asrRecording = recorder;
      recorder.start(250);
    } else {
      // 微信 XWEB 等内核没有可用的 MediaRecorder 编码器（isTypeSupported 全
      // false）：AudioContext 直采 PCM 自封 WAV，不再让用户卡在「不支持录音」。
      const pcm = await createPcmWavRecorder(stream);
      state.asrRecording = {
        state: "recording",
        stop() { finish(pcm.stop()).catch(() => { /* finish 内部已兜底 toast */ }); },
      };
    }
    if (state.asrHold?.released) queueMicrotask(() => stopAsrRecording(state.asrHold?.cancelled));
    render();
  } catch {
    state.asrHold = null;
    setToast("浏览器未授予麦克风权限；你也可以导入一段短音频。");
  }
}

function stopAsrRecording(cancelled = false, timedOut = false) {
  if (state.asrHold) state.asrHold.cancelled = cancelled;
  if (state.asrRecording?.state === "recording") state.asrRecording.stop();
  if (timedOut) setToast("已达到 60 秒上限，正在转写。");
}

async function resolveCandidate(kind) {
  const candidate = state.selectedCandidate;
  if (!candidate) return;
  const id = candidateId(candidate);
  const expectedVersion = candidateVersion(candidate);
  const editedText = state.confirmEdit.trim();
  let path = `/memory-candidates/${encodeURIComponent(id)}/reject`;
  let body = undefined;
  if (kind === "confirm") path = `/memory-candidates/${encodeURIComponent(id)}/confirm`;
  if (kind === "confirm") body = { expected_version: expectedVersion };
  if (kind === "confirm-edited") {
    path = `/memory-candidates/${encodeURIComponent(id)}/confirm-edited`;
    // 生活事件：提交完整受控字段集（不允许只改展示文本留旧时间）。
    body = candidate.type === "life_event"
      ? { expected_version: expectedVersion, life_event: collectLifeEventCandidateFields() }
      : { expected_version: expectedVersion, display_text: editedText };
  }
  setBusy(true);
  try {
    const payload = await api(path, body === undefined ? { method: "POST", idempotent: uuid() } : { method: "POST", idempotent: uuid(), body });
    if (kind === "reject") {
      state.lastRejectedCandidate = { id, version: payload.candidate.version, undoUntil: payload.undo_until };
      window.clearTimeout(resolveCandidate.undoTimer);
      resolveCandidate.undoTimer = window.setTimeout(() => { state.lastRejectedCandidate = null; render(); }, 30_000);
    }
    state.selectedCandidate = null;
    state.confirmEdit = "";
    state.eventDraft = null;
    await refreshMemoryAndAssets();
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function deleteAsset(asset) {
  if (!asset) return;
  setBusy(true);
  try {
    const payload = await api(`/relationship-assets/${encodeURIComponent(assetId(asset))}`, { method: "DELETE", idempotent: uuid() });
    state.deletionJob = payload?.deletion_job ?? payload?.job ?? null;
    // Do not remove locally based on animation: refresh the server's query result.
    await refreshMemoryAndAssets();
    state.route = "assets";
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function refreshDeletionJob() {
  const id = state.deletionJob?.deletion_job_id ?? state.deletionJob?.id;
  if (!id) return;
  setBusy(true);
  try {
    const payload = await api(`/deletion-jobs/${encodeURIComponent(id)}`);
    state.deletionJob = payload?.deletion_job ?? payload?.job ?? payload;
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

// 服务端枚举不裸露给用户：统一中文口径（未知值原样回退，失败码等诊断信息保留）。
const AGE_STATUS_LABELS = { AGE_PASS: "已通过", AGE_REVIEW: "复核中", AGE_DENIED_MINOR: "未通过", AGE_UNVERIFIED: "未声明" };
const AGE_REASON_LABELS = { DECLARATION_INVALID: "声明无效", SELF_REPORTED_MINOR: "疑似未成年", DATE_OF_BIRTH_CHANGED: "出生日期变更" };
const FILTER_GROUP_LABELS = { all: "全部", memory: "记忆", commitment: "约定", boundary: "边界", event: "事件" };
const IMAGE_STATE_LABELS = { AVAILABLE: "可用", PENDING_MODERATION: "审核中", BLOCKED: "未通过审核", FAILED: "失败", DELETED: "已删除" };
const DELETION_STATE_LABELS = { PENDING: "处理中", RUNNING: "进行中", COMPLETED: "已完成", FAILED: "失败" };
const FEEDBACK_CATEGORY_LABELS = { ONBOARDING: "引导与注册", PERSONA: "角色人格", MEMORY: "记忆连续性", SAFETY: "安全与边界", USABILITY: "易用性", OTHER: "其他" };
const PROACTIVE_EVENT_TYPE_LABELS = { SUBSCRIBED_MORNING: "早安订阅", SUBSCRIBED_EVENING: "晚安订阅", CONFIRMED_ANNIVERSARY: "纪念日", CONFIRMED_BIRTHDAY: "生日", CONFIRMED_APPOINTMENT: "约定" };
// 1:1 通话枚举中文映射（服务端枚举原样透传，未知值回退原文展示）。
const CALL_END_REASON_LABELS = { USER_HANGUP: "你挂断了通话", IDLE_TIMEOUT: "长时间没有说话，通话已自动结束", DURATION_CAP: "通话达到了时长上限", ERROR: "通话因异常结束" };
const TURN_FAILURE_LABELS = {
  CALL_AUDIO_MISSING: "回合音频已失效，请重新说一次",
  ASR_TRANSCRIPTION_FAILED: "没有听清，请再说一次",
  DAILY_CHAT_LIMIT_REACHED: "今日对话额度已用完",
  ENTITLEMENT_QUOTA_EXCEEDED: "语音额度不足，可在订阅方案中了解详情",
  CALL_TURN_ABORTED: "本回合已打断",
  CALL_ENDED: "通话已结束"
};

function noticeCard(notice) {
  const id = String(notice.notice_id);
  const checked = state.noticeChecks.has(id) ? "checked" : "";
  const displayed = notice.state === "DISPLAYED";
  return `<article class="notice-item"><div class="item-row"><b>${escapeHtml(notice.type ?? "系统必要告知")}</b>${displayed ? '<span class="notice-status">服务端已记录</span>' : ""}</div><p>这是由 API 下发的必要系统告知。角色不能替代或覆盖此说明。</p><small>版本：${escapeHtml(notice.notice_version ?? "未返回")}</small>${displayed ? "" : `<label class="check-row"><input type="checkbox" data-notice-check="${escapeHtml(id)}" ${checked}><span>我已阅读并理解此系统告知。</span></label>`}</article>`;
}

function renderNotices() {
  const pending = pendingNotices();
  const allChecked = pending.length > 0 && pending.every((notice) => state.noticeChecks.has(String(notice.notice_id)));
  const facts = [
    ["spark", "你正在与 AI 互动", "角色的文字、语音与图片均由人工智能生成并标识。"],
    ["shield", "仅面向 18 岁以上用户", "年龄风险较高时，会进入增强核验；未成年人不可使用虚拟伴侣服务。"],
    ["archive", "关系资产由你确认", "候选记忆不会自动成为长期事实，你可以查看、修改或删除。"]
  ].map(([icon, title, copy]) => `<article class="fact"><span class="fact-icon">${prototypeIcon(icon)}</span><div><strong>${title}</strong><small>${copy}</small></div></article>`).join("");
  const noticeChecks = pending.map((notice) => {
    const id = String(notice.notice_id);
    return `<label class="check-row"><input type="checkbox" data-notice-check="${escapeHtml(id)}" ${state.noticeChecks.has(id) ? "checked" : ""}><span>我已阅读并理解系统告知。</span></label>`;
  }).join("");
  return prototypeShell(`<div class="content"><h1 id="app-title">先说清楚，<br>我们才能开始。</h1><p class="lead">栖语提供由 AI 生成的长期角色互动。它可以记住经你确认的关系资产，但不是现实中的人，也不能替代专业支持。</p><div class="fact-grid">${facts}</div><div class="check-list">${noticeChecks || '<div class="empty-state">服务端未返回必要告知，普通互动保持不可用。</div>'}</div></div><div class="bottom-action"><button class="btn btn-primary" data-action="submit-notices" ${allChecked && !state.busy ? "" : "disabled"}>同意并继续 ${prototypeIcon("arrow", 18)}</button><div class="note">此告知属于系统界面；只有 API 记录展示回执后才会解除门槛。</div></div>`, "01 / 03");
}

function renderAge() {
  const status = ageStatus();
  const reasons = state.age?.reason_codes ?? [];
  const reviewDetail = ({
    DECLARATION_INVALID: "上一次声明无效（日期不完整或未勾选确认），可直接重新填写提交。",
    SELF_REPORTED_MINOR: "对话中出现自报未成年的风险信号，已进入增强核验；复核前普通互动保持关闭。",
    DATE_OF_BIRTH_CHANGED: "出生日期修改触发过复核；现在可以直接修正后重新声明。",
  })[reasons[0]] ?? "等待服务端复核结论；复核前普通互动保持关闭。";
  const detail = status === "AGE_PASS" ? "账号已获得 18+ 服务访问资格。" : status === "AGE_REVIEW" ? reviewDetail : status === "AGE_DENIED_MINOR" ? "未成年人不可使用虚拟伴侣服务；数据权利不因此被阻断。" : "信息只提交给服务端进行确定性年龄判断。";
  const declareForm = `<form id="age-form"><label class="check-row"><input name="adult_confirmed" type="checkbox" required><span>我确认本人已满 18 周岁，并提交年龄声明供服务端判断。</span></label><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>提交年龄声明 ${prototypeIcon("arrow", 18)}</button></form>`;
  const appealButtons = '<div class="flow-actions"><button class="btn btn-line" data-action="request-age-appeal">提交年龄复核</button><button class="btn btn-line" data-action="reload-age">刷新服务端状态</button></div>';
  const form = status === "AGE_PASS"
    ? `<button class="btn btn-primary" data-action="continue-character">创建我的角色 ${prototypeIcon("arrow", 18)}</button>`
    : status === "AGE_REVIEW"
      ? `${declareForm}${appealButtons}`
      : status === "AGE_DENIED_MINOR"
        ? appealButtons
        : declareForm;
  const showBirthInput = ["AGE_UNVERIFIED", "AGE_REVIEW"].includes(status);
  return prototypeShell(`<div class="content"><h1 id="app-title">年龄保障</h1><p class="lead">先完成基础年龄判断。只有出现账号或行为风险信号时，才会请求更强的核验。</p><section class="verify-card"><h3>${status === "AGE_PASS" ? "核验已通过" : "基础信息"}</h3><p class="page-sub">${detail}</p>${showBirthInput ? `<label class="field"><span>出生日期</span><input form="age-form" name="birth_date" type="date" required></label>` : ""}<div class="status-row"><span class="status-dot ${status === "AGE_PASS" ? "pass" : ""}"></span>${AGE_STATUS_LABELS[status] ?? status} · ${escapeHtml(reasons.map((reason) => AGE_REASON_LABELS[reason]).filter(Boolean).join("、") || "等待服务端结果")}</div></section><div class="rights">${prototypeIcon("lock", 17)}<span>栖语不保存证件原图；增强年龄核验的供应商接入与结果以服务端状态为准。</span></div></div><div class="bottom-action">${form}<div class="note">浏览器不自行判定年龄结果，也不展示原型模拟的核验成功。</div></div>`, "02 / 03");
}

function personaFields(persona = {}) {
  const gender = ["male", "female"].includes(persona.gender) ? persona.gender : "unspecified";
  const genderOption = (value, label) => `<option value="${value}" ${gender === value ? "selected" : ""}>${label}</option>`;
  return `
    <label class="field"><span>性别（决定角色语音是男声还是女声）</span><select name="persona_gender">${genderOption("unspecified", "未设定（使用默认音色）")}${genderOption("female", "女性 · 女声")}${genderOption("male", "男性 · 男声")}</select></label>
    <label class="field"><span>世界观</span><textarea name="persona_worldview" maxlength="500" rows="2" placeholder="TA 生活在哪里、做什么">${escapeHtml(persona.worldview ?? "")}</textarea></label>
    <label class="field"><span>年龄设定</span><input name="persona_age_setting" maxlength="500" value="${escapeHtml(persona.age_setting ?? "")}" placeholder="例如：27"></label>
    <label class="field"><span>与我的关系</span><input name="persona_relationship" maxlength="500" value="${escapeHtml(persona.relationship_to_user ?? "")}" placeholder="例如：认识很久的老朋友"></label>
    <label class="field"><span>性格</span><input name="persona_personality" maxlength="500" value="${escapeHtml(persona.personality ?? "")}" placeholder="例如：安静温和、偶尔冷幽默"></label>
    <label class="field"><span>表达方式</span><input name="persona_expression" maxlength="500" value="${escapeHtml(persona.expression_style ?? "")}" placeholder="例如：短句为主，画面感的比喻"></label>
    <label class="field"><span>硬边界（每行一条，绝不做什么）</span><textarea name="persona_boundaries" rows="2" maxlength="2000" placeholder="例如：不复刻任何真人">${escapeHtml((persona.hard_boundaries ?? []).join("\n"))}</textarea></label>
    <label class="field"><span>示例行为（每行一条）</span><textarea name="persona_examples" rows="2" maxlength="2000" placeholder="例如：我难过时先承认情绪再给建议">${escapeHtml((persona.example_behaviors ?? []).join("\n"))}</textarea></label>`;
}

function renderCharacter() {
  const templateButtons = PERSONA_TEMPLATES.map((template) => `<button type="button" class="chip ${state.personaTemplateId === template.id ? "on" : ""}" data-template="${template.id}" aria-pressed="${state.personaTemplateId === template.id}" ${state.busy ? "disabled" : ""}>${escapeHtml(template.label)}</button>`).join("");
  return prototypeShell(`<form id="character-form"><div class="content"><h1 id="app-title">让 TA 有清楚的底色</h1><p class="lead">先从一个角色开始。人格设定会版本化保存，并经过行为回归测试减少升级后的陌生感。</p><div class="mode-switch"><button type="button" class="on">快速创建</button><button type="button" data-action="open-oc-import">导入原创 OC</button></div><button type="button" class="portrait-editor portrait-picker-entry" data-action="open-portrait-picker" aria-label="选择角色头像"><img src="${selectedPortrait().src}" alt="原创成年 AI 角色示意"><span class="aigc">AI 生成形象 · 点击更换</span></button><label class="field"><span>角色名字</span><input name="character_name" maxlength="80" required placeholder="例如：林默"></label><div class="field"><span>人格模板</span><div class="chips" role="group" aria-label="人格模板（单选）">${templateButtons}</div></div>${personaFields({})}<label class="check-row"><input name="rights_confirmed" type="checkbox" required><span>我确认角色设定为原创或已获授权，不复刻真人、明星或未授权 IP。</span></label><div class="rights">${prototypeIcon("shield", 17)}<span>人格、年龄、安全和关系记忆均由服务端分别治理；此表单不能覆盖系统安全边界。</span></div></div><div class="bottom-action"><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>创建并开始相处 ${prototypeIcon("arrow", 18)}</button><div class="note">参考图、音色和内容权益会经过相应的受控审核流程。</div></div></form>`, "03 / 03");
}

function renderOcImport() {
  const review = state.ocRightsReview;
  const reviewCard = review ? `<section class="card status-card ${review.state === "APPROVED" ? "pass" : "review"}"><b>OC 权利审核：${escapeHtml(review.state ?? "未返回")}</b><p class="muted">风险码仅用于审核路由，不构成侵权结论；应用不会自行批准。</p><div class="button-row"><button class="btn btn-line" data-action="refresh-oc-rights" ${state.busy ? "disabled" : ""}>刷新审核状态</button>${review.appeal_available ? `<button class="btn btn-line" data-action="appeal-oc-rights" ${state.busy ? "disabled" : ""}>提交申诉</button>` : ""}${review.state === "APPROVED" ? `<button class="btn btn-primary" data-action="create-from-oc-import" ${state.busy ? "disabled" : ""}>用已审核设定创建角色</button>` : ""}</div></section>` : "";
  return screen(`<div class="topline"><button type="button" class="icon-btn app-back" data-action="back-character" aria-label="返回创建角色"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button></div><h1 id="app-title">先隔离审核，<br>再写入角色。</h1><p class="lead">OC 原文只用于受控字段候选提取和权利审核，不会自动公开、训练模型或覆盖系统安全规则。</p>${reviewCard}<form id="oc-import-form" class="stack"><label class="field"><span>OC 设定</span><textarea name="oc_source_text" maxlength="8000" rows="10" required placeholder="可填写：世界观：…\n性格：…\n表达风格：…"></textarea><small class="muted">最多 8000 字。请勿粘贴真人、未获授权 IP 或其他人的私密内容。</small></label><label class="check-row"><input name="oc_rights_confirmed" type="checkbox" required><span>我确认上述内容为原创或已获授权，并理解提交后会先进入审核而非自动生效。</span></label><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>隔离提交并申请审核</button></form>`);
}


function selectedPortrait() {
  const key = characterId();
  if (!key) return portraitById(state.portraitDraft);
  if (!state.portraitSelections.has(key)) {
    let id = 'original';
    try { id = loadPortraitId(key, window.localStorage); } catch { /* Storage may be disabled. */ }
    state.portraitSelections.set(key, id);
  }
  return portraitById(state.portraitSelections.get(key));
}

function renderPortraitPicker() {
  const current = selectedPortrait();
  const groups = ['男性', '女性', '经典'].map((group) => `<section class="portrait-group"><h2>${group === '经典' ? '原有形象' : `${group}形象`}</h2><div class="portrait-options">${CHARACTER_PORTRAITS.filter((portrait) => portrait.group === group).map((portrait) => `<button type="button" class="portrait-option ${current.id === portrait.id ? 'selected' : ''}" data-action="choose-portrait" data-portrait-id="${portrait.id}" aria-pressed="${current.id === portrait.id}"><img src="${portrait.src}" alt="${portrait.group} · ${portrait.label}"><span>${portrait.label}</span>${current.id === portrait.id ? '<small>已选择</small>' : '<small>点击选择</small>'}</button>`).join('')}</div></section>`).join('');
  return `<section class="screen qiyu-prototype paper portrait-picker"><header class="app-header"><span class="header-spacer" aria-hidden="true"></span><button type="button" class="btn btn-line portrait-confirm" data-action="close-portrait-picker">确认</button></header><div class="page-content"><h1 id="app-title" class="page-title">选一个心动的模样</h1><p class="page-sub">AI 生成形象。夜间对话会以所选形象作为背景；选择保存在当前设备，不改变角色设定与音色。</p><div class="portrait-current"><img src="${current.src}" alt="当前形象：${current.label}"><span>当前 · ${current.label}</span></div>${groups}</div></section>`;
}

function renderCharacterProfile() {
  const character = state.character;
  if (!character) { state.route = "character"; return renderCharacter(); }
  return apricotPersonaEditor({ character, preferences: state.preferences, portrait: selectedPortrait().src, step: state.profileStep, draft: state.profileDraft ?? {}, busy: state.busy, night: state.theme === 'night' });
}

function messageMarkup(message, latestAssistantId = null) {
  // 通话记录卡片：服务端挂断时落的 provider='call-record' 消息，不是对话气泡，
  // 也没有 AI 生成标识（ai_generated=false）。
  if (message.provider === "call-record") {
    return `<article class="message call-record"><div class="call-record-card">${prototypeIcon("phone", 15)}<span>${escapeHtml(message.content ?? message.text ?? "")}</span></div></article>`;
  }
  // 计划卡片消息（六项能力 A3）：消息本体是受控摘要，卡片内容经
  // GET /artifacts/{id} 惰性水合——定点替换 [data-artifact-id] 节点，绝不
  // 整树重渲染（保输入法组合态与滚动位置）。
  if (message.provider === "companion-card") {
    return companionCardShell(message);
  }
  const actor = message.actor ?? message.role ?? "assistant";
  const isUser = actor === "user" || actor === "USER";
  const content = message.content ?? message.text ?? message.display_text ?? "";
  const id = messageId(message);
  let audio = !isUser && id ? state.audioUrls.get(id) : null;
  if (audio?.key && audio.key !== messageAudioKey(message)) {
    URL.revokeObjectURL(audio.url); state.audioUrls.delete(id); audio = null;
  }
  // 参考对话视觉：括号动作描写转斜体弱化；先转义再包裹，不引入用户可控 HTML。
  const bubbleHtml = ((isUser ? escapeHtml(content) : replyTextMarkup(content)) || "…").replace(/([（(][^（）()]*[）)])/g, '<em class="action">$1</em>');
  const synthesizing = !isUser && id && state.synthesizingMessageId === id;
  const voiceControl = !isUser && id ? `<button type="button" class="voice-trigger" data-action="${audio ? "toggle-message-audio" : "synthesize-message-audio"}" data-message-id="${escapeHtml(id)}" aria-label="${synthesizing ? "正在生成角色语音" : audio ? "播放角色语音" : "生成并播放角色语音"}" ${synthesizing ? 'data-synthesizing="true"' : state.busy ? "disabled" : ""}><span class="voice-trigger-visual"><img src="/assets/player-play-filled.svg" alt="" aria-hidden="true"></span></button>` : "";
  const voicePlayback = !isUser && audio ? `<audio class="voice-audio" preload="metadata" src="${escapeHtml(audio.url)}"></audio>` : "";
  const voiceRow = voiceControl ? `<span class="voice-control-row">${voiceControl}${voicePlayback}</span>` : "";
  const duration = formatVoiceDuration(audio?.duration);
  const attachments = (message.attachments ?? []).map((attachment) => {
    const url = state.imageUrls.get(attachment.asset_id);
    if (state.deletedImageIds.has(attachment.asset_id)) return `<div class="context-image-status">图片附件 · 已删除</div>`;
    return url ? `<div><img class="context-image-thumb" src="${escapeHtml(url)}" alt="用户上传并审核通过的聊天图片">${isUser ? `<button type="button" class="voice-delete" data-action="delete-context-image" data-asset-id="${escapeHtml(attachment.asset_id)}">删除图片</button>` : ""}</div>` : `<div class="context-image-status">图片附件 · 私密加载中</div>`;
  }).join("");
  const praiseButton = !isUser && id && id === latestAssistantId ? `<button type="button" class="praise-btn" data-action="praise-message" data-message-id="${escapeHtml(id)}" aria-label="这句回应很好，沉淀为行为模式" title="这句回应很好，沉淀为行为模式" ${state.busy ? "disabled" : ""}>${prototypeIcon("spark", 14)}</button>` : "";
  // 来源透明（六项能力 A1）：每条 AI 回复都可查「本轮参考了哪些记忆/事件」；
  // 点击才请求，无引用时服务端 404，如实提示。
  const refsButton = !isUser && id ? `<button type="button" class="memory-refs-trigger" data-action="open-memory-refs" data-message-id="${escapeHtml(id)}" ${state.busy ? "disabled" : ""}>本轮参考</button>` : "";
  // 主动跟进消息（六项能力 A2）：服务端 provider='proactive-followup'，角标
  // 标明这是角色主动发来的；来源入口仍由 memory_refs 事件引用自动出现。
  const proactiveBadge = message.provider === "proactive-followup" ? '<span class="aigc proactive-flag">主动</span>' : "";
  return `<article class="message ${isUser ? "me" : "ai"}" data-message-id="${escapeHtml(id ?? "")}"><div class="bubble">${attachments}${voiceRow}<span class="message-copy">${proactiveBadge}${bubbleHtml}</span>${!isUser ? `<span class="voice-duration">${duration}</span>` : ""}<span class="message-tools">${refsButton}${praiseButton}</span></div></article>`;
}

async function openWorldState() {
  setBusy(true);
  try { await refreshWorldState(); state.route = "world-state"; }
  catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function saveWorldState(form) {
  const current = state.worldState;
  if (!current) return;
  setBusy(true);
  try {
    const payload = await api(`/characters/${encodeURIComponent(characterId())}/world-state`, {
      method: "PATCH", idempotent: uuid(),
      body: { expected_version: current.state_version, mood_code: form.elements.world_mood.value, location_code: form.elements.world_location.value, expires_at: null },
    });
    state.worldState = payload?.world_state ?? current;
    setToast("当前情境已更新；人格、年龄、安全与确认记忆均未被修改。");
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

async function resetWorldState() {
  if (!characterId() || !window.confirm("重置当前短期情境？这不会删除人格、关系资产或历史记录。")) return;
  setBusy(true);
  try {
    const payload = await api(`/characters/${encodeURIComponent(characterId())}/world-state/reset`, { method: "POST", idempotent: uuid(), body: {} });
    state.worldState = payload?.world_state ?? null;
    setToast("当前情境已重置为默认值，历史变更仍由服务端保留。");
  } catch (error) { setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

function renderWorldState() {
  const world = state.worldState;
  if (!world) { state.route = "chat"; return renderChat(); }
  const moods = [["NEUTRAL", "平静中性"], ["CALM", "平静"], ["HAPPY", "愉快"], ["TIRED", "疲惫"], ["CONCERNED", "担忧"]];
  const locations = [["UNSPECIFIED", "未设定"], ["HOME", "家中"], ["CAFE", "咖啡馆"], ["PARK", "公园"], ["STUDIO", "工作室"], ["LIBRARY", "图书馆"], ["WORKPLACE", "工作场所"]];
  const options = (items, selected) => items.map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");
  const events = (world.active_event_refs ?? []).length ? (world.active_event_refs ?? []).map(escapeHtml).join("、") : "无";
  return screen(`<div class="topline"><button type="button" class="icon-btn app-back" data-action="back-chat" aria-label="返回"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button></div><h1 id="app-title">此刻的情境，<br>由你校正。</h1><section class="card"><b>当前版本 ${escapeHtml(world.state_version)}</b><p class="muted">仅包含短期情绪和地点；不会修改人格、安全结论、年龄状态或确认关系资产。</p><small>关联事件：${events}</small></section><form id="world-state-form" class="stack"><label class="field"><span>当前情绪</span><select name="world_mood">${options(moods, world.mood_code)}</select></label><label class="field"><span>当前地点</span><select name="world_location">${options(locations, world.location_code)}</select></label><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>保存当前情境</button></form><div class="flow-actions"><button class="btn btn-line" data-action="reset-world-state" ${state.busy ? "disabled" : ""}>重置短期情境</button><p class="muted">保存使用版本校验；其他位置更新后，服务端会拒绝旧版本覆盖。</p></div>`);
}

function renderHome() {
  return apricotHome({ name: state.character?.name ?? "当前角色", portrait: selectedPortrait().src, assets: state.assets, candidates: state.candidates, canCall: Boolean(realtimeCallAvailable() && characterId()), createdAt: state.character?.created_at, night: state.theme === "night", busy: state.busy, icon: prototypeIcon });
}
function renderProfile() { return apricotProfile({ name: state.character?.name ?? "当前角色", portrait: selectedPortrait().src, night: state.theme === "night", icon: prototypeIcon }); }
function renderChat() {
  const characterName = state.character?.name ?? "当前角色";
  const candidate = state.candidates.find((item) => ["CANDIDATE", "PENDING"].includes(item.state));
  const ttsFailure = state.lastTtsJob ? `<section class="rights" data-media-type="TTS" data-state="${escapeHtml(state.lastTtsJob.state)}">${prototypeIcon("shield", 17)}<span><b>角色语音未生成</b><br>${state.lastTtsJob.failure_code === "ENTITLEMENT_QUOTA_EXCEEDED" ? '需先领取 7 天完整体验，或当前语音额度已用完。' : `文字回复仍可正常阅读。失败码：${escapeHtml(state.lastTtsJob.failure_code ?? "未返回")}。`}${state.lastTtsJob.failure_code === "ENTITLEMENT_QUOTA_EXCEEDED" ? `<br><button class="btn btn-line" data-action="open-subscription">查看权益与领取试用</button>` : ""}</span></section>` : "";
  const memoryBanner = apricotCandidate(candidate, state.busy, prototypeIcon("bookmark", 21));
  const paused = state.userPaused ? `<button class="memory-banner" data-action="resume-interaction"><span>${prototypeIcon("shield", 18)}</span><span><b>普通互动已暂停</b><small>由你恢复前，不会继续生成角色回复</small></span></button>` : "";
  // 转写完成不再弹"检查转写后再发送"面板：确认由前端自动完成（并触发原始音频
  // 删除），文字直接回填发送框；只有失败时才保留错误面板供删除原音频。
  const asrPanel = state.asrJob?.state === "FAILED" ? `<div class="inline-media-panel error">转写失败：${escapeHtml(state.asrJob.failure_code ?? "UNKNOWN")}<button type="button" class="btn btn-line" data-action="delete-failed-asr-input">删除原音频</button></div>` : "";
  const imagePanel = state.contextImageAsset ? `<div class="inline-media-panel"><span>图片状态：${IMAGE_STATE_LABELS[state.contextImageAsset.state] ?? escapeHtml(state.contextImageAsset.state)}</span>${state.contextImagePreviewUrl ? `<img class="context-image-preview" src="${escapeHtml(state.contextImagePreviewUrl)}" alt="待发送图片">` : ""}<button type="button" class="btn btn-line" data-action="remove-context-image">删除图片</button></div>` : "";
  // 微信式语音输入：左侧麦克风/键盘切换；语音模式下整条输入框换成「按住 说话」
  // 胶囊（文字态由 CSS ::after 随 recording/cancel 类切换），按住时上方浮出
  // 录音指示卡，上滑进取消区变红。转写确认或图片上传成功后自动切回文字模式。
  const voiceMode = state.composerVoice;
  const recording = state.asrRecording?.state === "recording";
  const recordingIndicator = recording ? `<div class="recording-indicator" role="status"><div class="recording-box">${prototypeIcon("mic", 30)}<span class="recording-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span></div><div class="recording-hint"><span class="hint-slide">手指上滑，取消发送</span><span class="hint-cancel">松开手指，取消发送</span></div></div>` : "";
  const inputToggle = voiceMode
    ? `<button type="button" class="icon-btn" data-action="exit-voice-mode" aria-label="切换到键盘输入">${prototypeIcon("keyboard", 20)}</button>`
    : `<button type="button" class="icon-btn" data-action="enter-voice-mode" aria-label="切换到语音输入">${prototypeIcon("mic", 26)}</button>`;
  const inputArea = voiceMode
    ? `<button type="button" class="hold-pill" data-action="hold-asr" aria-label="按住说话，手指上滑取消"></button>`
    : `<textarea name="message" rows="1" maxlength="2000" autocomplete="off" placeholder="和${escapeHtml(characterName)}说点什么…" ${state.busy ? "disabled" : ""}>${escapeHtml(state.pendingTranscript)}</textarea>`;
  const sendButton = voiceMode ? "" : `<button class="icon-btn send" aria-label="发送" ${state.busy ? "disabled" : ""}>${prototypeIcon("send", 25)}</button>`;
  const latestAssistantId = messageId([...state.messages].reverse().find((item) => (item.actor ?? item.role) === "ASSISTANT") ?? {});
  return `<section class="screen qiyu-prototype app-screen apricot-chat ${state.theme === "night" ? "night" : "paper"}"><header class="app-header"><div class="identity"><button type="button" class="avatar-picker-trigger" data-action="open-portrait-picker" aria-label="更换角色头像">${apricotAvatar(selectedPortrait().src, characterName)}</button><div><b title="${escapeHtml(characterName)}">${escapeHtml(characterName)}</b></div></div><div class="header-actions">${realtimeCallAvailable() && characterId() ? `<button class="icon-btn soft" data-action="start-call" aria-label="发起语音通话">${prototypeIcon("phone",26)}</button>` : ""}<button class="icon-btn soft" data-action="open-chat-menu" aria-label="陪伴设置" aria-haspopup="dialog" aria-controls="chat-menu-dialog" aria-expanded="${state.chatMenuOpen}">${prototypeIcon("more",26)}</button></div></header><div class="chat-scroll"><div class="date-rule">今天</div>${paused}${ttsFailure}<section aria-label="对话消息">${state.messages.map((message) => messageMarkup(message, latestAssistantId)).join("") || '<div class="empty-state">从一句问候开始，让这段关系慢慢展开。</div>'}</section>${memoryBanner}</div><div class="bottom-dock"><form id="message-form" class="composer-wrap">${asrPanel}${imagePanel}${recordingIndicator}<div class="composer">${inputToggle}${inputArea}<label class="icon-btn context-image-picker" aria-label="上传聊天图片">${prototypeIcon("plus", 26)}<input id="context-image-file" type="file" accept="image/jpeg,image/png,image/webp" hidden></label>${sendButton}</div></form>${prototypeNav("chat")}</div></section>`;
}

// ---- 1:1 通话页（route="call"，豆包式免提）----
// 骨架只渲染一次；进入通话后状态/计时由 call-client 事件定点更新，不走
// render() 全量重建（音频走 AudioContext，与 DOM 无关）。免提交互：接通即
// 常开麦，开口即说、停顿即断句、随时打断；唯一按键是静音与挂断。

let callClient = null;
let callTimerTimer = null;
let callNoticeTimer = null;

const CALL_PHASE_STATUS = {
  ringing: "正在接通…",
  greeting: "正在打招呼 · 开口即可打断",
  ready: "在听，请讲",
  recording: "正在聆听 · 说完停顿一下即可",
  responding: "正在回应 · 随时开口打断"
};

function renderCall() {
  const call = state.call;
  if (!call) { state.route = "chat"; return renderChat(); }
  const characterName = state.character?.name ?? "当前角色";
  return `<section class="screen qiyu-prototype call-screen ${state.theme === "night" ? "night" : "paper"}" aria-label="语音通话"><header class="call-top"><span class="wordmark">语音通话</span><span id="call-timer" class="call-timer">00:00</span></header><div class="call-stage"><div class="call-avatar">${apricotAvatar(selectedPortrait().src, characterName)}<span id="call-pulse" class="call-pulse" aria-hidden="true"></span></div><h2>${escapeHtml(characterName)}</h2><p class="call-status" id="call-status">${escapeHtml(call.notice ?? CALL_PHASE_STATUS[call.phase ?? "ringing"] ?? "正在接通…")}</p><p class="call-quota" id="call-quota">${escapeHtml(call.quotaText ?? "")}</p></div><div class="call-controls"><button type="button" class="call-key mute ${callClient?.muted ? "muted" : ""}" data-action="call-mute"><span class="call-key-icon">${prototypeIcon("mic", 26)}</span><span class="call-key-label" id="call-mute-label">静音</span></button><button type="button" class="call-key interrupt" data-action="call-interrupt"><span class="call-key-icon">${prototypeIcon("wave",26)}</span><span class="call-key-label">打断</span></button><button type="button" class="call-key hangup" data-action="call-hangup"><span class="call-key-icon">${prototypeIcon("phone", 26)}</span><span class="call-key-label">结束</span></button></div></section>`;
}

function realtimeCallAvailable() {
  return state.trialAccess?.realtime_call?.enabled === true && isClosedTrial() && Boolean(state.trialSession?.access_token);
}
function updateCallHud() {
  if (!callClient || !state.call) return;
  const phase = callClient.phase;
  state.call.phase = phase;
  const status = document.getElementById("call-status");
  // 短暂提示（如「没有听清」）展示期间不覆盖；3 秒后由 setCallNotice 还原。
  if (status && !state.call.notice) status.textContent = CALL_PHASE_STATUS[phase] ?? status.textContent;
  const muteLabel = document.getElementById("call-mute-label");
  if (muteLabel) muteLabel.textContent = callClient.muted ? "取消静音" : "静音";
  document.querySelector('[data-action="call-mute"]')?.classList.toggle("muted", callClient.muted);
  const pulse = document.getElementById("call-pulse");
  if (pulse) pulse.dataset.active = phase === "recording" || phase === "responding" ? "true" : "false";
}

function startCallTimer() {
  window.clearInterval(callTimerTimer);
  callTimerTimer = window.setInterval(() => {
    const el = document.getElementById("call-timer");
    if (!el || !state.call?.startedAt) return;
    const seconds = Math.max(0, Math.floor((Date.now() - state.call.startedAt) / 1000));
    el.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }, 1_000);
}

// 状态行的瞬时提示（失败原因等）：不展示对话内容，只给必要反馈；写入
// state.call.notice 使重渲染也能还原，3 秒后回到阶段状态。
function setCallNotice(text) {
  if (state.call) state.call.notice = text;
  const status = document.getElementById("call-status");
  if (status) status.textContent = text;
  window.clearTimeout(callNoticeTimer);
  callNoticeTimer = window.setTimeout(() => {
    if (state.call) state.call.notice = null;
    updateCallHud();
  }, 3_200);
}

function handleCallEvent(event) {
  if (event.type === "started") {
    state.call = { ...state.call, callId: event.call.call_id, startedAt: Date.parse(event.call.started_at) || Date.now(), phase: "greeting" };
    const duration = event.call.max_duration_ms;
    if (Number.isFinite(duration) && duration > 0) {
      state.call.quotaText = `实时语音通话 · 单次最长 ${Math.ceil(duration / 60000)} 分钟 · 使用每日对话额度`;
      const quota = document.getElementById('call-quota'); if (quota) quota.textContent = state.call.quotaText;
    }
    startCallTimer();
  } else if (event.type === "muted") {
    setCallNotice(event.muted ? "已静音 · 取消后继续说话" : "在听，请讲");
    return; // 静音提示展示期内不被阶段状态覆盖
  } else if (event.type === "turn-failed") {
    setCallNotice(TURN_FAILURE_LABELS[event.code] ?? event.message ?? "没有听清，请再说一次");
  } else if (event.type === 'error') {
    if (state.call) state.call.lastError = event.message ?? '实时语音连接失败，请重新拨打。';
    setCallNotice(state.call?.lastError);
  } else if (event.type === 'ended' && state.call?.mode === 'native-realtime') {
    hangupCall();
  }
  if (["phase", "turn", "turn-done", "turn-finalized", "interrupted", "barge-in", "reconciled"].includes(event.type)) updateCallHud();
}

function startVoiceCall() {
  if (callClient) return;
  const selectedCharacterId = characterId();
  if (!selectedCharacterId) { setToast("请先创建角色，再发起通话。"); return; }
  if (conversationId() && state.conversation.character_id !== selectedCharacterId) { setToast("会话与当前角色不匹配，请刷新后重试。"); return; }
  if (!realtimeCallAvailable()) { setToast('语音通话暂不可用，请稍后重试。'); return; }
  const mode = 'native-realtime';
  state.call = { phase: "ringing", mode, quotaText: '实时语音通话 · 使用每日对话额度' };
  state.route = "call";
  render(); // 同步渲染骨架：仍在用户手势调用栈内，后续 HUD 全部定点更新
  callClient = new RealtimeCallClient({
    apiBase: API_BASE,
    authHeaders: (accept) => Object.fromEntries(authenticatedHeaders(accept).entries()),
    conversationId: conversationId(),
    prepareConversation: async () => {
      const conversation = await ensureConversation();
      if (characterId() !== selectedCharacterId || conversation.character_id !== selectedCharacterId) throw new Error("角色会话不匹配，请重试。");
      return conversation.conversation_id ?? conversation.id;
    },
    onEvent: handleCallEvent
  });
  window.__qiyuCall = callClient; // 诊断句柄（挂断时随生命周期清除）
  const startingClient = callClient;
  startingClient.start().catch((error) => {
    if (callClient !== startingClient) return; // A prior startup cannot reset a newer call.
    window.clearInterval(callTimerTimer);
    callTimerTimer = null;
    callClient = null;
    window.__qiyuCall = null;
    state.call = null;
    state.route = "chat";
    render();
    setToast(error?.code === "ENTITLEMENT_QUOTA_EXCEEDED" ? "语音额度不足，可在订阅方案中了解详情。" : serverMessage(error));
  });
}

function toggleCallMute() {
  if (!callClient) return;
  callClient.setMuted(!callClient.muted);
}

async function hangupCall() {
  const client = callClient;
  const lastError = state.call?.lastError;
  if (!client) { state.route = "chat"; render(); return; }
  callClient = null;
  window.__qiyuCall = null;
  window.clearInterval(callTimerTimer);
  callTimerTimer = null;
  const ended = await client.hangup().catch(() => null);
  if (callClient) return; // Ending the prior session must not reset a newly dialled call.
  state.call = null;
  state.route = "chat";
  try {
    const history = await api(`/conversations/${encodeURIComponent(conversationId())}/messages?limit=50`);
    state.messages = unwrap(history, "messages", "messages") ?? [];
  } catch { /* 挂断本身已成功；消息刷新失败不阻断返回 */ }
  if (callClient) return;
  render();
  if (lastError) setToast(lastError);
  else if (ended) setToast(CALL_END_REASON_LABELS[ended.end_reason] ?? "通话已结束");
}

function renderSubscription() {
  if (isClosedTrial() && state.trial?.state === "CLOSED_TRIAL") {
    const rows = (state.entitlements ?? []).map((item) => `<article class="asset"><div><b>${{ IMAGE_GENERATION: "情境图", SYNTHESIZE_TTS: "角色语音", TRANSCRIBE_ASR: "语音输入" }[item.capability] ?? escapeHtml(item.capability)}</b><small>封闭试用期间开放 · 无需领取 · 不限体验天数</small></div></article>`).join("");
    return apricotSettingsPage("试用与可用能力", `<section class="card"><h2>已自动开通</h2><p class="muted">完成登录与年龄准入即可使用，无需领取 7 天体验，无需订阅或付费。封闭试用期间不设体验到期日，语音和情境图不受订阅额度限制。</p></section><div class="stack">${rows}</div><section class="card"><h2>陪伴功能</h2><p class="muted">文字对话、角色设定、记忆与时间线、主动关心、共同计划和成果卡片均已开放。提醒和行动由你确认后开启，可随时关闭。</p></section>`, { night: state.theme === "night" });
  }
  const plans = state.subscriptionCatalog?.plans ?? [];
  const subscription = state.currentSubscription;
  const trial = state.trial;
  const entitlementRows = (state.entitlements ?? []).map((item) => {
    const unitLabel = item.unit === "SECONDS" ? "秒" : "张";
    const unlimitedTrial = item.quota_policy === "UNLIMITED_DURING_TRIAL";
    const detail = unlimitedTrial
      ? `试用期间不限量 · 不扣语音额度 · 至 ${item.resets_at ? escapeHtml(new Date(item.resets_at).toLocaleDateString()) : "试用结束"}`
      : `可用 ${escapeHtml(String(item.available_quantity))} ${unitLabel} / 已用 ${escapeHtml(String(item.committed_quantity))} · 重置 ${item.resets_at ? escapeHtml(new Date(item.resets_at).toLocaleDateString()) : "无有效订阅"}`;
    return `<article class="asset"><div><b>${{ IMAGE_GENERATION: "情境图", SYNTHESIZE_TTS: "角色语音", TRANSCRIBE_ASR: "语音输入" }[item.capability] ?? item.capability}</b><small>${detail}</small></div></article>`;
  }).join("");
  const subscriptionCard = subscription && subscription.state !== "TRIAL"
    ? `<section class="card"><h2>当前订阅：${escapeHtml(subscription.sku)} · ${escapeHtml(subscription.state)}</h2><p class="muted">周期：${subscription.period_start ? escapeHtml(new Date(subscription.period_start).toLocaleDateString()) : "未开始"} 至 ${subscription.period_end ? escapeHtml(new Date(subscription.period_end).toLocaleDateString()) : "—"}；自动续费：${subscription.auto_renew ? "已开启" : "未开启"}。</p>${["ACTIVE", "BILLING_RETRY", "GRACE_PERIOD"].includes(subscription.state) ? `<button class="btn btn-line" data-action="cancel-renewal" ${state.busy ? "disabled" : ""}>关闭自动续费</button>` : ""}</section>`
    : '<section class="card"><h2>当前无有效订阅</h2><p class="muted">到期或未订阅时，文字对话、人格、记忆与数据权利保持可用；不会用降低角色态度或遗忘关系促使付费。</p></section>';
  const trialCard = trial?.state === "TRIAL"
    ? `<section class="card"><h2>${trial.phase === "ENDING" ? "7 天完整体验即将结束" : "7 天完整体验进行中"}</h2><p class="muted">至 ${escapeHtml(new Date(trial.period_end).toLocaleDateString())}；包含 3 张情境图，角色语音、语音输入与语音通话在试用期间不限量。到期不自动扣费，也不会影响关系资产和数据权利。</p>${trial.phase === "ENDING" ? '<p class="muted">如果要继续使用多媒体服务，请主动选择订阅方案；不选择不会产生任何扣费。</p>' : ""}</section>`
    : trial?.state === "EXPIRED"
      ? '<section class="card"><h2>7 天完整体验已结束</h2><p class="muted">不会自动扣费。文字、人格、关系资产、导出与删除仍可用。</p></section>'
      : `<section class="card"><h2>先体验，再决定</h2><p class="muted">可领取一次 7 天完整体验：3 张情境图，角色语音、语音输入与语音通话在试用期间不限量；到期不自动扣费。</p><button class="btn btn-primary" data-action="start-trial" ${state.busy ? "disabled" : ""}>开始 7 天完整体验</button></section>`;
  const planCards = plans.map((plan) => `<section class="card"><h2>${escapeHtml(plan.label)} · ¥${(plan.price_fen / 100).toFixed(0)}/${plan.billing_cycle === "MONTH" ? "月" : "季度"}</h2><p class="muted">单角色、文本公平使用、${plan.image_quota} 张情境图、${plan.tts_minutes} 分钟角色语音、${plan.asr_minutes} 分钟语音输入。</p><div class="button-row"><button class="btn btn-primary" data-action="purchase-plan" data-sku="${escapeHtml(plan.sku)}" data-autorenew="false" ${state.busy ? "disabled" : ""}>购买（默认不续费）</button><button class="btn btn-line" data-action="purchase-plan" data-sku="${escapeHtml(plan.sku)}" data-autorenew="true" ${state.busy ? "disabled" : ""}>购买并开启续费</button></div></section>`).join("");
  return apricotSettingsPage("试用与可用能力", `${trialCard}${subscriptionCard}<section class="settings-group"><h2>权益余额</h2>${entitlementRows || '<div class="empty-state">暂无权益记录。</div>'}</section>${planCards || '<div class="empty-state">服务端未返回订阅目录；不会显示本地猜测价格。</div>'}<section class="card"><h2>续费规则</h2><p class="muted">自动续费默认${state.subscriptionCatalog?.auto_renew_default === false ? "不勾选" : "未确认"}；需要用户主动选择，并在付款前显示周期、金额和取消方式。到期后文字、人格、关系资产、导出与删除仍可用。</p></section><div class="flow-actions"><p class="muted">当前为开发模拟支付渠道：签名由服务端生成、回调经验签后发放权益；真实支付宝/微信支付需商户与渠道密钥接入后启用。</p></div>`, { night: state.theme === "night" });
}

function renderImageReference() {
  const selected = state.referenceImageFile ? `<section class="card image-file"><b>已选择：${escapeHtml(state.referenceImageFile.file.name)}</b><small>${escapeHtml(state.referenceImageFile.mimeType)} · ${Math.ceil(state.referenceImageFile.file.size / 1024)} KB</small></section>` : '<div class="empty-state">尚未选择参考立绘。浏览器不会生成预览或上传到公开地址。</div>';
  const review = state.referenceRightsReview;
  const asset = state.referenceImageAsset;
  const reviewCard = review ? `<section class="card status-card ${review.state === "APPROVED" ? "pass" : "review"}"><b>参考图权利审核：${escapeHtml(review.state ?? "未返回")}</b><p class="muted">IMS 内容审核和权利审核是两项独立结论。当前应用不会自行批准权利审核。</p><div class="button-row"><button class="btn btn-line" data-action="refresh-reference-rights" ${state.busy ? "disabled" : ""}>刷新审核状态</button>${review.appeal_available ? `<button class="btn btn-line" data-action="appeal-reference-rights" ${state.busy ? "disabled" : ""}>提交申诉</button>` : ""}</div></section>` : asset ? `<section class="card status-card review"><b>参考图状态：${escapeHtml(asset.state ?? "未返回")}</b><p class="muted">该图片未进入独立权利审核，不能用于生图；请重新选择合规且拥有使用授权的参考图。</p></section>` : "";
  return screen(`<div class="topline"><button type="button" class="icon-btn app-back" data-action="back-chat" aria-label="返回"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button></div><h1 id="app-title">先确认参考立绘，<br>再生成情境。</h1><p class="lead">参考图会先进入私有 COS 并经 IMS 内容审核，再进入独立权利审核。任一步未通过，都不会创建生图任务。</p>${reviewCard}<form id="reference-image-form" class="stack">${selected}<label class="field"><span>导入角色参考立绘</span><input id="reference-image-file" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" ${state.busy ? "disabled" : ""}><small class="muted">仅 PNG、JPG、WebP，最大 2MB。请勿上传真人、未获授权的角色/IP、敏感或违法内容。</small></label><label class="check-row"><input name="image_rights_confirmed" type="checkbox" required><span>我确认拥有图片使用授权；该图不会作为公开链接返回，且只会用于当前角色的受控情境生成。</span></label><button class="btn btn-primary" ${state.referenceImageFile && !state.busy ? "" : "disabled"}>上传并提交审核</button></form>`);
}

function renderImageScene() {
  const reference = state.referenceImageAsset;
  if (!referenceImageUsable()) { state.route = "image-reference"; return renderImageReference(); }
  const job = state.imageJob;
  const imageFailure = ["FAILED", "BLOCKED"].includes(job?.state)
    ? `<section class="card media-failure" data-media-type="IMAGE_GENERATION" data-state="${escapeHtml(job.state)}"><b>${job.failure_code === "ENTITLEMENT_QUOTA_EXCEEDED" ? "情境图额度不足" : "情境图未交付"}</b><p class="muted">页面不会展示未通过服务端处理的图片；额度与返还以服务端权益账本为准。</p><small>安全失败码：${escapeHtml(job.failure_code ?? "IMAGE_NOT_DELIVERED")}</small><button class="btn btn-line" data-action="open-subscription" ${state.busy ? "disabled" : ""}>查看权益与订阅</button></section>`
    : "";
  const jobCard = job ? `<section class="card image-job"><b>图片任务：${escapeHtml(job.state ?? "未返回")}</b><small>失败码：${escapeHtml(job.failure_code ?? "无")}</small>${job.state === "COMPLETED" ? '<p class="muted">结果必须通过后审后才会显示。</p>' : '<p class="muted">生成、下载、私有入桶和后审均由服务端完成。浏览器不会读取供应商临时 URL。</p>'}</section>` : "";
  const generated = state.generatedImage ? `<section class="card generated-image"><span class="aigc">AI 生成情境图 · 服务端后审通过</span><img src="${escapeHtml(state.generatedImage.url)}" alt="当前角色的 AI 生成情境图"><button class="btn btn-danger" data-action="delete-generated-image" ${state.busy ? "disabled" : ""}>删除这张情境图</button></section>` : "";
  return screen(`<div class="topline"><button type="button" class="icon-btn app-back" data-action="back-chat" aria-label="返回"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button></div><h1 id="app-title">只生成你确认过的情境。</h1><section class="card"><b>参考立绘已确认</b><p class="muted">服务器仅使用这个已审核资产，以及下方地点、服装、时间字段；不会把未确认聊天记录或候选记忆编入提示词。</p></section>${imageFailure}${jobCard}${generated}<form id="image-scene-form" class="stack"><label class="field"><span>地点</span><input name="scene_location" maxlength="80" required placeholder="例如：窗边"></label><label class="field"><span>服装</span><input name="scene_outfit" maxlength="80" required placeholder="例如：针织衫"></label><label class="field"><span>时间</span><select name="scene_time_of_day" required><option value="">请选择</option><option value="DAWN">黎明</option><option value="MORNING">上午</option><option value="AFTERNOON">下午</option><option value="EVENING">傍晚</option><option value="NIGHT">夜晚</option></select></label><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>提交单张情境图任务</button></form><div class="flow-actions">${job && ["PENDING", "RUNNING"].includes(job.state) ? `<button class="btn btn-line" data-action="refresh-image-job" ${state.busy ? "disabled" : ""}>刷新图片任务状态</button>` : ""}<button class="btn btn-line" data-action="replace-reference-image" ${state.busy ? "disabled" : ""}>更换参考立绘</button><p class="muted">一张任务只请求一张图，并要求供应商添加 AIGC 标识；失败或审核拦截不会把图片交给浏览器。</p></div>`);
}

function renderAsrInput() {
  const recording = state.asrRecording?.state === "recording";
  const recorderReady = Boolean(recordingMimeType() && navigator.mediaDevices?.getUserMedia);
  const selected = state.asrFile ? `<section class="card asr-file"><b>已选择：${escapeHtml(state.asrFile.file.name)}</b><small>${escapeHtml(state.asrFile.mimeType)} · ${Math.ceil(state.asrFile.file.size / 1024)} KB</small></section>` : '<div class="empty-state">尚未选择音频。只在本浏览器内暂存，服务端受理后会立即清除。</div>';
  const failed = state.asrJob?.state === "FAILED" ? `<section class="card asr-failed"><b>转写未完成</b><p class="muted">失败码：${escapeHtml(state.asrJob.failure_code ?? "未返回")}。原始音频仍由服务端私有保存，建议立即删除。</p><button class="btn btn-danger" data-action="delete-failed-asr-input" ${state.busy ? "disabled" : ""}>删除原始音频</button></section>` : "";
  return screen(`<div class="topline"><button type="button" class="icon-btn app-back" data-action="back-chat" aria-label="返回"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button></div><h1 id="app-title">先看文字，<br>再决定是否发送。</h1><p class="lead">短音频会先创建私有转写任务。转写完成后，你可以修订；确认并不自动发送给角色。</p><div class="stack">${failed}${selected}<label class="field"><span>导入短音频</span><input id="asr-file" type="file" accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/aac,audio/ogg,.mp3,.wav,.m4a,.aac,.ogg" ${state.busy || recording ? "disabled" : ""}><small class="muted">支持 WAV、MP3、M4A、AAC、OGG；不超过 2MB。开发路径不接受 WebM。</small></label><div class="button-row">${recording ? '<button class="btn btn-danger" data-action="stop-asr-recording">停止录音</button>' : `<button class="btn btn-line" data-action="start-asr-recording" ${recorderReady && !state.busy ? "" : "disabled"}>录制兼容音频</button>`}</div><button class="btn btn-primary" data-action="create-asr-job" ${state.asrFile && !state.busy && !recording ? "" : "disabled"}>转写并进入确认</button><p class="muted">录音按钮仅在浏览器能输出腾讯兼容的 OGG 时可用；否则请导入音频，避免把不受支持格式伪装成可转写。</p></div>`);
}

function renderAsrConfirm() {
  const transcript = state.asrJob?.transcript?.text ?? "";
  if (!state.asrJob || state.asrJob.state !== "COMPLETED") { state.route = "asr"; return renderAsrInput(); }
  return screen(`<div class="topline"><button class="btn btn-line" data-action="back-asr">重新选择音频</button></div><h1 id="app-title">这段转写，<br>由你决定怎么说。</h1><section class="card"><b>服务端转写已完成</b><p class="muted">确认后原始音频将被立即撤销并请求删除；这一步不会发送给角色模型。</p></section><label class="field"><span>检查或修订转写</span><textarea id="asr-edit" maxlength="4000">${escapeHtml(state.asrEdit || transcript)}</textarea></label><div class="flow-actions"><button class="btn btn-primary" data-action="confirm-asr" ${state.asrEdit.trim() && !state.busy ? "" : "disabled"}>确认文字并回到输入框</button><button class="btn btn-line" data-action="back-asr" ${state.busy ? "disabled" : ""}>放弃，不发送</button><p class="muted">“确认”只确认转写与触发原始音频删除。返回对话后仍必须点击“发送”。</p></div>`);
}

function renderCandidate() {
  const candidate = state.selectedCandidate;
  if (!candidate) { state.route = "chat"; return renderChat(); }
  const text = candidate.display_text ?? candidate.normalized_value ?? "服务端未返回候选文本";
  const conflicts = candidate.conflicts_with ?? [];
  const conflictMarkup = conflicts.length > 0 ? `<div class="rights">${prototypeIcon("shield", 17)}<span>与已有关系资产可能冲突。确认不会自动覆盖旧内容，请在时间线中单独修订。</span></div>` : "";
  const characterName = state.character?.name ?? "当前角色";
  // 生活事件（六项能力 A1）：日期确认走专用 sheet（含糊时间补全 + 完整字段集提交）。
  const sheet = candidate.type === "life_event"
    ? lifeEventCandidateSheet({ candidate, busy: state.busy, draft: state.eventDraft })
    : `<section class="sheet" role="dialog" aria-modal="true" aria-label="关系记忆确认"><div class="grabber"></div><div class="sheet-head"><div><span class="aigc">${escapeHtml({ SKILL: "行为沉淀", development_note: "记忆候选", PREFERENCE: "偏好", life_event: "生活事件" }[candidate.type] ?? "服务端候选")}</span><h3>关系记忆</h3><p>候选内容不会自动成为长期事实</p></div><button class="close" data-action="back-chat" aria-label="关闭">${prototypeIcon("x", 18)}</button></div><blockquote class="memory-quote">${escapeHtml(text)}</blockquote>${conflictMarkup}<label class="field"><span>修改后确认（可选）</span><textarea id="candidate-edit">${escapeHtml(state.confirmEdit || text)}</textarea></label><div class="sheet-actions"><button class="btn btn-line" data-action="reject-candidate" ${state.busy ? "disabled" : ""}>不记住</button><button class="btn btn-secondary" data-action="confirm-edited-candidate" ${state.busy ? "disabled" : ""}>修改措辞</button><button class="btn btn-primary wide" data-action="confirm-candidate" ${state.busy ? "disabled" : ""}>确认记住 ${prototypeIcon("check", 18)}</button></div><p class="note">确认、修改或拒绝的最终状态均以 API 返回为准。</p></section>`;
  return `<section class="screen qiyu-prototype app-screen paper"><header class="app-header"><div class="identity"><button type="button" class="avatar-picker-trigger" data-action="open-portrait-picker" aria-label="更换角色头像"><img class="avatar" src="${selectedPortrait().src}" alt="${escapeHtml(characterName)}，AI 角色"></button><div><b>${escapeHtml(characterName)}</b><small><span class="ai-dot"></span>AI 角色 · 关系记忆</small></div></div><button class="icon-btn soft" data-action="back-chat" aria-label="关闭记忆确认">${prototypeIcon("x", 20)}</button></header><div class="chat-scroll"><div class="date-rule">关系资产需由你确认</div><div class="scene-state"><span class="glyph">${prototypeIcon("archive", 16)}</span><span><b>候选记忆等待确认</b><small>不会自动写入长期关系资产</small></span></div></div><div class="sheet-layer">${sheet}</div></section>`;
}

function deletionMarkup() {
  if (!state.deletionJob) return "";
  const status = state.deletionJob.state ?? state.deletionJob.status ?? state.deletionJob.production ?? "UNKNOWN";
  const id = state.deletionJob.deletion_job_id ?? state.deletionJob.id ?? "未返回";
  const epoch = state.deletionJob.revocation_epoch ?? "未返回";
  return `<section class="card deletion" data-state="${escapeHtml(status)}"><b>删除任务：${DELETION_STATE_LABELS[status] ?? escapeHtml(status)}</b><small>任务 ID：${escapeHtml(id)} · 撤销纪元：${escapeHtml(epoch)}</small><p class="muted">此状态完全来自 API；除非服务端返回 COMPLETED，界面不会称删除完成。</p><button class="btn btn-line" data-action="refresh-deletion" ${state.busy ? "disabled" : ""}>刷新删除任务</button></section>`;
}

function renderAssets() {
  const filter = state.timelineFilter ?? "all";
  const timelineCards = (state.timeline ?? []).map((entry) => entry.entry_type === "LIFE_EVENT"
    ? lifeEventTimelineCard(entry, { busy: state.busy })
    : `<article class="asset timeline-entry"><div><b>${escapeHtml(entry.display_text ?? entry.type)}</b><small>${escapeHtml(new Date(entry.created_at).toLocaleString())} · ${FILTER_GROUP_LABELS[entry.filter_group] ?? FILTER_GROUP_LABELS[entry.type] ?? "记录"} · 版本 ${escapeHtml(entry.version ?? "?")}</small></div><div class="button-row"><button class="btn btn-line" data-action="revise-asset" data-asset-id="${escapeHtml(entry.asset_id)}" ${state.busy ? "disabled" : ""}>修订</button><button class="btn btn-danger" data-action="delete-asset" data-asset-id="${escapeHtml(entry.asset_id)}" ${state.busy ? "disabled" : ""}>删除</button></div></article>`).join("");
  // 六项能力 A2：改期撤销提醒后的重新确认卡（放最上面，看完即可处理）。
  const regrant = state.pendingFollowupRegrant;
  const regrantCard = regrant ? `<section class="card followup-regrant"><b>提醒已随改期关闭</b><p class="muted">事件已改到新时间，原来的跟进提醒已取消（${escapeHtml(regrant.jobs_cancelled)} 条任务）。确认事件 ≠ 允许提醒——按新时间重新开启需要你再确认一次。</p><div class="button-row"><button class="btn btn-primary" data-action="regrant-followup" ${state.busy ? "disabled" : ""}>为新时间重新开启提醒</button><button class="btn btn-line" data-action="dismiss-regrant" ${state.busy ? "disabled" : ""}>不用了</button></div></section>` : "";
  const primaryChips = [["all", "全部"], ["memory", "记忆"], ["commitment", "约定"]].map(([value,label]) => `<button class="btn ${filter === value ? "btn-primary" : "btn-line"}" data-timeline-filter="${value}" ${state.busy ? "disabled" : ""}>${label}</button>`).join("");
  const extraChips = [["boundary","边界"],["event","事件"]].map(([value,label]) => `<button class="btn btn-line" data-timeline-filter="${value}">${label}</button>`).join("");
  return apricotFrame(`<div class="apricot-scroll">${apricotHeader("我们的回忆", `<button class="icon-btn soft" data-action="remember-in-chat" aria-label="添加回忆">${prototypeIcon("plus",26)}</button>`)}<div class="apricot-filter" role="group" aria-label="回忆分类">${primaryChips}</div><div class="stack">${regrantCard}${deletionMarkup()}${timelineCards || '<div class="empty-state">当前筛选下还没有回忆。</div>'}</div><details><summary>更多回忆管理</summary><div class="apricot-filter">${extraChips}</div><div class="flow-actions"><button class="btn btn-line" data-action="download-relationship-profile">下载关系档案 JSON</button><button class="btn btn-line" data-action="refresh-assets">刷新回忆</button><button class="btn btn-line" data-action="open-data">数据与保留周期</button></div></details></div>`, "assets", state.theme === "night");
}

function trialFeedbackMarkup() {
  if (!isClosedTrial()) return "";
  const recent = state.trialFeedback.slice(0, 3).map((item) => `<li>${FEEDBACK_CATEGORY_LABELS[item.category] ?? escapeHtml(item.category)} · ${escapeHtml(item.rating)}/5${item.note ? ` · ${escapeHtml(item.note)}` : ""}</li>`).join("");
  return `<section class="feedback-card settings-panel"><h2>封闭试用反馈</h2><p class="page-sub">你的评价会进入试用改进看板；不会自动改写角色人格、关系记忆或安全状态。</p><form id="trial-feedback-form"><label class="field"><span>反馈分类</span><select name="category" required><option value="ONBOARDING">引导与注册</option><option value="PERSONA">角色人格</option><option value="MEMORY">记忆连续性</option><option value="SAFETY">安全与边界</option><option value="USABILITY" selected>易用性</option><option value="OTHER">其他</option></select></label><label class="field"><span>总体评分</span><select name="rating" required><option value="5">5 · 很满意</option><option value="4" selected>4 · 满意</option><option value="3">3 · 一般</option><option value="2">2 · 不满意</option><option value="1">1 · 很不满意</option></select></label><label class="field"><span>补充说明（可选，最多 1200 字）</span><textarea name="note" maxlength="1200" rows="3"></textarea></label><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>提交试用反馈</button></form>${recent ? `<p class="page-sub">最近提交：</p><ul class="page-sub">${recent}</ul>` : ""}<button class="btn btn-line" data-action="trial-logout" ${state.busy ? "disabled" : ""}>退出此设备的试用会话</button></section>`;
}

function renderDataCenter() {
  const retention = state.rawInteractionRetentionDays;
  const retentionText = retention === 30 || retention === 90 ? `${retention} 天` : "未取得服务端设置";
  return apricotSettingsPage("数据与隐私", `
  <section class="settings-panel"><h2>账户</h2><div class="list"><button class="list-row" data-action="open-subscription"><span class="list-ico">${prototypeIcon("spark", 24)}</span><span class="list-copy"><b>试用与可用能力</b><small>查看试用状态、语音权益和到期时间</small></span></button></div></section>
  <section class="settings-panel settings-rights"><span class="settings-symbol">${prototypeIcon("lock", 24)}</span><h2>数据权利独立于关系</h2><p>聊天记录、候选记忆和确认的关系资产分层保存；删除后是否完成以服务端回执为准。</p></section>
  <section class="settings-panel"><div class="settings-section-head"><h2>聊天保留周期</h2><small>当前 ${escapeHtml(retentionText)}</small></div><div class="segment" role="group" aria-label="聊天保留周期"><button class="${retention === 30 ? "on" : ""}" data-action="set-retention-30" aria-pressed="${retention === 30}" ${state.busy ? "disabled" : ""}>30 天</button><button class="${retention === 90 ? "on" : ""}" data-action="set-retention-90" aria-pressed="${retention === 90}" ${state.busy ? "disabled" : ""}>90 天</button></div></section>
  <section class="settings-panel"><div class="settings-section-head"><h2>关系资产</h2><small>${state.assets.length} 条有效资产</small></div><div class="list"><button class="list-row" data-action="download-relationship-profile"><span class="list-ico">${prototypeIcon("download", 24)}</span><span class="list-copy"><b>导出我的数据</b><small>关系档案、当前可见文本与确认记忆</small></span></button><button class="list-row" data-action="open-assets"><span class="list-ico">${prototypeIcon("archive", 24)}</span><span class="list-copy"><b>管理关系资产</b><small>查看、修订或删除确认内容</small></span></button><button class="list-row" data-action="open-safety"><span class="list-ico">${prototypeIcon("shield", 24)}</span><span class="list-copy"><b>帮助与反馈</b><small>联系人、举报、申诉和紧急帮助</small></span></button></div></section>
  ${trialFeedbackMarkup()}${deletionMarkup()}
  <section class="settings-panel"><h2>删除与注销</h2><p class="muted">订阅不影响数据权利</p><div class="list"><button class="list-row settings-danger" data-action="delete-account" ${state.busy ? "disabled" : ""}><span class="list-ico">${prototypeIcon("trash", 24)}</span><span class="list-copy"><b>注销账户</b><small>终止访问并进入可审计删除流程</small></span></button></div></section>
  `, { night: state.theme === "night" });
}

// ---- 生活事件（六项能力 A1）：来源面板 / 修订 / 删除 ----

async function openMemoryReferences(messageIdValue) {
  if (!messageIdValue) return;
  setBusy(true);
  try {
    const payload = await api(`/messages/${encodeURIComponent(messageIdValue)}/memory-references`);
    state.memoryRefsPanel = payload;
  } catch (error) {
    // 404=该消息没有引用记录（开关未开或本轮无注入），如实提示不装数据。
    state.memoryRefsPanel = null;
    setToast(error?.status === 404 ? "这一轮没有记忆引用记录。" : serverMessage(error));
  } finally { setBusy(false); render(); }
}

async function submitEventRevision(eventId, expectedVersion) {
  const title = document.querySelector("#event-revise-title")?.value?.trim() ?? "";
  const local = document.querySelector("#event-revise-scheduled-at")?.value ?? "";
  const status = document.querySelector("#event-revise-status")?.value ?? "PLANNED";
  const scheduledAt = fromLocalInputValue(local);
  setBusy(true);
  try {
    const payload = await api(`/life-events/${encodeURIComponent(eventId)}`, {
      method: "PATCH", idempotent: uuid(),
      body: { expected_version: expectedVersion, title, scheduled_at: scheduledAt, timezone: "Asia/Shanghai", status }
    });
    state.revisingEvent = null;
    state.eventDraft = null;
    // 六项能力 A2 联动：改期撤销旧版本的提醒（jobs_cancelled>0）→ 不静默
    // 重开，给「为新时间重新开启提醒」确认卡（重新许可是用户自己的点击）。
    const cancelledJobs = payload?.followup_invalidated?.jobs_cancelled ?? 0;
    if (cancelledJobs > 0) {
      state.pendingFollowupRegrant = {
        event_id: payload?.event?.event_id ?? eventId,
        expected_version: payload?.event?.version ?? null,
        jobs_cancelled: cancelledJobs
      };
      setToast(`事件已修订；原提醒已随旧版本取消（${cancelledJobs} 条任务）。`);
    } else {
      setToast("事件已修订；旧版本保留历史。");
    }
    await refreshMemoryAndAssets();
  } catch (error) {
    if (error?.status === 409) {
      // 版本冲突：保留草稿，提示用户基于服务端回传的当前值重试。
      state.eventDraft = { title, scheduled_at: scheduledAt, status };
      setToast("这份事件已被其他设备修改。你的修改已保留在表单里，请基于最新版本重试。");
    } else {
      setToast(serverMessage(error));
    }
  } finally { setBusy(false); render(); }
}

async function deleteLifeEventAction(entry) {
  if (!entry) return;
  if (!window.confirm(`删除「${entry.display_text ?? entry.title ?? "这个事件"}」？删除后带服务端回执，可随时在数据中心查看。`)) return;
  setBusy(true);
  try {
    const payload = await api(`/life-events/${encodeURIComponent(entry.event_id)}`, { method: "DELETE", idempotent: uuid() });
    state.eventDeletionReceipt = payload?.deletion_receipt ?? null;
    state.deletionJob = payload?.deletion_job ?? null;
    state.pendingFollowupRegrant = null;
    setToast(payload?.deletion_receipt ? `已删除。回执：${payload.deletion_receipt.completed_targets ?? 0} 项清理完成。` : "已删除。");
    await refreshMemoryAndAssets();
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); render(); }
}

// 六项能力 A2：时间线事件卡「提醒我」开关。开启=PUT followup（followup_kind
// 按事件状态选：PLANNED 走事前准点提醒，其余走事后关心；due_at 缺省由服务端
// 按事件时间派生）。关闭=DELETE（已发出的消息不撤回）。409=事件刚被改，提示
// 刷新后重试，不用旧版本硬写。
async function toggleEventFollowup(button) {
  const eventId = button.dataset.eventId;
  if (!eventId) return;
  const turningOn = button.dataset.followupOn !== "true";
  setBusy(true);
  try {
    if (turningOn) {
      const payload = await api(`/life-events/${encodeURIComponent(eventId)}/followup`, {
        method: "PUT", idempotent: uuid(),
        body: {
          expected_version: Number(button.dataset.expectedVersion),
          followup_kind: button.dataset.eventStatus === "PLANNED" ? "BEFORE_EVENT" : "AFTER_EVENT"
        }
      });
      setToast(payload?.note ?? "跟进提醒已开启；到期时写进对话消息流（每日一条与静默时段仍生效）。");
    } else {
      await api(`/life-events/${encodeURIComponent(eventId)}/followup`, { method: "DELETE", idempotent: uuid(), body: {} });
      setToast("已关闭这条事件的提醒；已发出的消息不会撤回。");
    }
    await refreshMemoryAndAssets();
  } catch (error) {
    if (error?.status === 409) setToast("事件刚被修改，请刷新时间线后再操作提醒。");
    else setToast(serverMessage(error));
  } finally { setBusy(false); render(); }
}

// 改期确认卡：按新事件时间重新开启提醒（again 一次许可=一次跟进）。
async function regrantFollowup() {
  const regrant = state.pendingFollowupRegrant;
  if (!regrant?.expected_version) { state.pendingFollowupRegrant = null; render(); return; }
  setBusy(true);
  try {
    const payload = await api(`/life-events/${encodeURIComponent(regrant.event_id)}/followup`, {
      method: "PUT", idempotent: uuid(),
      body: { expected_version: regrant.expected_version, followup_kind: "BEFORE_EVENT" }
    });
    state.pendingFollowupRegrant = null;
    setToast(payload?.note ?? "已按新时间重新开启提醒。");
    await refreshMemoryAndAssets();
  } catch (error) {
    if (error?.status === 409) setToast("事件又有新版本，请刷新时间线后从事件卡重新开启提醒。");
    else setToast(serverMessage(error));
    state.pendingFollowupRegrant = null;
  } finally { setBusy(false); render(); }
}

// ---- 六项能力 A3：计划与卡片操作 ----

// 接受草案：确认≠开提醒——只有勾选了「到期提醒我」才附带 followup 子对象
//（与单独开提醒同一套服务端校验）。
async function planAccept(button) {
  const planId = button.dataset.planId;
  const expectedVersion = Number(button.dataset.expectedVersion);
  if (!planId || !Number.isFinite(expectedVersion)) return;
  const checkbox = button.closest(".plan-card")?.querySelector(".plan-followup-checkbox");
  const body = { expected_version: expectedVersion };
  if (checkbox?.checked) body.followup = { followup_kind: "BEFORE_EVENT" };
  setBusy(true);
  try {
    const payload = await api(`/companion-plans/${encodeURIComponent(planId)}/accept`, { method: "POST", idempotent: uuid(), body });
    setToast(payload?.linked_grant ? "计划已开始；到期提醒也开好了（每天最多一条，可随时关）。" : "计划已开始；没有开启提醒——想开的话在事件卡上点「提醒我」。");
    await refreshPlans();
  } catch (error) {
    setToast(planConflictMessage(error, "接受"));
  } finally { setBusy(false); render(); }
}

// 暂停/恢复/完成/取消（都是计划本身的操作；暂停会停掉随计划开的那条提醒）。
async function planAction(button) {
  const planId = button.dataset.planId;
  const actionName = button.dataset.planAction;
  const expectedVersion = Number(button.dataset.expectedVersion);
  if (!planId || !actionName || !Number.isFinite(expectedVersion)) return;
  setBusy(true);
  try {
    const payload = await api(`/companion-plans/${encodeURIComponent(planId)}/${actionName}`, {
      method: "POST", idempotent: uuid(),
      body: actionName === "complete" ? { expected_version: expectedVersion, confirm: true } : { expected_version: expectedVersion }
    });
    setToast(payload?.note ?? PLAN_ACTION_TOASTS[actionName] ?? "已更新。");
    await refreshPlans();
    await refreshMemoryAndAssets();
  } catch (error) {
    setToast(planConflictMessage(error, PLAN_ACTION_VERBS[actionName] ?? "操作"));
  } finally { setBusy(false); render(); }
}

const PLAN_ACTION_TOASTS = { pause: "计划已暂停；随计划开的提醒也停了（不补发）。", resume: "计划已恢复。", cancel: "计划已取消，不勉强。", complete: "标记完成——这一步走得很好。" };
const PLAN_ACTION_VERBS = { pause: "暂停", resume: "恢复", cancel: "取消", complete: "完成" };

function planConflictMessage(error, verb) {
  if (error?.status === 409) return `计划刚被修改或状态不允许${verb}；已刷新，请再看一眼。`;
  if (error?.status === 404) return "计划能力未开启（开发开关 COMPANION_PLANS）。";
  return serverMessage(error);
}

// 步骤勾选：TODO↔DONE 走 PATCH（计划聚合乐观锁；服务端 bump 版本）。
async function togglePlanStep(button) {
  const planId = button.dataset.planId;
  const stepId = button.dataset.stepId;
  const nextState = button.dataset.stepState === "TODO" ? "DONE" : "TODO";
  const expectedVersion = Number(button.dataset.expectedVersion);
  if (!planId || !stepId || !Number.isFinite(expectedVersion)) return;
  setBusy(true);
  try {
    await api(`/companion-plans/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepId)}`, {
      method: "PATCH", idempotent: uuid(), body: { expected_version: expectedVersion, state: nextState }
    });
    await refreshPlans();
  } catch (error) {
    setToast(planConflictMessage(error, "更新步骤"));
  } finally { setBusy(false); render(); }
}

// 草案步骤标题行内编辑：change 即保存；409 保输入值提示刷新（不整页重置）。
async function savePlanStepTitle(input) {
  const planId = input.dataset.planId;
  const stepId = input.dataset.stepId;
  const expectedVersion = Number(input.dataset.expectedVersion);
  const title = String(input.value ?? "").trim();
  if (!planId || !stepId || !Number.isFinite(expectedVersion) || !title) return;
  try {
    await api(`/companion-plans/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepId)}`, {
      method: "PATCH", idempotent: uuid(), body: { expected_version: expectedVersion, title }
    });
    await refreshPlans();
    setToast("步骤已保存；接受前都可以改。");
    render();
  } catch (error) {
    if (error?.status === 409) setToast("计划刚被修改，这处编辑没保存；已刷新，请重新调整。");
    else setToast(serverMessage(error));
    await refreshPlans().catch(() => {});
    render();
  }
}

// 让角色提议一份草案（时间线事件卡入口 / 过期草案重提）。
async function createPlanForEvent(eventId) {
  setBusy(true);
  try {
    const payload = await api("/companion-plans", {
      method: "POST", idempotent: uuid(),
      body: { template_version: "INTERVIEW_PREP_V1", support_mode: "PRACTICE_TOGETHER", ...(eventId ? { event_id: eventId } : {}) }
    });
    const plan = payload?.plan;
    state.cardCache.delete(payload?.card?.artifact_id);
    setToast(plan ? `TA 拟了一份草案：「${plan.title}」——可编辑，接受才开始。` : "草案已生成，到「计划」里看看。");
    await refreshPlans();
    await refreshMemoryAndAssets();
  } catch (error) {
    if (error?.status === 409) setToast("这件事已有一个进行中或暂停中的计划；先处理它，再重新开始。");
    else if (error?.status === 404) setToast("计划能力未开启（开发开关 COMPANION_PLANS）。");
    else setToast(serverMessage(error));
  } finally { setBusy(false); render(); }
}

// 卡片上的动作按钮：动作 ID 来自服务端白名单；这里只映射到既有入口。
// 卡片不带 expected_version——先拉当前计划，以服务端最新版本执行。
async function runCardAction(button) {
  const action = button.dataset.cardAction;
  const planId = button.dataset.planId;
  if (action === "OPEN_PLAN") { await openPlans(); return; }
  if (action === "OPEN_EVENT") { state.route = "assets"; await refreshMemoryAndAssets(); render(); return; }
  const mapped = { ACCEPT_PLAN: "accept", PAUSE_PLAN: "pause", RESUME_PLAN: "resume", CANCEL_PLAN: "cancel", COMPLETE_PLAN: "complete" }[action];
  if (mapped && planId) {
    try {
      const payload = await api(`/companion-plans/${encodeURIComponent(planId)}`);
      const plan = unwrap(payload, "plan", "plan");
      if (!plan) { setToast("计划不存在或已被处理。"); return; }
      if (mapped === "accept") await planAccept({ dataset: { planId, expectedVersion: String(plan.version) }, closest: () => null });
      else await planAction({ dataset: { planId, planAction: mapped, expectedVersion: String(plan.version) } });
    } catch (error) { setToast(planConflictMessage(error, "操作")); }
    return;
  }
  setToast("这个动作当前不可用。");
}

// 时间线「查看卡片」：拉卡片数据开 bottom-sheet（EVENT_V1/READING_LOG_V1）。
async function openEventCard(artifactId) {
  if (!artifactId) return;
  setBusy(true);
  try {
    const payload = await api(`/artifacts/${encodeURIComponent(artifactId)}`);
    state.cardSheet = unwrap(payload, "card", "card") ?? null;
    if (!state.cardSheet) setToast("卡片内容暂不可用。");
  } catch (error) {
    setToast(error?.status === 404 ? "卡片已随事件下线。" : serverMessage(error));
  } finally { setBusy(false); render(); }
}

// 卡片导出：format=markdown 文本下载（Blob + a.download，不进缓存）。
async function exportCard(artifactId) {
  try {
    const response = await fetch(`${API_BASE}/artifacts/${encodeURIComponent(artifactId)}?format=markdown`, { headers: { authorization: `Bearer ${bearerToken()}` } });
    if (!response.ok) throw Object.assign(new Error("导出失败"), { status: response.status });
    const markdown = await response.text();
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${artifactId}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
    setToast("卡片已导出为 Markdown；文件生成≠已加入你的日历或其他系统。");
  } catch (error) {
    setToast(error?.status === 404 ? "卡片已下线，无法导出。" : serverMessage(error));
  }
}

async function undoCandidateRejection() {  const rejected = state.lastRejectedCandidate;
  if (!rejected) return;
  setBusy(true);
  try {
    await api(`/memory-candidates/${encodeURIComponent(rejected.id)}/undo-reject`, { method: "POST", idempotent: uuid(), body: { expected_version: rejected.version } });
    state.lastRejectedCandidate = null;
    await refreshMemoryAndAssets();
    setToast("已撤销“不记住”，候选记忆重新等待你的确认。");
  } catch (error) { state.lastRejectedCandidate = null; setToast(serverMessage(error)); }
  finally { setBusy(false); }
}

function renderNotifications() {
  const rows = state.notifications.map((item) => `<article class="card"><b>${escapeHtml(item.title)}</b><p class="muted">${escapeHtml(item.body)}</p><small>${escapeHtml(new Date(item.created_at).toLocaleString())} · ${item.read ? "已读" : "未读"}</small>${item.read ? "" : ` <button class="btn btn-line" data-action="read-notification" data-notification-id="${escapeHtml(item.notification_id)}" ${state.busy ? "disabled" : ""}>标为已读</button>`}</article>`).join("");
  return apricotSettingsPage("站内通知", `<div class="stack">${rows || '<div class="empty-state">暂时没有通知。</div>'}</div><p class="muted">这里只显示账户状态、数据权利和试用权益的必要通知，不承载营销信息。</p>`, { night: state.theme === "night", backAction: "back-notifications", backLabel: "返回上一页" });
}

function renderSafety() {
  const contact = state.emergencyContact;
  const contactCard = contact
    ? `<section class="card"><h2>紧急联系人已保存</h2><p class="muted">${escapeHtml(contact.contact_name)} · ${escapeHtml(contact.relationship)} · ${escapeHtml(contact.phone_masked)}</p><p class="muted">仅用于法规与生命健康或重大财产安全响应；不用于增长、推荐或营销。</p><button class="btn btn-line" data-action="remove-emergency-contact" ${state.busy ? "disabled" : ""}>删除联系人</button></section>`
    : `<section class="card"><h2>紧急联系人未保存</h2><p class="muted">按适用要求提供必要的监护人或紧急联系人信息；提交前请阅读独立用途告知。</p></section>`;
  return apricotSettingsPage("帮助与反馈", `
  <div class="stack">
  <section class="card"><h2>如果你正处于危机中</h2><p class="muted">涉及自伤自杀或重大财产损失时，系统会直接提供固定安全响应，并按规定联系监护人/紧急联系人。你也可拨打心理援助热线（如北京 010-82951332）或 110/120。</p></section>
  ${contactCard}
  <section class="card"><h2>数据与留存</h2><p class="muted">查看关系档案导出、原始互动保留设置和删除任务回执。</p><button class="btn btn-line" data-action="open-data" ${state.busy ? "disabled" : ""}>打开数据中心</button></section>
  <form id="emergency-contact-form" class="settings-panel stack"><h2>保存/更新紧急联系人</h2><label class="field"><span>姓名</span><input name="contact_name" maxlength="80" required value="${escapeHtml(contact?.contact_name ?? "")}"></label><label class="field"><span>与我的关系</span><input name="contact_relationship" maxlength="40" required placeholder="例如：朋友/监护人" value="${escapeHtml(contact?.relationship ?? "")}"></label><label class="field"><span>联系电话</span><input name="contact_phone" required placeholder="13800138000" value=""></label><label class="check-row"><input name="contact_consent" type="checkbox" required><span>我已知悉该联系人仅用于法规要求与生命健康或重大财产安全响应，不会用于其他用途。</span></label><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>保存联系人</button></form>
  <form id="complaint-form" class="settings-panel stack"><h2>举报 / 投诉 / 申诉</h2><label class="field"><span>类型</span><select name="complaint_kind" required><option value="REPORT_CONTENT">举报内容（需资源ID）</option><option value="SERVICE_COMPLAINT">服务投诉</option><option value="APPEAL">申诉</option></select></label><label class="field"><span>目标资源 ID（举报内容必填）</span><input name="complaint_target" maxlength="128" placeholder="例如 msg_000001"></label><label class="field"><span>说明</span><textarea name="complaint_description" maxlength="2000" rows="3" required></textarea></label><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>提交</button><p class="muted">提交内容默认不包含完整私聊；处理进度以提交编号为准。</p></form>
  ${state.lastComplaintId ? `<section class="card"><h2>最近提交</h2><p class="muted">编号 ${escapeHtml(state.lastComplaintId)}，可在服务端查询处理状态。</p></section>` : ""}
  <section class="card"><h2>账户注销</h2><p class="muted">注销后互动与召回立即停止；生产数据 24 小时内清理、备份最长 30 天，法定留存进入隔离库。此操作不可撤销。</p><button class="btn btn-danger" data-action="delete-account" ${state.busy ? "disabled" : ""}>注销账户</button></section>
  </div>`, { night: state.theme === "night" });
}

function renderContinuousReminder() {
  if (!state.continuousReminder) return "";
  return `<div class="reminder-overlay" role="alertdialog" aria-label="连续使用提醒"><section class="card reminder-card"><b>使用时长提醒</b><p>${escapeHtml(state.continuousReminder.text ?? "你已连续使用超过 2 小时，建议休息一下。")}</p><button class="btn btn-primary" data-action="dismiss-reminder">我知道了</button><p class="muted">该提醒由系统按时长规则触发，角色不能关闭或弱化它。</p></section></div>`;
}

const PROTOTYPE_ICON_PATHS = Object.freeze({
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  shield: '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z"/><path d="M9 12l2 2 4-4"/>',
  spark: '<path d="M12 3l1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4L12 3z"/>',
  archive: '<path d="M4 7h16v13H4zM3 3h18v4H3z"/><path d="M9 11h6"/>',
  check: '<path d="M5 12l4 4L19 6"/>', moon: '<path d="M20 15.5A8.5 8.5 0 118.5 4 7 7 0 0020 15.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3M9 21h6"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M12 10h.01M17 10h.01M7 14h.01M17 14h.01M10 14h4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 15l-4-4L5 20"/>',
  send: '<path d="M22 2L9 15M22 2l-7 20-6-7-7-3 20-10z"/>', chat: '<path d="M4 5h16v12H8l-4 4V5z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>', heart: '<path d="M20.8 5.8a5.5 5.5 0 00-7.8 0L12 6.8l-1-1a5.5 5.5 0 00-7.8 7.8L12 22l8.8-8.4a5.5 5.5 0 000-7.8z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>', chev: '<path d="M9 18l6-6-6-6"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
  phone: '<path d="M6.6 3h3l1.5 4.5-2 1.5a12 12 0 006 6l1.5-2L21 14.5v3A2.5 2.5 0 0118.2 20 15.5 15.5 0 014 5.8 2.5 2.5 0 016.6 3z"/>',
  bell: '<path d="M18 16H6c1.5-1.4 2.2-3.2 2.2-6a3.8 3.8 0 017.6 0c0 2.8.7 4.6 2.2 6z"/><path d="M10.3 19a1.8 1.8 0 003.4 0"/>',
  planList: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2"/><path d="M9 10h.01M12 10h.01M15 10h.01M9 14h.01M12 14h.01M15 14h.01M9 18h4"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/>', download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>', trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14"/>'
});

function prototypeIcon(name, size = 20) {
  if (APRICOT_ACTIONS[name]) return APRICOT_ACTIONS[name].replace('<svg ', '<svg aria-hidden="true" focusable="false" ').replace('width="24"', `width="${size}"`).replace('height="24"', `height="${size}"`).replace('stroke-width="2"', 'stroke-width="1.8"');
  if (name === "arrow" || name === "chev") return "";
  if (name === "back") return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PROTOTYPE_ICON_PATHS[name] ?? ""}</svg>`;
}

function prototypeShell(content, step) {
  return `<section class="screen qiyu-prototype paper"><header class="brandline"><span class="wordmark">栖语</span><span class="step">${escapeHtml(step)}</span></header><div class="orbit"></div>${content}</section>`;
}

function prototypeNav(active) { return apricotNav(active === "timeline" ? "assets" : active); }

function screen(content) { return `<section class="screen">${content}</section>`; }

function renderTrialLogin() {
  return prototypeShell(`<form id="trial-login-form"><div class="content"><h1 id="app-title">凭邀请进入，<br>安心试用。</h1><p class="lead">这是仅限受邀成年用户的免费封闭试用：不提供支付、不公开注册，也不代表正式上线。</p><div class="fact-grid"><article class="fact"><span class="fact-icon">${prototypeIcon("spark")}</span><div><strong>你正在与 AI 互动</strong><small>角色回复由 AI 生成并保留明显标识。</small></div></article><article class="fact"><span class="fact-icon">${prototypeIcon("shield")}</span><div><strong>仅向受邀成年用户开放</strong><small>登录后仍需完成系统告知与年龄声明。</small></div></article></div><label class="field"><span>邀请码</span><input name="invite_code" inputmode="latin" autocomplete="off" autocapitalize="characters" required placeholder="例如 QYXXXX-XXXXXX-XXXXXX-XXXXXX"></label><div class="bottom-action"><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>进入封闭试用 ${prototypeIcon("arrow", 18)}</button><div class="note">凭邀请码即可登录；本设备只需输入一次，之后直接进入。如需退出，可在数据中心退出试用会话或注销账户。</div></div><div class="rights">${prototypeIcon("lock", 17)}<span>登录凭据仅保留在本设备浏览器中（7 天内打开会自动续期）。请勿输入他人的隐私、证件或支付信息。</span></div></div></form>`, "封闭试用");
}

function renderError() {
  return screen(`<div class="topline"><span class="wordmark">栖语</span></div><div class="error-state"><h2 id="app-title">尚未取得服务端事实</h2><p>${escapeHtml(state.error)}</p><div class="flow-actions"><button class="btn btn-primary" data-action="retry-bootstrap">重试连接本地 API</button></div></div><p class="muted">未接入 API 时，本壳不会显示任何模拟年龄、记忆或删除成功状态。</p>`);
}

let chatScrollMemory = null; // 最近一次对话滚动几何 { top, height, viewport, messageCount }
let chatFollowBottom = true; // true=跟随最新消息；用户上滑回看历史时置 false
let chatPinToken = 0;

// 贴底必须"同步 + 两帧 rAF"各补一次：iOS WebKit 对刚插入元素的 scrollTop
// 赋值可能不生效（视图停在顶部=跳回最早对话），且随后键盘/图片加载还会
// 改变几何；token 保证只有最新一次贴底有效。
function pinChatToBottom(scroller) {
  scroller.scrollTop = scroller.scrollHeight;
  const token = ++chatPinToken;
  requestAnimationFrame(() => { if (token === chatPinToken) scroller.scrollTop = scroller.scrollHeight; });
  requestAnimationFrame(() => {
    if (token !== chatPinToken) return;
    scroller.scrollTop = scroller.scrollHeight;
    chatScrollMemory = { top: scroller.scrollTop, height: scroller.scrollHeight, viewport: scroller.clientHeight, messageCount: state.messages.length };
  });
}

// 多行输入框（2026-09-14）：textarea 随内容自动增高，到上限后内部滚动。
// 增长出的高度经 --qy-composer-extra 补进 .chat-scroll 的底部预留
// （输入行是 absolute 悬浮，长高会盖住最后一条消息），跟随模式下贴底。
const MESSAGE_INPUT_MAX_HEIGHT_PX = 112;
const MESSAGE_INPUT_BASE_HEIGHT_PX = 54;
function autosizeMessageInput(input = document.querySelector('#message-form textarea[name="message"]')) {
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, MESSAGE_INPUT_MAX_HEIGHT_PX)}px`;
  const extra = Math.max(0, input.offsetHeight - MESSAGE_INPUT_BASE_HEIGHT_PX);
  document.documentElement.style.setProperty("--qy-composer-extra", `${extra}px`);
  if (state.route === "chat" && chatFollowBottom) {
    const scroller = app.querySelector(".chat-scroll");
    if (scroller) pinChatToBottom(scroller);
  }
}

function render() {
  captureProfileDraft();
  invalidatePreparedMessageAudio();
  if (state.route !== 'chat') for (const audio of app.querySelectorAll('.voice-audio')) audio.pause();
  if (state.route !== 'chat' && state.messageAudioStream) {
    state.messageAudioStream.controller.abort();
    state.messageAudioStream.player.stopAll();
    state.messageAudioStream = null;
    state.synthesizingMessageId = null;
  }
  document.documentElement.dataset.qyTheme = state.theme;
  app.dataset.portrait = selectedPortrait().id;
  if (state.booting) { app.innerHTML = '<div class="boot-state"><span class="spinner" aria-hidden="true"></span><p>正在读取服务端状态…</p></div>'; return; }
  if (state.error) { app.innerHTML = renderError() + (state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ""); return; }
  app.dataset.route = state.route;
  const view = state.route === "home" ? renderHome()
    : state.route === "profile" ? renderProfile()
    : state.route === "trial-login" ? renderTrialLogin()
    : state.route === "notices" ? renderNotices()
    : state.route === "age" ? renderAge()
    : state.route === "character" ? renderCharacter()
    : state.route === "portrait-picker" ? renderPortraitPicker()
    : state.route === "oc-import" ? renderOcImport()
    : state.route === "character-profile" ? renderCharacterProfile()
    : state.route === "persona-versions" ? apricotPersonaVersions({ character: state.character, feedback: state.trialFeedback, busy: state.busy, night: state.theme === 'night', restore: state.personaRestore, feedbackDraft: state.personaFeedbackDraft })
    : state.route === "world-state" ? renderWorldState()
    : state.route === "candidate" ? renderCandidate()
    : state.route === "assets" ? renderAssets()
    : state.route === "data" ? renderDataCenter()
    : state.route === "asr" ? renderAsrInput()
    : state.route === "asr-confirm" ? renderAsrConfirm()
    : state.route === "image-reference" ? renderImageReference()
    : state.route === "image-scene" ? renderImageScene()
    : state.route === "subscription" ? renderSubscription()
    : state.route === "safety" ? renderSafety()
    : state.route === "notifications" ? renderNotifications()
    : state.route === "proactive" ? renderProactive()
    : state.route === "plans" ? renderPlans()
    : state.route === "call" ? renderCall()
    : renderChat();
  const undoMemory = state.lastRejectedCandidate ? `<div class="toast" role="status">已选择“不记住” <button class="btn btn-line" data-action="undo-memory-reject">撤销</button></div>` : "";
  // A1 覆盖层：来源面板与事件修订表单以 bottom-sheet 叠加在当前视图上。
  const overlaySheet = state.memoryRefsPanel
    ? `<div class="sheet-layer">${memoryReferenceSheet(state.memoryRefsPanel)}</div>`
    : state.revisingEvent
      ? `<div class="sheet-layer">${lifeEventReviseForm(state.revisingEvent, state.eventDraft ?? {})}</div>`
      : state.cardSheet
        ? `<div class="sheet-layer">${eventCardSheet(state.cardSheet)}</div>`
        : state.chatMenuOpen ? apricotChatMenu(prototypeIcon) : "";
  // 对话滚动记忆：整树重渲染会把 .chat-scroll 重置回顶部（此前发消息/播语音
  // 时页面“跳回第一次对话”的根因）。渲染前记录位置与消息数，渲染后——
  // 新消息或原本贴底 → 跟到最新消息；用户正回看历史 → 保持原阅读位置。
  const prevScroller = state.route === "chat" ? app.querySelector(".chat-scroll") : null;
  const scrollMemory = prevScroller
    ? { top: prevScroller.scrollTop, height: prevScroller.scrollHeight, viewport: prevScroller.clientHeight, messageCount: chatScrollMemory?.messageCount ?? state.messages.length }
    : null;
  const hadFocusedMessageInput = document.activeElement?.getAttribute?.("name") === "message";
  app.innerHTML = view + renderContinuousReminder() + undoMemory + overlaySheet + (state.toast ? `<div class="toast" role="status">${escapeHtml(state.toast)}</div>` : "");
  if (state.chatMenuOpen) {
    const backgroundScreen = app.querySelector('.screen');
    if (backgroundScreen) {
      backgroundScreen.inert = true;
      backgroundScreen.setAttribute("aria-hidden", "true");
    }
  }
  if (state.route === "chat") {
    const scroller = app.querySelector(".chat-scroll");
    if (scroller) {
      const grew = !scrollMemory || state.messages.length !== scrollMemory.messageCount;
      if (grew || chatFollowBottom || !scrollMemory || scrollMemory.height - scrollMemory.top - scrollMemory.viewport < 160) {
        chatFollowBottom = true;
        pinChatToBottom(scroller);
      } else {
        chatFollowBottom = false;
        scroller.scrollTop = Math.min(scrollMemory.top, scroller.scrollHeight);
        chatScrollMemory = { top: scroller.scrollTop, height: scroller.scrollHeight, viewport: scroller.clientHeight, messageCount: state.messages.length };
      }
    }
    // 全量重渲染会销毁聚焦的输入框（键盘反复弹收、几何抖动）；
    // 若之前正在输入，恢复焦点且不触发滚动。
    if (hadFocusedMessageInput) app.querySelector('#message-form [name="message"]')?.focus({ preventScroll: true });
    autosizeMessageInput();
    const holdButton = app.querySelector('[data-action="hold-asr"]');
    if (holdButton && state.asrRecording?.state === "recording") {
      holdButton.classList.add("recording");
      holdButton.dataset.recording = "true";
    }
    const note = app.querySelector(".system-note");
    const latestAssistant = [...state.messages].reverse().find((item) => (item.actor ?? item.role) === "ASSISTANT");
    if (note) note.insertAdjacentHTML("beforeend", `${state.worldState ? ` <button class="btn btn-line" data-action="open-world-state" ${state.busy ? "disabled" : ""}>查看当前情境</button>` : ""}${latestAssistant ? ` <button class="btn btn-line" data-action="report-latest-assistant-message" ${state.busy ? "disabled" : ""}>反馈最近回复</button>` : ""}`);
  }
  if (state.route === "safety" && state.lastComplaintId) {
    const submitted = [...app.querySelectorAll(".card")].find((card) => card.textContent.includes("最近提交"));
    if (submitted) submitted.insertAdjacentHTML("beforeend", ` <button class="btn btn-line" data-action="refresh-last-complaint" ${state.busy ? "disabled" : ""}>查询处理状态</button>`);
  }
  // A3 卡片惰性水合：渲染后扫描未水合的卡片壳，逐个拉取并定点替换节点
  // innerHTML——不触发 render()（组合输入/焦点/滚动不受打扰）。
  hydrateCompanionCards();
  refreshMessageAudioUi();
}

// 拉取卡片数据并定点替换 [data-artifact-id] 节点内容；失败节点显示受控
// 摘要+重试入口（§4.5 兜底），不整树重渲染。
function hydrateCompanionCards() {
  const nodes = [...app.querySelectorAll('.companion-card[data-artifact-id]:not([data-hydrated])')];
  for (const node of nodes) {
    const artifactId = node.dataset.artifactId;
    if (!artifactId) continue;
    node.dataset.hydrated = "pending";
    hydrateOneCard(artifactId, node);
  }
}

async function hydrateOneCard(artifactId, node) {
  const target = node ?? app.querySelector(`.companion-card[data-artifact-id="${CSS.escape(artifactId)}"]`);
  if (!target) return;
  let card = state.cardCache.get(artifactId);
  if (card === undefined) {
    try {
      const payload = await api(`/artifacts/${encodeURIComponent(artifactId)}`);
      card = unwrap(payload, "card", "card") ?? null;
      state.cardCache.set(artifactId, card);
    } catch {
      state.cardCache.set(artifactId, { failed: true });
      card = { failed: true };
    }
  }
  // 缓存命中后节点可能已被重渲染替换——重查当前节点再替换。
  const current = app.querySelector(`.companion-card[data-artifact-id="${CSS.escape(artifactId)}"]`);
  const destination = current ?? target;
  destination.dataset.hydrated = card?.failed ? "failed" : "done";
  destination.innerHTML = card?.failed ? companionCardFallback(artifactId) : companionCardBody(card);
}

document.addEventListener("change", (event) => {
  if (state.route === 'character-profile') captureProfileDraft();
  const id = event.target?.dataset?.noticeCheck;
  if (id) {
    if (event.target.checked) state.noticeChecks.add(id); else state.noticeChecks.delete(id);
    render();
  }
  // A3 草案步骤行内编辑：失焦/回车提交即 PATCH（计划聚合乐观锁）。
  const stepInput = event.target?.classList?.contains("step-title-input") ? event.target : null;
  if (stepInput) savePlanStepTitle(stepInput);
  if (event.target?.id === "asr-file") setAsrFile(event.target.files?.[0]);
  if (event.target?.id === "reference-image-file") setReferenceImageFile(event.target.files?.[0]);
  if (event.target?.id === "context-image-file") uploadContextImage(event.target.files?.[0]);
});

document.addEventListener('input', event => {
  if (state.route === 'character-profile') captureProfileDraft();
  if (event.target?.closest?.('#persona-version-feedback-form')) {
    const form = event.target.closest('form');
    state.personaFeedbackDraft = { version: Number(form.elements.feedback_version.value), rating: Number(form.elements.feedback_rating.value), note: form.elements.feedback_note.value };
  }
  if (event.target?.name === 'restore_reason' && state.personaRestore) state.personaRestore.reason = event.target.value;
});

document.addEventListener("pointerdown", (event) => {
  const button = event.target.closest('[data-action="hold-asr"]');
  if (!button || state.busy || state.asrRecording) return;
  event.preventDefault();
  state.asrHold = { pointerId: event.pointerId, startY: event.clientY, cancelled: false };
  button.classList.add("recording");
  startAsrRecording();
});
document.addEventListener("pointermove", (event) => {
  if (!state.asrHold || state.asrHold.pointerId !== event.pointerId) return;
  state.asrHold.cancelled = shouldCancelHold(state.asrHold.startY, event.clientY);
  document.querySelector('[data-action="hold-asr"]')?.classList.toggle("cancel", state.asrHold.cancelled);
  document.querySelector(".recording-indicator")?.classList.toggle("cancel", state.asrHold.cancelled);
});
document.addEventListener("pointerup", (event) => {
  if (!state.asrHold || state.asrHold.pointerId !== event.pointerId) return;
  state.asrHold.released = true;
  stopAsrRecording(state.asrHold.cancelled);
});
document.addEventListener("pointercancel", () => { if (state.asrHold) stopAsrRecording(true); });

document.addEventListener("input", (event) => {
  if (event.target?.id === "candidate-edit") state.confirmEdit = event.target.value;
  if (event.target?.id === "asr-edit") state.asrEdit = event.target.value;
  // 聊天草稿同步进 state：流式回复期间每次 chunk 都触发全量重渲染，
  // 不同步的话正在输入的文字会被 value=pendingTranscript 重置冲掉。
  if (event.target?.matches?.('#message-form textarea[name="message"]')) {
    state.pendingTranscript = event.target.value;
    autosizeMessageInput(event.target);
  }
});

// textarea 的 Enter 默认是换行不再触发 submit：Enter=发送（与原 input 一致），
// Shift+Enter 换行；isComposing/keyCode 229 是输入法组字确认，不能当发送。
document.addEventListener("keydown", (event) => {
  if (!event.target?.matches?.('#message-form textarea[name="message"]')) return;
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (state.busy) return;
  event.target.closest("form")?.requestSubmit();
});

document.addEventListener("submit", (event) => {
  if (event.target.id === "trial-login-form") { event.preventDefault(); submitTrialLogin(event.target); }
  if (event.target.id === "age-form") { event.preventDefault(); submitAge(event.target); }
  if (event.target.id === "character-form") { event.preventDefault(); createCharacter(event.target); }
  if (event.target.id === "oc-import-form") { event.preventDefault(); submitOcImport(event.target); }
  if (event.target.id === "persona-form") { event.preventDefault(); saveCharacterProfile(event.target); }
  if (event.target.id === "preferences-form") { event.preventDefault(); savePreferences(event.target); }
  if (event.target.id === 'persona-version-feedback-form') { event.preventDefault(); submitPersonaVersionFeedback(event.target); }
  if (event.target.id === 'persona-restore-form') { event.preventDefault(); restorePersonaVersion(event.target); }
  if (event.target.id === "world-state-form") { event.preventDefault(); saveWorldState(event.target); }
  if (event.target.id === "message-form") { event.preventDefault(); sendMessage(event.target); }
  if (event.target.id === "reference-image-form") { event.preventDefault(); uploadReferenceImage(event.target); }
  if (event.target.id === "image-scene-form") { event.preventDefault(); submitImageScene(event.target); }
  if (event.target.id === "emergency-contact-form") { event.preventDefault(); saveEmergencyContact(event.target); }
  if (event.target.id === "complaint-form") { event.preventDefault(); submitComplaint(event.target); }
  if (event.target.id === "proactive-preferences-form") { event.preventDefault(); saveProactivePreferences(event.target); }
  if (event.target.id === "proactive-event-form") { event.preventDefault(); createProactiveEvent(event.target); }
  if (event.target.id === "trial-feedback-form") { event.preventDefault(); submitTrialFeedback(event.target); }
});

document.addEventListener("click", (event) => {
  const filterButton = event.target.closest("[data-timeline-filter]");
  if (filterButton) { setTimelineFilter(filterButton.dataset.timelineFilter); return; }
  const templateButton = event.target.closest("[data-template]");
  if (templateButton) {
    const form = templateButton.closest("form");
    selectPersonaTemplate(form, templateButton.dataset.template);
  }
});

function closeChatMenu({ restoreFocus = true } = {}) {
  if (!state.chatMenuOpen) return;
  state.chatMenuOpen = false;
  render();
  if (restoreFocus) app.querySelector('[data-action="open-chat-menu"]')?.focus();
}

document.addEventListener('keydown', event => {
  if (!state.chatMenuOpen) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeChatMenu();
  } else if (event.key === 'Tab') {
    const buttons = [...app.querySelectorAll('.apricot-chat-menu button:not(:disabled)')];
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});

document.addEventListener("click", (event) => {
  if (event.target.classList?.contains("apricot-chat-menu-layer") && !state.busy) { closeChatMenu(); return; }
  const button = event.target.closest("[data-action]");
  if (!button || state.busy) return;
  const action = button.dataset.action;
  const secondaryRoutes = { 'open-character-profile':'character-profile', 'open-persona-versions':'persona-versions', 'open-data':'data', 'open-safety':'safety', 'open-notifications':'notifications', 'open-subscription':'subscription', 'open-proactive':'proactive', 'open-world-state':'world-state', 'open-plans':'plans', 'open-candidate':'candidate' };
  const destination = secondaryRoutes[action];
  if (destination && state.route !== destination) state.secondaryParents[destination] = state.route;
  if (action === 'back-notifications') { state.route = state.notificationsOrigin || 'home'; render(); }
  if (action === 'profile-step') { const step = Number(button.dataset.step); if (Number.isInteger(step) && step >= 0 && step <= 3) { captureProfileDraft(); state.profileStep = step; render(); } }
  if (action === 'open-persona-versions') openPersonaVersions();
  if (action === 'prepare-persona-restore') {
    const version = Number(button.dataset.version);
    if (state.character?.persona_restore_supported && state.character.persona_history?.some(entry => entry.version === version && entry.state === 'RETIRED')) {
      state.personaRestore = { version, expectedVersion: state.character.version, reason: '' }; render();
      app.querySelector('#persona-restore-form textarea')?.focus();
    }
  }
  if (action === 'cancel-persona-restore') { state.personaRestore = null; render(); }
  if (["home", "chat", "assets", "profile"].includes(state.route) && ["open-character-profile", "open-proactive", "open-subscription", "open-data", "open-safety", "open-plans", "open-world-state", "open-notifications", "open-candidate"].includes(action)) state.secondaryOrigin = state.route;
  if (action !== "open-chat-menu" && state.chatMenuOpen) closeChatMenu({ restoreFocus: false });
  if (action === "open-home") { state.route = "home"; render(); }
  if (action === "open-profile") { state.route = "profile"; render(); }
  if (action === "open-chat-menu") { document.activeElement?.blur(); state.chatMenuOpen = true; render(); app.querySelector('.apricot-chat-menu [data-action="close-chat-menu"]')?.focus(); }
  if (action === "close-chat-menu") app.querySelector('[data-action="open-chat-menu"]')?.focus();
  if (action === "latest-memory-refs") { const m = [...state.messages].reverse().find(m => (m.actor ?? m.role)?.toUpperCase() === "ASSISTANT"); if (m) openMemoryReferences(messageId(m)); else setToast("还没有可以查看的回复。"); }
  if (action === "share-moment") { state.route = "chat"; render(); app.querySelector("#context-image-file")?.click(); }
  if (action === "remember-in-chat") { state.route = "chat"; render(); setToast("把想记住的小事说给他听，候选回忆仍由你确认。"); }
  if (action === "focus-home-memories") app.querySelector(".apricot-lower")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  if (action === "retry-bootstrap") bootstrap();
  if (action === "trial-logout") logoutTrial();
  if (action === "submit-notices") submitNotices();
  if (action === "reload-age") refreshAge().then(() => render()).catch((error) => setToast(serverMessage(error)));
  if (action === "request-age-appeal") requestAgeAppeal();
  if (action === "continue-character") { state.route = "character"; render(); }
  if (action === "open-oc-import") { state.route = "oc-import"; render(); }
  if (action === "back-character") { state.route = "character"; render(); }
  if (action === "refresh-oc-rights") refreshOcRightsReview();
  if (action === "appeal-oc-rights") appealOcRightsReview();
  if (action === "create-from-oc-import") createCharacterFromApprovedOcImport();
  if (action === "open-portrait-picker") {
    const form = app.querySelector('#character-form, #persona-form');
    state.portraitFormDraft = form ? { id: form.id, fields: [...form.elements].filter((field) => field.name && field.type !== 'file').map((field) => ({ name: field.name, value: field.value, checked: field.checked })) } : null;
    state.portraitReturnRoute = state.route;
    state.route = "portrait-picker";
    render();
  }
  if (action === "close-portrait-picker") {
    state.route = state.portraitReturnRoute;
    render();
    const draft = state.portraitFormDraft;
    const form = draft ? document.getElementById(draft.id) : null;
    if (form) for (const saved of draft.fields) {
      const field = form.elements.namedItem(saved.name);
      if (!field) continue;
      field.value = saved.value;
      if (typeof saved.checked === 'boolean') field.checked = saved.checked;
    }
    state.portraitFormDraft = null;
  }
  if (action === "choose-portrait") {
    const id = button.dataset.portraitId;
    if (!CHARACTER_PORTRAITS.some((portrait) => portrait.id === id)) return;
    state.portraitDraft = id;
    if (characterId()) {
      state.portraitSelections.set(characterId(), id);
      try { if (!savePortraitId(characterId(), id, window.localStorage)) setToast("形象已切换；浏览器未能保存，下次打开需重新选择。"); } catch { setToast("形象已切换；浏览器未能保存，下次打开需重新选择。"); }
    }
    render();
  }
  if (action === "toggle-theme") { state.theme = state.theme === "day" ? "night" : "day"; render(); }
  if (action === "open-assets") { state.route = "assets"; render(); }
  if (action === "open-character-profile") openCharacterProfile();
  if (action === "open-world-state") openWorldState();
  if (action === "reset-world-state") resetWorldState();
  if (action === "open-safety") openSafetyCenter();
  if (action === "open-notifications") openNotifications();
  if (action === "read-notification") markNotificationRead(button.dataset.notificationId);
  if (action === "open-data") openDataCenter();
  if (action === "refresh-last-complaint") refreshLastComplaint();
  if (action === "report-latest-assistant-message") reportLatestAssistantMessage();
  if (action === "praise-latest-assistant-message") {
    const latest = [...state.messages].reverse().find(message => (message.actor ?? message.role)?.toUpperCase() === "ASSISTANT");
    if (latest) praiseMessage(messageId(latest)); else setToast("还没有可以反馈的回复。");
  }
  if (action === "praise-message") praiseMessage(button.dataset.messageId);
  if (action === "purchase-plan") purchasePlan(button.dataset.sku, button.dataset.autorenew === "true");
  if (action === "start-trial") startTrial();
  if (action === "cancel-renewal") cancelRenewal();
  if (action === "open-proactive") openProactive();
  if (action === "resume-interaction") resumeInteraction();
  if (action === "delete-proactive") deleteProactiveEvent(button.dataset.eventId);
  if (action === "trigger-proactive") triggerProactiveEvent(button.dataset.eventId);
  if (action === "toggle-event-followup") toggleEventFollowup(button);
  if (action === "regrant-followup") regrantFollowup();
  if (action === "dismiss-regrant") { state.pendingFollowupRegrant = null; render(); }
  // 六项能力 A3：计划页/卡片动作/时间线事件卡入口。
  if (action === "open-plans") openPlans();
  if (action === "plan-accept") planAccept(button);
  if (action === "plan-action") planAction(button);
  if (action === "toggle-plan-step") togglePlanStep(button);
  if (action === "plan-create-draft") createPlanForEvent(button.dataset.eventId || null);
  if (action === "create-plan-for-event") createPlanForEvent(button.dataset.eventId || null);
  if (action === "card-action") runCardAction(button);
  if (action === "open-event-card") openEventCard(button.dataset.artifactId);
  if (action === "close-card-sheet") { state.cardSheet = null; render(); }
  if (action === "export-card") exportCard(button.dataset.artifactId);
  if (action === "reload-card") { state.cardCache.delete(button.dataset.artifactId); render(); }
  if (action === "remove-emergency-contact") removeEmergencyContact();
  if (action === "delete-account") deleteAccount();
  if (action === "dismiss-reminder") { state.continuousReminder = null; render(); }
  if (action === "back-chat") { state.route = button.closest('.bottom-nav') ? "chat" : state.secondaryParents[state.route] ?? state.secondaryOrigin; render(); }
  if (action === "start-call") startVoiceCall();
  if (action === "call-mute") toggleCallMute();
  if (action === "call-interrupt") { if (typeof callClient?.bargeIn === "function") callClient.bargeIn(); else if (callClient?.stopPlayback) { if (callClient.replyId) callClient.blockedReplies.add(callClient.replyId); callClient.stopPlayback(); callClient.setPhase("ready"); } }
  if (action === "call-hangup") hangupCall();
  if (action === "open-asr") { state.route = "asr"; render(); }
  if (action === "enter-voice-mode") { state.composerVoice = true; render(); }
  if (action === "exit-voice-mode") { state.composerVoice = false; render(); }
  if (action === "open-image") { state.route = referenceImageUsable() ? "image-scene" : "image-reference"; render(); }
  if (action === "refresh-reference-rights") refreshReferenceRightsReview();
  if (action === "appeal-reference-rights") appealReferenceRightsReview();
  if (action === "open-subscription") openSubscription();
  if (action === "back-asr") { state.asrFile = null; state.asrJob = null; state.asrEdit = ""; state.route = "asr"; render(); }
  if (action === "create-asr-job") createAsrJob();
  if (action === "confirm-asr") confirmAsrTranscript();
  if (action === "delete-failed-asr-input") deleteFailedAsrInput();
  if (action === "start-asr-recording") startAsrRecording();
  if (action === "stop-asr-recording") stopAsrRecording();
  if (action === "remove-context-image") removePendingContextImage();
  if (action === "delete-context-image") deleteAttachedContextImage(button.dataset.assetId);
  if (action === "refresh-image-job") refreshImageJob();
  if (action === "replace-reference-image") { state.referenceImageFile = null; state.referenceImageAsset = null; state.referenceRightsReview = null; state.imageJob = null; clearGeneratedImage(); state.route = "image-reference"; render(); }
  if (action === "delete-generated-image") deleteGeneratedImage();
  if (action === "refresh-chat") refreshMemoryAndAssets().then(() => render()).catch((error) => setToast(serverMessage(error)));
  if (action === "refresh-assets") refreshMemoryAndAssets().then(() => render()).catch((error) => setToast(serverMessage(error)));
  if (action === "download-relationship-profile") downloadRelationshipProfile();
  if (action === "set-retention-30") setRawInteractionRetention(30);
  if (action === "set-retention-90") setRawInteractionRetention(90);
  if (action === "delete-conversation") deleteCurrentConversation();
  if (action === "open-candidate") {
    state.selectedCandidate = state.candidates.find((candidate) => String(candidateId(candidate)) === button.dataset.candidateId) ?? null;
    state.confirmEdit = state.selectedCandidate?.display_text ?? state.selectedCandidate?.normalized_value ?? "";
    state.route = "candidate";
    render();
  }
  if (action === "confirm-inline-candidate" || action === "reject-inline-candidate") {
    state.selectedCandidate = state.candidates.find(candidate => String(candidateId(candidate)) === button.dataset.candidateId) ?? null;
    if (state.selectedCandidate) resolveCandidate(action === "confirm-inline-candidate" ? "confirm" : "reject");
  }
  if (action === "confirm-candidate") resolveCandidate("confirm");
  if (action === "confirm-edited-candidate") resolveCandidate("confirm-edited");
  if (action === "reject-candidate") resolveCandidate("reject");
  if (action === "undo-memory-reject") undoCandidateRejection();
  // ---- 生活事件（六项能力 A1）：来源面板 / 事件修订 / 事件删除 ----
  if (action === "open-memory-refs") openMemoryReferences(button.dataset.messageId);
  if (action === "close-memory-refs") { state.memoryRefsPanel = null; render(); }
  if (action === "revise-event") {
    state.revisingEvent = (state.timeline ?? []).find((entry) => entry.entry_type === "LIFE_EVENT" && String(entry.event_id) === button.dataset.eventId) ?? null;
    state.eventDraft = null;
    render();
  }
  if (action === "close-event-revision") { state.revisingEvent = null; state.eventDraft = null; render(); }
  if (action === "submit-event-revision") submitEventRevision(button.dataset.eventId, Number(button.dataset.expectedVersion));
  if (action === "delete-event") deleteLifeEventAction((state.timeline ?? []).find((entry) => entry.entry_type === "LIFE_EVENT" && String(entry.event_id) === button.dataset.eventId));
  if (action === "delete-asset") deleteAsset(state.assets.find((asset) => String(assetId(asset)) === button.dataset.assetId));
  if (action === "revise-asset") reviseTimelineAsset((state.timeline ?? []).find((entry) => String(entry.asset_id) === button.dataset.assetId));
  if (action === "refresh-deletion") refreshDeletionJob();
  if (action === "synthesize-message-audio") synthesizeMessageAudio(state.messages.find((message) => String(messageId(message)) === button.dataset.messageId));
  if (action === "toggle-message-audio") toggleMessageAudio(button.dataset.messageId);
  if (action === "delete-message-audio") deleteMessageAudio(state.messages.find((message) => String(messageId(message)) === button.dataset.messageId));
});

// 对话滚动交互（capture 监听 #app 内所有滚动）：用户上滑离开底部 → 停止跟随
// 并刷新记忆（render 保持其阅读位置）；滚回底部 → 恢复跟随。
app.addEventListener("scroll", (event) => {
  if (state.route !== "chat") return;
  const scroller = event.target;
  if (!(scroller instanceof Element) || !scroller.classList.contains("chat-scroll")) return;
  const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  chatScrollMemory = { top: scroller.scrollTop, height: scroller.scrollHeight, viewport: scroller.clientHeight, messageCount: state.messages.length };
  if (distance > 160) chatFollowBottom = false;
  else if (!chatFollowBottom && distance <= 160) chatFollowBottom = true;
}, true);
// WebKit 没有滚动锚定：聊天图片等 blob 异步加载完成会在视口上方撑高内容，
// 把画面顶离最新消息；跟随模式下图片加载完成后重新贴底。
app.addEventListener("load", (event) => {
  if (state.route !== "chat" || !chatFollowBottom) return;
  if (!(event.target instanceof HTMLImageElement) || !event.target.closest(".chat-scroll")) return;
  const scroller = app.querySelector(".chat-scroll");
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}, true);

// 软键盘处理（2026-09-13 修复）：安卓各家内核对键盘的视口响应不一致——有的压缩
// 布局视口（innerHeight 变小），有的只缩可视视口（visualViewport.height 变小），
// 还有的 100dvh 滞后不缩，文档比可视区高出一截，输入行与键盘之间露出页面尾巴
// （聊天流尾部/空背景）。这里以“宽度不变的前提下高度大幅缩短”识别键盘（放大
// 视为缩放不算），统一按 visualViewport 实际可视高度重设对话屏高度，文档链路
// （body/.device-shell/.app）同步收缩避免文档滚动；等量 inset 写入
// --qy-keyboard-inset 让导航栏藏到键盘后。
const KEYBOARD_INSET_THRESHOLD_PX = 150;
const DEV_BANNER_FALLBACK_HEIGHT = 28;
const KEYBOARD_MIN_APP_HEIGHT_PX = 120;
let keyboardBaseline = { width: window.innerWidth, height: window.innerHeight };
function syncKeyboardInset() {
  if (window.innerWidth !== keyboardBaseline.width) keyboardBaseline = { width: window.innerWidth, height: window.innerHeight };
  const visual = window.visualViewport;
  const focused = document.activeElement;
  const editing = Boolean(focused?.isContentEditable || focused?.matches?.('textarea:not([readonly]):not([disabled]), input:not([readonly]):not([disabled]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])'));
  // 双指缩放时 visual.height 也会变小，scale>1 视为缩放而非键盘。
  const zoomed = Number(visual?.scale ?? 1) > 1.01;
  const shrink = Math.max(0,
    keyboardBaseline.height - window.innerHeight,
    visual && !zoomed ? keyboardBaseline.height - visual.height : 0,
  );
  const open = editing && window.innerWidth === keyboardBaseline.width && shrink > KEYBOARD_INSET_THRESHOLD_PX;
  const root = document.documentElement;
  root.style.setProperty("--qy-keyboard-inset", open ? `${Math.round(shrink)}px` : "0px");
  if (open && visual) {
    const banner = document.querySelector(".dev-banner");
    const chrome = banner ? banner.offsetHeight : DEV_BANNER_FALLBACK_HEIGHT;
    root.style.setProperty("--qy-app-height", `${Math.max(KEYBOARD_MIN_APP_HEIGHT_PX, Math.round(visual.height) - chrome)}px`);
  } else {
    root.style.removeProperty("--qy-app-height");
  }
  document.body.classList.toggle("qy-keyboard-open", open);
  if (!open) keyboardBaseline.height = window.innerHeight;
  // 键盘开合只改 CSS 变量、不走 render，但 .chat-scroll 的可视高度已变：
  // 跟随模式下重新贴底，否则画面停留在"离底一个键盘高度"的位置。
  if (state.route === "chat" && chatFollowBottom) {
    const scroller = app.querySelector(".chat-scroll");
    if (scroller) pinChatToBottom(scroller);
  }
}
window.addEventListener("resize", syncKeyboardInset);
window.visualViewport?.addEventListener("resize", syncKeyboardInset);
document.addEventListener("focusin", syncKeyboardInset);
document.addEventListener("focusout", () => requestAnimationFrame(syncKeyboardInset));
syncKeyboardInset();

loadTrialSession().then((session) => {
  state.trialSession = session;
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || isLocalDevelopment())) navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  return bootstrap();
});
