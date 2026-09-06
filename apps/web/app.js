const API_BASE = "/api/v1";
const DEVELOPMENT_BEARER_TOKEN = "dev-alice-token";
const TRIAL_SESSION_STORAGE_KEY = "qiyu.closed-trial.session.v1";
const app = document.querySelector("#app");

// Only opaque closed-trial tokens live in sessionStorage. Product facts and
// personal interaction data are always reloaded from the API.
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
  theme: "day",
  selectedCandidate: null,
  confirmEdit: "",
  asrFile: null,
  asrJob: null,
  asrEdit: "",
  asrRecording: null,
  pendingTranscript: "",
  subscriptionCatalog: null,
  audioUrls: new Map(),
  referenceImageFile: null,
  referenceImageAsset: null,
  referenceRightsReview: null,
  imageJob: null,
  generatedImage: null,
  lastTtsJob: null,
  ocImport: null,
  ocRightsReview: null,
  noticeChecks: new Set(),
  toast: null,
  emergencyContact: null,
  continuousReminder: null,
  heartbeatTimer: null,
  lastComplaintId: null,
  trialAccess: null,
  trialSession: loadTrialSession(),
  trialFeedback: [],
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

function loadTrialSession() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(TRIAL_SESSION_STORAGE_KEY) || "null");
    return parsed && typeof parsed.access_token === "string" && typeof parsed.refresh_token === "string" ? parsed : null;
  } catch { return null; }
}

function saveTrialSession(tokens) {
  state.trialSession = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in };
  sessionStorage.setItem(TRIAL_SESSION_STORAGE_KEY, JSON.stringify(state.trialSession));
}

function clearTrialSession() {
  state.trialSession = null;
  sessionStorage.removeItem(TRIAL_SESSION_STORAGE_KEY);
}

function isClosedTrial() { return state.trialAccess?.enabled === true; }

function bearerToken() {
  if (isClosedTrial()) return state.trialSession?.access_token || null;
  return isLocalDevelopment() ? DEVELOPMENT_BEARER_TOKEN : null;
}

function authenticatedHeaders(accept) {
  const token = bearerToken();
  if (!token) throw apiError("试用会话已失效，请重新输入邀请码和初始口令。", 401);
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

async function apiAudio(path) {
  const response = await fetch(`${API_BASE}${path}`, { headers: authenticatedHeaders("audio/mpeg") });
  if (!response.ok || response.headers.get("content-type") !== "audio/mpeg") {
    throw apiError(`语音读取失败（HTTP ${response.status}）`, response.status);
  }
  return URL.createObjectURL(await response.blob());
}

async function apiImage(path) {
  const response = await fetch(`${API_BASE}${path}`, { headers: authenticatedHeaders("image/jpeg,image/png,image/webp") });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    throw apiError(`图片读取失败（HTTP ${response.status}）`, response.status);
  }
  return URL.createObjectURL(await response.blob());
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

function setBusy(busy) { state.busy = busy; render(); }

function serverMessage(error) {
  if (error.status === 428) return "服务端仍要求完成必要告知；请刷新告知状态后继续。";
  if (error.status === 401) return isClosedTrial() ? "试用会话已失效，请重新输入邀请码和初始口令。" : "开发 Token 未被本地 API 接受；请检查 API 的合成账户配置。";
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
  state.conversation = conversationList.filter((item) => item.status === "OPEN").pop() ?? null;
  if (conversationId()) {
    const history = await api(`/conversations/${encodeURIComponent(conversationId())}/messages?limit=50`);
    state.messages = unwrap(history, "messages", "messages") ?? [];
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
    if (isClosedTrial()) {
      if (!state.trialSession?.refresh_token) {
        state.route = "trial-login";
        return;
      }
      try {
        const refreshed = await api("/auth/trial-sessions/refresh", { method: "POST", public: true, body: { refresh_token: state.trialSession.refresh_token } });
        saveTrialSession(refreshed.tokens);
      } catch {
        clearTrialSession();
        state.route = "trial-login";
        return;
      }
    }
    await Promise.all([refreshNotices(), refreshAge()]);
    if (noticeReady() && isAgePass()) {
      await restoreSession();
      state.route = characterId() ? "chat" : "character";
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
  const initialSecret = form.elements.initial_secret.value.trim();
  if (!inviteCode || !initialSecret) return;
  setBusy(true);
  try {
    const result = await api("/auth/trial-sessions", { method: "POST", public: true, body: { invite_code: inviteCode, initial_secret: initialSecret } });
    saveTrialSession(result.tokens);
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

function personaFromForm(form) {
  const lines = (value) => value.split("\n").map((line) => line.trim()).filter(Boolean);
  return {
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
    state.route = "character-profile";
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function saveCharacterProfile(form) {
  if (!characterId() || !state.character) return;
  setBusy(true);
  try {
    const nextName = form.elements.character_name.value.trim();
    if (nextName !== state.character.name) {
      const renamed = await api(`/characters/${encodeURIComponent(characterId())}`, {
        method: "PATCH", idempotent: uuid(), body: { expected_version: state.character.version, name: nextName, note: "角色档案页改名" },
      });
      state.character = unwrap(renamed, "character", null) ?? renamed;
    }
    const draft = await api(`/characters/${encodeURIComponent(characterId())}/persona-versions`, {
      method: "POST", idempotent: uuid(), body: { expected_version: state.character.version, persona: personaFromForm(form), note: "角色档案页人格草稿" },
    });
    state.character = unwrap(draft, "character", null) ?? state.character;
    await openCharacterProfile();
    setToast(`人格草稿 v${draft.persona_version?.version ?? ""} 已创建，当前稳定人格未改变，等待评测与灰度发布。`);
  } catch (error) {
    setToast(serverMessage(error));
  } finally { setBusy(false); }
}

async function ensureConversation() {
  if (conversationId()) return state.conversation;
  const payload = await api("/conversations", { method: "POST", idempotent: uuid(), body: { character_id: characterId() } });
  state.conversation = unwrap(payload, "conversation", null) ?? payload;
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
  const content = input.value.trim();
  if (!content) return;
  setBusy(true);
  try {
    await ensureConversation();
    // stream:true：服务端配置了流式生成器时返回 202+一次性令牌，SSE 为真流式
    // （逐句审核后下发）；未配置时服务端回退 201 同步合同，走同一渲染路径。
    const payload = await api(`/conversations/${encodeURIComponent(conversationId())}/messages`, {
      method: "POST", idempotent: uuid(), body: { content: { text: content }, stream: true },
    });
    input.value = "";
    state.pendingTranscript = "";
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
      } else if (terminalEvent === "failed") {
        // 失败的临时片段不是完整 AI 回复，不保留在对话里。
        // 恢复用户输入并用 toast 说明原因，便于原样重试。
        const index = state.messages.indexOf(streaming);
        if (index >= 0) state.messages.splice(index, 1);
        input.value = content;
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

async function synthesizeMessageAudio(message) {
  const id = messageId(message);
  if (!id) return;
  setBusy(true);
  try {
    const payload = await api(`/messages/${encodeURIComponent(id)}/tts-jobs`, { method: "POST", idempotent: uuid(), body: {} });
    const job = payload?.tts_job ?? payload;
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
    const previous = state.audioUrls.get(id);
    if (previous?.url) URL.revokeObjectURL(previous.url);
    const url = await apiAudio(`/media-assets/${encodeURIComponent(job.result_asset_id)}/content`);
    state.audioUrls.set(id, { assetId: job.result_asset_id, url });
    setToast("AI 生成语音已准备好播放。");
  } catch (error) {
    state.lastTtsJob = { messageId: id, state: "FAILED", failure_code: error.payload?.error?.code ?? "TTS_REQUEST_FAILED" };
    setToast(`${serverMessage(error)}；文字回复仍可正常阅读。`);
  } finally { setBusy(false); }
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
    setToast(state.referenceRightsReview?.state === "APPROVED"
      ? "权利审核已显示为通过；仍需由审核服务激活参考资产后才能生图。"
      : `当前权利审核状态：${state.referenceRightsReview?.state ?? "未返回"}。`);
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
    if (state.imageJob?.state === "PENDING") setToast("图片任务已提交。请手动刷新任务状态；生成期间不会展示供应商临时链接。");
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
  if (!message || !messageId(message)) return;
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
  const eventCards = (state.proactiveEvents ?? []).map((event) => `<article class="asset"><div><b>${escapeHtml(event.title)}</b><small>${escapeHtml(event.type)}${event.due_at ? " · " + escapeHtml(new Date(event.due_at).toLocaleDateString()) : ""}</small></div><div class="button-row"><button class="btn btn-line" data-action="trigger-proactive" data-event-id="${escapeHtml(event.event_id)}" ${state.busy ? "disabled" : ""}>模拟触发</button><button class="btn btn-danger" data-action="delete-proactive" data-event-id="${escapeHtml(event.event_id)}" ${state.busy ? "disabled" : ""}>删除</button></div></article>`).join("");
  const messageCards = (state.proactiveMessages ?? []).map((message) => `<article class="asset"><div><b>${escapeHtml(message.kind === "SYSTEM" ? "系统通知" : "角色主动消息")}</b><small>${escapeHtml(new Date(message.sent_at).toLocaleString())}</small><p class="muted">${escapeHtml(message.text)}</p></div></article>`).join("");
  return screen(`<div class="topline"><button class="btn btn-line" data-action="back-chat">返回对话</button><span class="dev-label">Proactive</span></div><div class="eyebrow">Proactive messages</div><h1 id="app-title">主动消息</h1><p class="lead">是否发送由规则引擎决定，模型只负责措辞；默认且最高每日 1 条，付费不会提高频率。</p>
  <form id="proactive-preferences-form" class="stack"><b>偏好</b><label class="check-row"><input name="proactive_enabled" type="checkbox" ${preferences.enabled ? "checked" : ""}><span>允许普通主动消息（早安/晚安、纪念日、约定）</span></label><div class="button-row"><label class="field"><span>静默开始</span><select name="quiet_start">${hourOptions(preferences.quiet_start_hour)}</select></label><label class="field"><span>静默结束</span><select name="quiet_end">${hourOptions(preferences.quiet_end_hour)}</select></label></div><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>保存偏好</button></form>
  <form id="proactive-event-form" class="stack"><b>新建事件</b><label class="field"><span>类型</span><select name="event_type"><option value="SUBSCRIBED_MORNING">早安订阅</option><option value="SUBSCRIBED_EVENING">晚安订阅</option><option value="CONFIRMED_ANNIVERSARY">纪念日</option><option value="CONFIRMED_BIRTHDAY">生日</option><option value="CONFIRMED_APPOINTMENT">约定</option></select></label><label class="field"><span>标题</span><input name="event_title" maxlength="80" required placeholder="例如：在一起一百天"></label><label class="field"><span>日期（纪念日/生日可选）</span><input name="event_due_at" type="date"></label><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>创建事件</button></form>
  <div class="stack"><b>我的事件</b>${eventCards || '<div class="empty-state">暂无主动事件。</div>'}</div>
  <div class="stack"><b>已发送记录</b>${messageCards || '<div class="empty-state">还没有已发送的主动消息。</div>'}</div>`);
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
      state.asrEdit = state.asrJob.transcript.text;
      state.route = "asr-confirm";
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
    const deleted = payload?.input_audio_deletion?.physical_cleanup_state === "LOCAL_PRIVATE_OBJECT_DELETED";
    state.route = "chat";
    setToast(deleted ? "转写已确认，原始音频已删除；请检查文字后手动发送。" : "转写已确认；原始音频删除仍需服务端处理。请检查文字后手动发送。");
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
  if (!globalThis.MediaRecorder) return null;
  return ["audio/ogg;codecs=opus", "audio/ogg"].find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

async function startAsrRecording() {
  const mimeType = recordingMimeType();
  if (!mimeType || !navigator.mediaDevices?.getUserMedia) {
    setToast("当前浏览器不能录制腾讯短语音兼容格式；请导入 WAV、MP3、M4A、AAC 或 OGG 文件。");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
    recorder.addEventListener("stop", () => {
      stream.getTracks().forEach((track) => track.stop());
      state.asrRecording = null;
      setAsrFile(new File([new Blob(chunks, { type: "audio/ogg" })], `qiyu-${Date.now()}.ogg`, { type: "audio/ogg" }));
    }, { once: true });
    state.asrRecording = recorder;
    recorder.start();
    render();
  } catch {
    setToast("浏览器未授予麦克风权限；你也可以导入一段短音频。");
  }
}

function stopAsrRecording() { if (state.asrRecording?.state === "recording") state.asrRecording.stop(); }

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
    body = { expected_version: expectedVersion, display_text: editedText };
  }
  setBusy(true);
  try {
    await api(path, body === undefined ? { method: "POST", idempotent: uuid() } : { method: "POST", idempotent: uuid(), body });
    state.selectedCandidate = null;
    state.confirmEdit = "";
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
    return `<label class="check-row"><input type="checkbox" data-notice-check="${escapeHtml(id)}" ${state.noticeChecks.has(id) ? "checked" : ""}><span>我已阅读并理解系统告知（${escapeHtml(notice.notice_version ?? "当前版本")}）。</span></label>`;
  }).join("");
  return prototypeShell(`<div class="content"><div class="eyebrow">Before we begin</div><h1 id="app-title">先说清楚，<br>我们才能开始。</h1><p class="lead">栖语提供由 AI 生成的长期角色互动。它可以记住经你确认的关系资产，但不是现实中的人，也不能替代专业支持。</p><div class="fact-grid">${facts}</div><div class="check-list">${noticeChecks || '<div class="empty-state">服务端未返回必要告知，普通互动保持不可用。</div>'}</div></div><div class="bottom-action"><button class="btn btn-primary" data-action="submit-notices" ${allChecked && !state.busy ? "" : "disabled"}>同意并继续 ${prototypeIcon("arrow", 18)}</button><div class="note">此告知属于系统界面；只有 API 记录展示回执后才会解除门槛。</div></div>`, "01 / 03");
}

function renderAge() {
  const status = ageStatus();
  const blocked = status !== "AGE_UNVERIFIED";
  const detail = status === "AGE_PASS" ? "账号已获得 18+ 服务访问资格。" : status === "AGE_REVIEW" ? "当前处于增强核验等待态，普通互动保持关闭。" : status === "AGE_DENIED_MINOR" ? "未成年人不可使用虚拟伴侣服务；数据权利不因此被阻断。" : "信息只提交给服务端进行确定性年龄判断。";
  const form = blocked
    ? (status === "AGE_PASS" ? '<button class="btn btn-primary" data-action="continue-character">创建我的角色 ${prototypeIcon("arrow", 18)}</button>' : '<button class="btn btn-primary" data-action="request-age-appeal">提交年龄复核</button><button class="btn btn-line" data-action="reload-age">刷新服务端状态</button>')
    : `<form id="age-form"><label class="check-row"><input name="adult_confirmed" type="checkbox" required><span>我确认本人已满 18 周岁，并提交年龄声明供服务端判断。</span></label><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>提交年龄声明 ${prototypeIcon("arrow", 18)}</button></form>`;
  return prototypeShell(`<div class="content"><div class="eyebrow">Age assurance</div><h1 id="app-title">年龄保障</h1><p class="lead">先完成基础年龄判断。只有出现账号或行为风险信号时，才会请求更强的核验。</p><section class="verify-card"><h3>${status === "AGE_PASS" ? "核验已通过" : "基础信息"}</h3><p class="page-sub">${detail}</p>${!blocked ? `<label class="field"><span>出生日期</span><input form="age-form" name="birth_date" type="date" required></label>` : ""}<div class="status-row"><span class="status-dot ${status === "AGE_PASS" ? "pass" : ""}"></span>${escapeHtml(status)} · ${escapeHtml((state.age?.reason_codes ?? []).join("、") || "等待服务端结果")}</div></section><div class="rights">${prototypeIcon("lock", 17)}<span>栖语不保存证件原图；增强年龄核验的供应商接入与结果以服务端状态为准。</span></div></div><div class="bottom-action">${form}<div class="note">浏览器不自行判定年龄结果，也不展示原型模拟的核验成功。</div></div>`, "02 / 03");
}

function personaFields(persona = {}) {
  return `
    <label class="field"><span>世界观</span><textarea name="persona_worldview" maxlength="500" rows="2" placeholder="TA 生活在哪里、做什么">${escapeHtml(persona.worldview ?? "")}</textarea></label>
    <label class="field"><span>年龄设定</span><input name="persona_age_setting" maxlength="500" value="${escapeHtml(persona.age_setting ?? "")}" placeholder="例如：27"></label>
    <label class="field"><span>与我的关系</span><input name="persona_relationship" maxlength="500" value="${escapeHtml(persona.relationship_to_user ?? "")}" placeholder="例如：认识很久的老朋友"></label>
    <label class="field"><span>性格</span><input name="persona_personality" maxlength="500" value="${escapeHtml(persona.personality ?? "")}" placeholder="例如：安静温和、偶尔冷幽默"></label>
    <label class="field"><span>表达方式</span><input name="persona_expression" maxlength="500" value="${escapeHtml(persona.expression_style ?? "")}" placeholder="例如：短句为主，画面感的比喻"></label>
    <label class="field"><span>硬边界（每行一条，绝不做什么）</span><textarea name="persona_boundaries" rows="2" maxlength="2000" placeholder="例如：不复刻任何真人">${escapeHtml((persona.hard_boundaries ?? []).join("\n"))}</textarea></label>
    <label class="field"><span>示例行为（每行一条）</span><textarea name="persona_examples" rows="2" maxlength="2000" placeholder="例如：我难过时先承认情绪再给建议">${escapeHtml((persona.example_behaviors ?? []).join("\n"))}</textarea></label>`;
}

function renderCharacter() {
  const templateButtons = PERSONA_TEMPLATES.map((template, index) => `<button type="button" class="chip ${index < 2 ? "on" : ""}" data-template="${template.id}" ${state.busy ? "disabled" : ""}>${escapeHtml(template.label)}</button>`).join("");
  return prototypeShell(`<form id="character-form"><div class="content"><div class="eyebrow">Create your character</div><h1 id="app-title">让 TA 有清楚的底色</h1><p class="lead">先从一个角色开始。人格设定会版本化保存，并经过行为回归测试减少升级后的陌生感。</p><div class="mode-switch"><button type="button" class="on">快速创建</button><button type="button" data-action="open-oc-import">导入原创 OC</button></div><div class="portrait-editor"><img src="/assets/qiyu-character.png" alt="原创成年 AI 角色示意"><span class="aigc">AI 生成形象</span></div><label class="field"><span>角色名字</span><input name="character_name" maxlength="80" required placeholder="例如：林默"></label><div class="field"><span>人格模板</span><div class="chips">${templateButtons}</div></div>${personaFields({})}<label class="check-row"><input name="rights_confirmed" type="checkbox" required><span>我确认角色设定为原创或已获授权，不复刻真人、明星或未授权 IP。</span></label><div class="rights">${prototypeIcon("shield", 17)}<span>人格、年龄、安全和关系记忆均由服务端分别治理；此表单不能覆盖系统安全边界。</span></div></div><div class="bottom-action"><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>创建并开始相处 ${prototypeIcon("arrow", 18)}</button><div class="note">参考图、音色和内容权益会经过相应的受控审核流程。</div></div></form>`, "03 / 03");
}

function renderOcImport() {
  const review = state.ocRightsReview;
  const reviewCard = review ? `<section class="card status-card ${review.state === "APPROVED" ? "pass" : "review"}"><b>OC 权利审核：${escapeHtml(review.state ?? "未返回")}</b><p class="muted">风险码仅用于审核路由，不构成侵权结论；应用不会自行批准。</p><div class="button-row"><button class="btn btn-line" data-action="refresh-oc-rights" ${state.busy ? "disabled" : ""}>刷新审核状态</button>${review.appeal_available ? `<button class="btn btn-line" data-action="appeal-oc-rights" ${state.busy ? "disabled" : ""}>提交申诉</button>` : ""}${review.state === "APPROVED" ? `<button class="btn btn-primary" data-action="create-from-oc-import" ${state.busy ? "disabled" : ""}>用已审核设定创建角色</button>` : ""}</div></section>` : "";
  return screen(`<div class="topline"><button class="btn btn-line" data-action="back-character">返回创建角色</button><span class="dev-label">OC import</span></div><div class="eyebrow">Private OC import</div><h1 id="app-title">先隔离审核，<br>再写入角色。</h1><p class="lead">OC 原文只用于受控字段候选提取和权利审核，不会自动公开、训练模型或覆盖系统安全规则。</p>${reviewCard}<form id="oc-import-form" class="stack"><label class="field"><span>OC 设定</span><textarea name="oc_source_text" maxlength="8000" rows="10" required placeholder="可填写：世界观：…\n性格：…\n表达风格：…"></textarea><small class="muted">最多 8000 字。请勿粘贴真人、未获授权 IP 或其他人的私密内容。</small></label><label class="check-row"><input name="oc_rights_confirmed" type="checkbox" required><span>我确认上述内容为原创或已获授权，并理解提交后会先进入审核而非自动生效。</span></label><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>隔离提交并申请审核</button></form>`);
}

function renderCharacterProfile() {
  const character = state.character;
  if (!character) { state.route = "character"; return renderCharacter(); }
  const history = (character.persona_history ?? []).slice().reverse().map((entry) => `<article class="asset"><div><b>版本 ${escapeHtml(entry.version)} · ${escapeHtml(entry.state ?? "STABLE")} · ${escapeHtml(new Date(entry.created_at).toLocaleString())}</b><small>${escapeHtml(entry.note || "无备注")} · 变更：${escapeHtml((entry.changed_fields ?? []).join(", ") || "无")}</small></div></article>`).join("");
  return screen(`<div class="topline"><button class="btn btn-line" data-action="back-chat">返回对话</button><span class="dev-label">Persona</span></div><div class="eyebrow">Persona continuity</div><h1 id="app-title">角色档案</h1><p class="lead">当前稳定人格版本 ${escapeHtml(character.active_persona_version ?? character.version)}。人格修改会先成为草稿，必须通过评测、影子与灰度后才会生效。</p>
  <form id="persona-form" class="stack"><label class="field"><span>角色名字</span><input name="character_name" maxlength="80" required value="${escapeHtml(character.name ?? "")}"></label>${personaFields(character.persona ?? {})}<button class="btn btn-primary" ${state.busy ? "disabled" : ""}>创建人格草稿</button></form>
  <div class="stack"><b>变更记录</b>${history || '<div class="empty-state">暂无历史版本。</div>'}</div>`);
}

function messageMarkup(message) {
  const actor = message.actor ?? message.role ?? "assistant";
  const isUser = actor === "user" || actor === "USER";
  const content = message.content ?? message.text ?? message.display_text ?? "";
  const id = messageId(message);
  const audio = !isUser && id ? state.audioUrls.get(id) : null;
  const voice = !isUser && id ? (audio ? `<div class="voice-message"><span class="aigc">AI 生成语音</span><audio controls src="${escapeHtml(audio.url)}"></audio><button class="btn btn-line" data-action="delete-message-audio" data-message-id="${escapeHtml(id)}">删除语音</button></div>` : `<button class="btn btn-line" data-action="synthesize-message-audio" data-message-id="${escapeHtml(id)}" ${state.busy ? "disabled" : ""}>生成角色语音</button>`) : "";
  return `<article class="message ${isUser ? "me" : "ai"}"><div class="bubble">${escapeHtml(content) || "…"}</div>${voice}<div class="msg-meta"><span>${isUser ? "你" : "AI 生成"}</span></div></article>`;
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
  return screen(`<div class="topline"><button class="btn btn-line" data-action="back-chat">返回对话</button><span class="dev-label">World state</span></div><div class="eyebrow">Short-lived, user-controlled context</div><h1 id="app-title">此刻的情境，<br>由你校正。</h1><section class="card"><b>当前版本 ${escapeHtml(world.state_version)}</b><p class="muted">仅包含短期情绪和地点；不会修改人格、安全结论、年龄状态或确认关系资产。</p><small>关联事件：${events}</small></section><form id="world-state-form" class="stack"><label class="field"><span>当前情绪</span><select name="world_mood">${options(moods, world.mood_code)}</select></label><label class="field"><span>当前地点</span><select name="world_location">${options(locations, world.location_code)}</select></label><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>保存当前情境</button></form><div class="flow-actions"><button class="btn btn-line" data-action="reset-world-state" ${state.busy ? "disabled" : ""}>重置短期情境</button><p class="muted">保存使用版本校验；其他位置更新后，服务端会拒绝旧版本覆盖。</p></div>`);
}

function renderChat() {
  const characterName = state.character?.name ?? "当前角色";
  const candidate = state.candidates.find((item) => ["CANDIDATE", "PENDING"].includes(item.state));
  const ttsFailure = state.lastTtsJob ? `<section class="rights" data-media-type="TTS" data-state="${escapeHtml(state.lastTtsJob.state)}">${prototypeIcon("shield", 17)}<span><b>角色语音未生成</b><br>${state.lastTtsJob.failure_code === "ENTITLEMENT_QUOTA_EXCEEDED" ? '需先领取 7 天完整体验，或当前语音额度已用完。' : `文字回复仍可正常阅读。失败码：${escapeHtml(state.lastTtsJob.failure_code ?? "未返回")}。`}${state.lastTtsJob.failure_code === "ENTITLEMENT_QUOTA_EXCEEDED" ? `<br><button class="btn btn-line" data-action="open-subscription">查看权益与领取试用</button>` : ""}</span></section>` : "";
  const world = state.worldState;
  const worldText = world ? `${world.mood_code ?? "平静"} · ${world.location_code ?? "未设定"}` : "此刻由你决定";
  const memoryBanner = candidate ? `<button class="memory-banner" data-action="open-candidate" data-candidate-id="${escapeHtml(candidateId(candidate))}"><span>${prototypeIcon("archive", 18)}</span><span><b>1 条候选记忆等待你确认</b><small>不会自动写入长期记忆</small></span><span class="chev">${prototypeIcon("chev", 16)}</span></button>` : "";
  const paused = state.userPaused ? `<button class="memory-banner" data-action="resume-interaction"><span>${prototypeIcon("shield", 18)}</span><span><b>普通互动已暂停</b><small>由你恢复前，不会继续生成角色回复</small></span></button>` : "";
  return `<section class="screen qiyu-prototype app-screen ${state.theme === "night" ? "night" : "paper"}"><header class="app-header"><div class="identity"><img class="avatar" src="/assets/qiyu-character.png" alt="${escapeHtml(characterName)}，AI 角色"><div><b>${escapeHtml(characterName)}</b><small><span class="ai-dot"></span>AI 角色 · ${isClosedTrial() ? "封闭试用" : "本地开发"}</small></div></div><button class="icon-btn soft" data-action="toggle-theme" aria-label="切换日夜主题">${prototypeIcon(state.theme === "night" ? "sun" : "moon", 20)}</button></header><div class="chat-scroll"><div class="date-rule">本次会话 · API 事实驱动</div><button class="scene-state" data-action="open-world-state"><span class="glyph">${prototypeIcon(state.theme === "night" ? "moon" : "clock", 16)}</span><span><b>此刻的 ${escapeHtml(characterName)}</b><small>${escapeHtml(worldText)}</small></span></button>${paused}${memoryBanner}${ttsFailure}<section aria-label="对话消息">${state.messages.map(messageMarkup).join("") || '<div class="empty-state">从一句问候开始，让这段关系慢慢展开。</div>'}</section></div><form id="message-form" class="composer-wrap"><div class="composer"><button type="button" class="icon-btn" data-action="open-asr" aria-label="语音转文字">${prototypeIcon("mic", 19)}</button><input name="message" maxlength="2000" autocomplete="off" placeholder="和 ${escapeHtml(characterName)} 说点什么…" value="${escapeHtml(state.pendingTranscript)}" ${state.busy ? "disabled" : ""}><button type="button" class="icon-btn" data-action="open-image" aria-label="受控情境图">${prototypeIcon("image", 19)}</button><button class="icon-btn send" aria-label="发送" ${state.busy ? "disabled" : ""}>${prototypeIcon("send", 17)}</button></div></form>${prototypeNav("chat")}</section>`;
}

function renderSubscription() {
  const plans = state.subscriptionCatalog?.plans ?? [];
  const subscription = state.currentSubscription;
  const trial = state.trial;
  const entitlementRows = (state.entitlements ?? []).map((item) => {
    const unitLabel = item.unit === "SECONDS" ? "秒" : "张";
    return `<article class="asset"><div><b>${{ IMAGE_GENERATION: "情境图", SYNTHESIZE_TTS: "角色语音", TRANSCRIBE_ASR: "语音输入" }[item.capability] ?? item.capability}</b><small>可用 ${escapeHtml(String(item.available_quantity))} ${unitLabel} / 已用 ${escapeHtml(String(item.committed_quantity))} · 重置 ${item.resets_at ? escapeHtml(new Date(item.resets_at).toLocaleDateString()) : "无有效订阅"}</small></div></article>`;
  }).join("");
  const subscriptionCard = subscription && subscription.state !== "TRIAL"
    ? `<section class="card"><b>当前订阅：${escapeHtml(subscription.sku)} · ${escapeHtml(subscription.state)}</b><p class="muted">周期：${subscription.period_start ? escapeHtml(new Date(subscription.period_start).toLocaleDateString()) : "未开始"} 至 ${subscription.period_end ? escapeHtml(new Date(subscription.period_end).toLocaleDateString()) : "—"}；自动续费：${subscription.auto_renew ? "已开启" : "未开启"}。</p>${["ACTIVE", "BILLING_RETRY", "GRACE_PERIOD"].includes(subscription.state) ? `<button class="btn btn-line" data-action="cancel-renewal" ${state.busy ? "disabled" : ""}>关闭自动续费</button>` : ""}</section>`
    : '<section class="card"><b>当前无有效订阅</b><p class="muted">到期或未订阅时，文字对话、人格、记忆与数据权利保持可用；不会用降低角色态度或遗忘关系促使付费。</p></section>';
  const trialCard = trial?.state === "TRIAL"
    ? `<section class="card"><b>${trial.phase === "ENDING" ? "7 天完整体验即将结束" : "7 天完整体验进行中"}</b><p class="muted">至 ${escapeHtml(new Date(trial.period_end).toLocaleDateString())}；包含 3 张情境图、5 分钟角色语音与文本互动。到期不自动扣费，也不会影响关系资产和数据权利。</p>${trial.phase === "ENDING" ? '<p class="muted">如果要继续使用多媒体服务，请主动选择订阅方案；不选择不会产生任何扣费。</p>' : ""}</section>`
    : trial?.state === "EXPIRED"
      ? '<section class="card"><b>7 天完整体验已结束</b><p class="muted">不会自动扣费。文字、人格、关系资产、导出与删除仍可用。</p></section>'
      : `<section class="card"><b>先体验，再决定</b><p class="muted">可领取一次 7 天完整体验：3 张情境图、5 分钟角色语音与文本互动；到期不自动扣费。</p><button class="btn btn-primary" data-action="start-trial" ${state.busy ? "disabled" : ""}>开始 7 天完整体验</button></section>`;
  const planCards = plans.map((plan) => `<section class="card"><b>${escapeHtml(plan.label)} · ¥${(plan.price_fen / 100).toFixed(0)}/${plan.billing_cycle === "MONTH" ? "月" : "季度"}</b><p class="muted">单角色、文本公平使用、${plan.image_quota} 张情境图、${plan.tts_minutes} 分钟角色语音、${plan.asr_minutes} 分钟语音输入。</p><div class="button-row"><button class="btn btn-primary" data-action="purchase-plan" data-sku="${escapeHtml(plan.sku)}" data-autorenew="false" ${state.busy ? "disabled" : ""}>购买（默认不续费）</button><button class="btn btn-line" data-action="purchase-plan" data-sku="${escapeHtml(plan.sku)}" data-autorenew="true" ${state.busy ? "disabled" : ""}>购买并开启续费</button></div></section>`).join("");
  return screen(`<div class="topline"><button class="btn btn-line" data-action="back-chat">返回对话</button><span class="dev-label">Subscription</span></div><div class="eyebrow">Clear before purchase</div><h1 id="app-title">按服务能力订阅，<br>不是为留住关系。</h1>${trialCard}${subscriptionCard}<div class="stack"><b>权益余额</b>${entitlementRows || '<div class="empty-state">暂无权益记录。</div>'}</div>${planCards || '<div class="empty-state">服务端未返回订阅目录；不会显示本地猜测价格。</div>'}<section class="card"><b>续费规则</b><p class="muted">自动续费默认${state.subscriptionCatalog?.auto_renew_default === false ? "不勾选" : "未确认"}；需要用户主动选择，并在付款前显示周期、金额和取消方式。到期后文字、人格、关系资产、导出与删除仍可用。</p></section><div class="flow-actions"><p class="muted">当前为开发模拟支付渠道：签名由服务端生成、回调经验签后发放权益；真实支付宝/微信支付需商户与渠道密钥接入后启用。</p></div>`);
}

function renderImageReference() {
  const selected = state.referenceImageFile ? `<section class="card image-file"><b>已选择：${escapeHtml(state.referenceImageFile.file.name)}</b><small>${escapeHtml(state.referenceImageFile.mimeType)} · ${Math.ceil(state.referenceImageFile.file.size / 1024)} KB</small></section>` : '<div class="empty-state">尚未选择参考立绘。浏览器不会生成预览或上传到公开地址。</div>';
  const review = state.referenceRightsReview;
  const asset = state.referenceImageAsset;
  const reviewCard = review ? `<section class="card status-card ${review.state === "APPROVED" ? "pass" : "review"}"><b>参考图权利审核：${escapeHtml(review.state ?? "未返回")}</b><p class="muted">IMS 内容审核和权利审核是两项独立结论。当前应用不会自行批准权利审核。</p><div class="button-row"><button class="btn btn-line" data-action="refresh-reference-rights" ${state.busy ? "disabled" : ""}>刷新审核状态</button>${review.appeal_available ? `<button class="btn btn-line" data-action="appeal-reference-rights" ${state.busy ? "disabled" : ""}>提交申诉</button>` : ""}</div></section>` : asset ? `<section class="card status-card review"><b>参考图状态：${escapeHtml(asset.state ?? "未返回")}</b><p class="muted">该图片未进入独立权利审核，不能用于生图；请重新选择合规且拥有使用授权的参考图。</p></section>` : "";
  return screen(`<div class="topline"><button class="btn btn-line" data-action="back-chat">返回对话</button><span class="dev-label">Private image / 01</span></div><div class="eyebrow">Reference image assurance</div><h1 id="app-title">先确认参考立绘，<br>再生成情境。</h1><p class="lead">参考图会先进入私有 COS 并经 IMS 内容审核，再进入独立权利审核。任一步未通过，都不会创建生图任务。</p>${reviewCard}<form id="reference-image-form" class="stack">${selected}<label class="field"><span>导入角色参考立绘</span><input id="reference-image-file" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" ${state.busy ? "disabled" : ""}><small class="muted">仅 PNG、JPG、WebP，最大 2MB。请勿上传真人、未获授权的角色/IP、敏感或违法内容。</small></label><label class="check-row"><input name="image_rights_confirmed" type="checkbox" required><span>我确认拥有图片使用授权；该图不会作为公开链接返回，且只会用于当前角色的受控情境生成。</span></label><button class="btn btn-primary" ${state.referenceImageFile && !state.busy ? "" : "disabled"}>上传并提交审核</button></form>`);
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
  return screen(`<div class="topline"><button class="btn btn-line" data-action="back-chat">返回对话</button><span class="dev-label">Private image / 02</span></div><div class="eyebrow">Confirmed scene contract</div><h1 id="app-title">只生成你确认过的情境。</h1><section class="card"><b>参考立绘已确认</b><p class="muted">服务器仅使用这个已审核资产，以及下方地点、服装、时间字段；不会把未确认聊天记录或候选记忆编入提示词。</p></section>${imageFailure}${jobCard}${generated}<form id="image-scene-form" class="stack"><label class="field"><span>地点</span><input name="scene_location" maxlength="80" required placeholder="例如：窗边"></label><label class="field"><span>服装</span><input name="scene_outfit" maxlength="80" required placeholder="例如：针织衫"></label><label class="field"><span>时间</span><select name="scene_time_of_day" required><option value="">请选择</option><option value="DAWN">黎明</option><option value="MORNING">上午</option><option value="AFTERNOON">下午</option><option value="EVENING">傍晚</option><option value="NIGHT">夜晚</option></select></label><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>提交单张情境图任务</button></form><div class="flow-actions">${job && ["PENDING", "RUNNING"].includes(job.state) ? `<button class="btn btn-line" data-action="refresh-image-job" ${state.busy ? "disabled" : ""}>刷新图片任务状态</button>` : ""}<button class="btn btn-line" data-action="replace-reference-image" ${state.busy ? "disabled" : ""}>更换参考立绘</button><p class="muted">一张任务只请求一张图，并要求供应商添加 AIGC 标识；失败或审核拦截不会把图片交给浏览器。</p></div>`);
}

function renderAsrInput() {
  const recording = state.asrRecording?.state === "recording";
  const recorderReady = Boolean(recordingMimeType() && navigator.mediaDevices?.getUserMedia);
  const selected = state.asrFile ? `<section class="card asr-file"><b>已选择：${escapeHtml(state.asrFile.file.name)}</b><small>${escapeHtml(state.asrFile.mimeType)} · ${Math.ceil(state.asrFile.file.size / 1024)} KB</small></section>` : '<div class="empty-state">尚未选择音频。只在本浏览器内暂存，服务端受理后会立即清除。</div>';
  const failed = state.asrJob?.state === "FAILED" ? `<section class="card asr-failed"><b>转写未完成</b><p class="muted">失败码：${escapeHtml(state.asrJob.failure_code ?? "未返回")}。原始音频仍由服务端私有保存，建议立即删除。</p><button class="btn btn-danger" data-action="delete-failed-asr-input" ${state.busy ? "disabled" : ""}>删除原始音频</button></section>` : "";
  return screen(`<div class="topline"><button class="btn btn-line" data-action="back-chat">返回对话</button><span class="dev-label">ASR / local</span></div><div class="eyebrow">Speech to editable text</div><h1 id="app-title">先看文字，<br>再决定是否发送。</h1><p class="lead">短音频会先创建私有转写任务。转写完成后，你可以修订；确认并不自动发送给角色。</p><div class="stack">${failed}${selected}<label class="field"><span>导入短音频</span><input id="asr-file" type="file" accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/aac,audio/ogg,.mp3,.wav,.m4a,.aac,.ogg" ${state.busy || recording ? "disabled" : ""}><small class="muted">支持 WAV、MP3、M4A、AAC、OGG；不超过 2MB。开发路径不接受 WebM。</small></label><div class="button-row">${recording ? '<button class="btn btn-danger" data-action="stop-asr-recording">停止录音</button>' : `<button class="btn btn-line" data-action="start-asr-recording" ${recorderReady && !state.busy ? "" : "disabled"}>录制兼容音频</button>`}</div><button class="btn btn-primary" data-action="create-asr-job" ${state.asrFile && !state.busy && !recording ? "" : "disabled"}>转写并进入确认</button><p class="muted">录音按钮仅在浏览器能输出腾讯兼容的 OGG 时可用；否则请导入音频，避免把不受支持格式伪装成可转写。</p></div>`);
}

function renderAsrConfirm() {
  const transcript = state.asrJob?.transcript?.text ?? "";
  if (!state.asrJob || state.asrJob.state !== "COMPLETED") { state.route = "asr"; return renderAsrInput(); }
  return screen(`<div class="topline"><button class="btn btn-line" data-action="back-asr">重新选择音频</button><span class="dev-label">ASR confirmation</span></div><div class="eyebrow">User confirmation required</div><h1 id="app-title">这段转写，<br>由你决定怎么说。</h1><section class="card"><b>服务端转写已完成</b><p class="muted">确认后原始音频将被立即撤销并请求删除；这一步不会发送给角色模型。</p></section><label class="field"><span>检查或修订转写</span><textarea id="asr-edit" maxlength="4000">${escapeHtml(state.asrEdit || transcript)}</textarea></label><div class="flow-actions"><button class="btn btn-primary" data-action="confirm-asr" ${state.asrEdit.trim() && !state.busy ? "" : "disabled"}>确认文字并回到输入框</button><button class="btn btn-line" data-action="back-asr" ${state.busy ? "disabled" : ""}>放弃，不发送</button><p class="muted">“确认”只确认转写与触发原始音频删除。返回对话后仍必须点击“发送”。</p></div>`);
}

function renderCandidate() {
  const candidate = state.selectedCandidate;
  if (!candidate) { state.route = "chat"; return renderChat(); }
  const text = candidate.display_text ?? candidate.normalized_value ?? "服务端未返回候选文本";
  const conflicts = candidate.conflicts_with ?? [];
  const conflictMarkup = conflicts.length > 0 ? `<div class="rights">${prototypeIcon("shield", 17)}<span>与已有关系资产可能冲突。确认不会自动覆盖旧内容，请在时间线中单独修订。</span></div>` : "";
  const characterName = state.character?.name ?? "当前角色";
  return `<section class="screen qiyu-prototype app-screen paper"><header class="app-header"><div class="identity"><img class="avatar" src="/assets/qiyu-character.png" alt="${escapeHtml(characterName)}，AI 角色"><div><b>${escapeHtml(characterName)}</b><small><span class="ai-dot"></span>AI 角色 · 关系记忆</small></div></div><button class="icon-btn soft" data-action="back-chat" aria-label="关闭记忆确认">${prototypeIcon("x", 20)}</button></header><div class="chat-scroll"><div class="date-rule">关系资产需由你确认</div><div class="scene-state"><span class="glyph">${prototypeIcon("archive", 16)}</span><span><b>候选记忆等待确认</b><small>不会自动写入长期关系资产</small></span></div></div><div class="sheet-layer"><section class="sheet" role="dialog" aria-modal="true" aria-label="关系记忆确认"><div class="grabber"></div><div class="sheet-head"><div><span class="aigc">服务端候选 · ${escapeHtml(candidate.state)}</span><h3>关系记忆</h3><p>候选内容不会自动成为长期事实</p></div><button class="close" data-action="back-chat" aria-label="关闭">${prototypeIcon("x", 18)}</button></div><blockquote class="memory-quote">${escapeHtml(text)}</blockquote>${conflictMarkup}<label class="field"><span>修改后确认（可选）</span><textarea id="candidate-edit">${escapeHtml(state.confirmEdit || text)}</textarea></label><div class="sheet-actions"><button class="btn btn-line" data-action="reject-candidate" ${state.busy ? "disabled" : ""}>不记住</button><button class="btn btn-secondary" data-action="confirm-edited-candidate" ${state.busy ? "disabled" : ""}>修改措辞</button><button class="btn btn-primary wide" data-action="confirm-candidate" ${state.busy ? "disabled" : ""}>确认记住 ${prototypeIcon("check", 18)}</button></div><p class="note">确认、修改或拒绝的最终状态均以 API 返回为准。</p></section></div></section>`;
}

function deletionMarkup() {
  if (!state.deletionJob) return "";
  const status = state.deletionJob.state ?? state.deletionJob.status ?? state.deletionJob.production ?? "UNKNOWN";
  const id = state.deletionJob.deletion_job_id ?? state.deletionJob.id ?? "未返回";
  const epoch = state.deletionJob.revocation_epoch ?? "未返回";
  return `<section class="card deletion" data-state="${escapeHtml(status)}"><b>删除任务：${escapeHtml(status)}</b><small>任务 ID：${escapeHtml(id)} · 撤销纪元：${escapeHtml(epoch)}</small><p class="muted">此状态完全来自 API；除非服务端返回 COMPLETED，界面不会称删除完成。</p><button class="btn btn-line" data-action="refresh-deletion" ${state.busy ? "disabled" : ""}>刷新删除任务</button></section>`;
}

function renderAssets() {
  const filter = state.timelineFilter ?? "all";
  const chips = [["all", "全部"], ["memory", "记忆"], ["commitment", "约定"], ["boundary", "边界"], ["event", "事件"]]
    .map(([value, label]) => `<button class="btn ${filter === value ? "btn-primary" : "btn-line"}" data-timeline-filter="${value}" ${state.busy ? "disabled" : ""}>${label}</button>`).join("");
  const timelineCards = (state.timeline ?? []).map((entry) => `<article class="asset timeline-entry"><div><b>${escapeHtml(entry.display_text ?? entry.type)}</b><small>${escapeHtml(new Date(entry.created_at).toLocaleString())} · ${escapeHtml(entry.filter_group ?? entry.type ?? "")} · 版本 ${escapeHtml(entry.version ?? "?")}</small></div><div class="button-row"><button class="btn btn-line" data-action="revise-asset" data-asset-id="${escapeHtml(entry.asset_id)}" ${state.busy ? "disabled" : ""}>修订</button><button class="btn btn-danger" data-action="delete-asset" data-asset-id="${escapeHtml(entry.asset_id)}" ${state.busy ? "disabled" : ""}>删除</button></div></article>`).join("");
  return screen(`<div class="topline"><button class="btn btn-line" data-action="back-chat">返回对话</button><span class="dev-label">Timeline</span></div><div class="eyebrow">Relationship timeline</div><h1 id="app-title">关系时间线</h1><p class="lead">只显示仍然有效的确认资产；被修订替代和已删除的版本不会出现在线。</p><div class="button-row">${chips}</div><div class="stack">${deletionMarkup()}${timelineCards || '<div class="empty-state">当前筛选下没有时间线条目。</div>'}</div><div class="flow-actions"><button class="btn btn-line" data-action="download-relationship-profile" ${state.busy ? "disabled" : ""}>下载关系档案 JSON</button><div class="button-row"><button class="btn btn-line" data-action="set-retention-30" ${state.busy ? "disabled" : ""}>原始互动保留 30 天</button><button class="btn btn-line" data-action="set-retention-90" ${state.busy ? "disabled" : ""}>原始互动保留 90 天</button></div><button class="btn btn-line" data-action="refresh-assets" ${state.busy ? "disabled" : ""}>刷新时间线</button></div>`);
}

function trialFeedbackMarkup() {
  if (!isClosedTrial()) return "";
  const recent = state.trialFeedback.slice(0, 3).map((item) => `<li>${escapeHtml(item.category)} · ${escapeHtml(item.rating)}/5${item.note ? ` · ${escapeHtml(item.note)}` : ""}</li>`).join("");
  return `<section class="feedback-card"><h3>封闭试用反馈</h3><p class="page-sub">你的评价会进入试用改进看板；不会自动改写角色人格、关系记忆或安全状态。</p><form id="trial-feedback-form"><label class="field"><span>反馈分类</span><select name="category" required><option value="ONBOARDING">引导与注册</option><option value="PERSONA">角色人格</option><option value="MEMORY">记忆连续性</option><option value="SAFETY">安全与边界</option><option value="USABILITY" selected>易用性</option><option value="OTHER">其他</option></select></label><label class="field"><span>总体评分</span><select name="rating" required><option value="5">5 · 很满意</option><option value="4" selected>4 · 满意</option><option value="3">3 · 一般</option><option value="2">2 · 不满意</option><option value="1">1 · 很不满意</option></select></label><label class="field"><span>补充说明（可选，最多 1200 字）</span><textarea name="note" maxlength="1200" rows="3"></textarea></label><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>提交试用反馈</button></form>${recent ? `<p class="page-sub">最近提交：</p><ul class="page-sub">${recent}</ul>` : ""}<button class="btn btn-line" data-action="trial-logout" ${state.busy ? "disabled" : ""}>退出此设备的试用会话</button></section>`;
}

function renderDataCenter() {
  const retention = state.rawInteractionRetentionDays;
  const retentionText = retention === 30 || retention === 90 ? `${retention} 天` : "未取得服务端设置";
  return `<section class="screen qiyu-prototype paper"><header class="app-header"><button class="icon-btn soft" data-action="back-chat" aria-label="返回对话">${prototypeIcon("x", 20)}</button><span class="step">数据中心</span><span class="header-spacer" aria-hidden="true"></span></header><div class="page-content"><div class="eyebrow">Privacy & data controls</div><h1 id="app-title" class="page-title">你的数据，<br>由你决定。</h1><p class="page-sub">导出、留存与删除都以 API 返回的状态为准；订阅状态不会限制这些数据权利。</p><section class="data-hero"><span class="lock">${prototypeIcon("lock", 28)}</span><h3>数据权利独立于关系</h3><p>聊天记录、候选记忆和确认的关系资产分层保存；删除后是否完成以服务端回执为准。</p></section><div class="section-title"><h3>聊天保留周期</h3><small>当前 ${escapeHtml(retentionText)}</small></div><div class="segment"><button class="${retention === 30 ? "on" : ""}" data-action="set-retention-30" ${state.busy ? "disabled" : ""}>30 天</button><button class="${retention === 90 ? "on" : ""}" data-action="set-retention-90" ${state.busy ? "disabled" : ""}>90 天</button></div><div class="section-title"><h3>关系资产</h3><small>${state.assets.length} 条有效资产</small></div><div class="list"><button class="list-row" data-action="download-relationship-profile"><span class="list-ico">${prototypeIcon("download", 16)}</span><span class="list-copy"><b>导出我的数据</b><small>关系档案、当前可见文本与确认记忆</small></span><span class="list-end">${prototypeIcon("chev", 14)}</span></button><button class="list-row" data-action="open-assets"><span class="list-ico">${prototypeIcon("archive", 16)}</span><span class="list-copy"><b>管理关系资产</b><small>查看、修订或删除确认内容</small></span><span class="list-end">${prototypeIcon("chev", 14)}</span></button></div>${trialFeedbackMarkup()}${deletionMarkup()}<div class="section-title"><h3>删除与注销</h3><small>订阅不影响数据权利</small></div><div class="list"><button class="list-row" data-action="delete-account" ${state.busy ? "disabled" : ""}><span class="list-ico">${prototypeIcon("trash", 16)}</span><span class="list-copy"><b>注销账户</b><small>终止访问并进入可审计删除流程</small></span><span class="list-end">${prototypeIcon("chev", 14)}</span></button></div></div></section>`;
}

function renderSafety() {
  const contact = state.emergencyContact;
  const contactCard = contact
    ? `<section class="card"><b>紧急联系人已保存</b><p class="muted">${escapeHtml(contact.contact_name)} · ${escapeHtml(contact.relationship)} · ${escapeHtml(contact.phone_masked)}</p><p class="muted">仅用于法规与生命健康或重大财产安全响应；不用于增长、推荐或营销。</p><button class="btn btn-line" data-action="remove-emergency-contact" ${state.busy ? "disabled" : ""}>删除联系人</button></section>`
    : `<section class="card"><b>紧急联系人未保存</b><p class="muted">按适用要求提供必要的监护人或紧急联系人信息；提交前请阅读独立用途告知。</p></section>`;
  return screen(`<div class="topline"><button class="btn btn-line" data-action="back-chat">返回对话</button><span class="dev-label">Safety</span></div><div class="eyebrow">Safety & help</div><h1 id="app-title">安全与帮助</h1><p class="lead">高风险情境会进入固定安全响应并暂停普通剧情；这些入口不依赖角色，也不会被角色话术覆盖。</p>
  <div class="stack">
  <section class="card"><b>如果你正处于危机中</b><p class="muted">涉及自伤自杀或重大财产损失时，系统会直接提供固定安全响应，并按规定联系监护人/紧急联系人。你也可拨打心理援助热线（如北京 010-82951332）或 110/120。</p></section>
  ${contactCard}
  <section class="card"><b>数据与留存</b><p class="muted">查看关系档案导出、原始互动保留设置和删除任务回执。</p><button class="btn btn-line" data-action="open-data" ${state.busy ? "disabled" : ""}>打开数据中心</button></section>
  <form id="emergency-contact-form" class="stack"><b>保存/更新紧急联系人</b><label class="field"><span>姓名</span><input name="contact_name" maxlength="80" required value="${escapeHtml(contact?.contact_name ?? "")}"></label><label class="field"><span>与我的关系</span><input name="contact_relationship" maxlength="40" required placeholder="例如：朋友/监护人" value="${escapeHtml(contact?.relationship ?? "")}"></label><label class="field"><span>联系电话</span><input name="contact_phone" required placeholder="13800138000" value=""></label><label class="check-row"><input name="contact_consent" type="checkbox" required><span>我已知悉该联系人仅用于法规要求与生命健康或重大财产安全响应，不会用于其他用途。</span></label><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>保存联系人</button></form>
  <form id="complaint-form" class="stack"><b>举报 / 投诉 / 申诉</b><label class="field"><span>类型</span><select name="complaint_kind" required><option value="REPORT_CONTENT">举报内容（需资源ID）</option><option value="SERVICE_COMPLAINT">服务投诉</option><option value="APPEAL">申诉</option></select></label><label class="field"><span>目标资源 ID（举报内容必填）</span><input name="complaint_target" maxlength="128" placeholder="例如 msg_000001"></label><label class="field"><span>说明</span><textarea name="complaint_description" maxlength="2000" rows="3" required></textarea></label><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>提交</button><p class="muted">提交内容默认不包含完整私聊；处理进度以提交编号为准。</p></form>
  ${state.lastComplaintId ? `<section class="card"><b>最近提交</b><p class="muted">编号 ${escapeHtml(state.lastComplaintId)}，可在服务端查询处理状态。</p></section>` : ""}
  <section class="card"><b>账户注销</b><p class="muted">注销后互动与召回立即停止；生产数据 24 小时内清理、备份最长 30 天，法定留存进入隔离库。此操作不可撤销。</p><button class="btn btn-danger" data-action="delete-account" ${state.busy ? "disabled" : ""}>注销账户</button></section>
  </div>`);
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
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 15l-4-4L5 20"/>',
  send: '<path d="M22 2L9 15M22 2l-7 20-6-7-7-3 20-10z"/>', chat: '<path d="M4 5h16v12H8l-4 4V5z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>', heart: '<path d="M20.8 5.8a5.5 5.5 0 00-7.8 0L12 6.8l-1-1a5.5 5.5 0 00-7.8 7.8L12 22l8.8-8.4a5.5 5.5 0 000-7.8z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>', chev: '<path d="M9 18l6-6-6-6"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/>', download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>', trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14"/>'
});

function prototypeIcon(name, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PROTOTYPE_ICON_PATHS[name] ?? ""}</svg>`;
}

function prototypeShell(content, step) {
  return `<section class="screen qiyu-prototype paper"><header class="brandline"><span class="wordmark">栖语</span><span class="step">${escapeHtml(step)}</span></header><div class="orbit"></div>${content}</section>`;
}

function prototypeNav(active) {
  const items = [
    ["chat", "chat", "对话", "back-chat"], ["timeline", "clock", "时间线", "open-assets"],
    ["relation", "heart", "关系", "open-character-profile"], ["profile", "user", "我的", "open-data"]
  ];
  return `<nav class="bottom-nav" aria-label="主导航">${items.map(([id, icon, label, action]) => `<button type="button" class="nav-item ${active === id ? "on" : ""}" data-action="${action}">${prototypeIcon(icon, 20)}<span>${label}</span></button>`).join("")}</nav>`;
}

function screen(content) { return `<section class="screen">${content}</section>`; }

function renderTrialLogin() {
  return prototypeShell(`<form id="trial-login-form"><div class="content"><div class="eyebrow">Invite-only trial</div><h1 id="app-title">凭邀请进入，<br>安心试用。</h1><p class="lead">这是仅限受邀成年用户的免费封闭试用：不提供支付、不公开注册，也不代表正式上线。</p><div class="fact-grid"><article class="fact"><span class="fact-icon">${prototypeIcon("spark")}</span><div><strong>你正在与 AI 互动</strong><small>角色回复由 AI 生成并保留明显标识。</small></div></article><article class="fact"><span class="fact-icon">${prototypeIcon("shield")}</span><div><strong>仅向受邀成年用户开放</strong><small>登录后仍需完成系统告知与年龄声明。</small></div></article></div><label class="field"><span>邀请码</span><input name="invite_code" autocomplete="off" autocapitalize="characters" required placeholder="例如 QYXXXX-XXXXXX-XXXXXX-XXXXXX"></label><label class="field"><span>初始口令</span><input name="initial_secret" type="password" autocomplete="off" required placeholder="由邀请方单独发送"></label><div class="rights">${prototypeIcon("lock", 17)}<span>登录凭据仅保留在本浏览器会话中。请勿输入他人的隐私、证件或支付信息。</span></div></div><div class="bottom-action"><button class="btn btn-primary" ${state.busy ? "disabled" : ""}>进入封闭试用 ${prototypeIcon("arrow", 18)}</button><div class="note">如需退出，可在数据中心注销账户和发起数据删除。</div></div></form>`, "Closed beta");
}

function renderError() {
  return screen(`<div class="topline"><span class="wordmark">栖语</span><span class="dev-label">M1 local</span></div><div class="error-state"><h2 id="app-title">尚未取得服务端事实</h2><p>${escapeHtml(state.error)}</p><div class="flow-actions"><button class="btn btn-primary" data-action="retry-bootstrap">重试连接本地 API</button></div></div><p class="muted">未接入 API 时，本壳不会显示任何模拟年龄、记忆或删除成功状态。</p>`);
}

function render() {
  document.documentElement.dataset.qyTheme = state.theme;
  if (state.booting) { app.innerHTML = '<div class="boot-state"><span class="spinner" aria-hidden="true"></span><p>正在读取服务端状态…</p></div>'; return; }
  if (state.error) { app.innerHTML = renderError() + (state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ""); return; }
  const view = state.route === "trial-login" ? renderTrialLogin()
    : state.route === "notices" ? renderNotices()
    : state.route === "age" ? renderAge()
    : state.route === "character" ? renderCharacter()
    : state.route === "oc-import" ? renderOcImport()
    : state.route === "character-profile" ? renderCharacterProfile()
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
    : state.route === "proactive" ? renderProactive()
    : renderChat();
  app.innerHTML = view + renderContinuousReminder() + (state.toast ? `<div class="toast" role="status">${escapeHtml(state.toast)}</div>` : "");
  if (state.route === "chat") {
    const note = app.querySelector(".system-note");
    const latestAssistant = [...state.messages].reverse().find((item) => (item.actor ?? item.role) === "ASSISTANT");
    if (note) note.insertAdjacentHTML("beforeend", `${state.worldState ? ` <button class="btn btn-line" data-action="open-world-state" ${state.busy ? "disabled" : ""}>查看当前情境</button>` : ""}${latestAssistant ? ` <button class="btn btn-line" data-action="report-latest-assistant-message" ${state.busy ? "disabled" : ""}>反馈最近回复</button>` : ""}`);
  }
  if (state.route === "safety" && state.lastComplaintId) {
    const submitted = [...app.querySelectorAll(".card")].find((card) => card.textContent.includes("最近提交"));
    if (submitted) submitted.insertAdjacentHTML("beforeend", ` <button class="btn btn-line" data-action="refresh-last-complaint" ${state.busy ? "disabled" : ""}>查询处理状态</button>`);
  }
}

document.addEventListener("change", (event) => {
  const id = event.target?.dataset?.noticeCheck;
  if (id) {
    if (event.target.checked) state.noticeChecks.add(id); else state.noticeChecks.delete(id);
    render();
  }
  if (event.target?.id === "asr-file") setAsrFile(event.target.files?.[0]);
  if (event.target?.id === "reference-image-file") setReferenceImageFile(event.target.files?.[0]);
});

document.addEventListener("input", (event) => {
  if (event.target?.id === "candidate-edit") state.confirmEdit = event.target.value;
  if (event.target?.id === "asr-edit") state.asrEdit = event.target.value;
});

document.addEventListener("submit", (event) => {
  if (event.target.id === "trial-login-form") { event.preventDefault(); submitTrialLogin(event.target); }
  if (event.target.id === "age-form") { event.preventDefault(); submitAge(event.target); }
  if (event.target.id === "character-form") { event.preventDefault(); createCharacter(event.target); }
  if (event.target.id === "oc-import-form") { event.preventDefault(); submitOcImport(event.target); }
  if (event.target.id === "persona-form") { event.preventDefault(); saveCharacterProfile(event.target); }
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
    const template = PERSONA_TEMPLATES.find((item) => item.id === templateButton.dataset.template);
    const form = templateButton.closest("form");
    if (!template || !form) return;
    form.elements.persona_worldview.value = template.persona.worldview;
    form.elements.persona_age_setting.value = template.persona.age_setting;
    form.elements.persona_relationship.value = template.persona.relationship_to_user;
    form.elements.persona_personality.value = template.persona.personality;
    form.elements.persona_expression.value = template.persona.expression_style;
    form.elements.persona_boundaries.value = template.persona.hard_boundaries.join("\n");
    form.elements.persona_examples.value = template.persona.example_behaviors.join("\n");
    if (!form.elements.character_name?.value) form.elements.character_name.value = template.label;
    // 不调用 setToast：任何重渲染都会按当前 state 重建表单并清掉已填值。
  }
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || state.busy) return;
  const action = button.dataset.action;
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
  if (action === "toggle-theme") { state.theme = state.theme === "day" ? "night" : "day"; render(); }
  if (action === "open-assets") { state.route = "assets"; render(); }
  if (action === "open-character-profile") openCharacterProfile();
  if (action === "open-world-state") openWorldState();
  if (action === "reset-world-state") resetWorldState();
  if (action === "open-safety") openSafetyCenter();
  if (action === "open-data") openDataCenter();
  if (action === "refresh-last-complaint") refreshLastComplaint();
  if (action === "report-latest-assistant-message") reportLatestAssistantMessage();
  if (action === "purchase-plan") purchasePlan(button.dataset.sku, button.dataset.autorenew === "true");
  if (action === "start-trial") startTrial();
  if (action === "cancel-renewal") cancelRenewal();
  if (action === "open-proactive") openProactive();
  if (action === "resume-interaction") resumeInteraction();
  if (action === "delete-proactive") deleteProactiveEvent(button.dataset.eventId);
  if (action === "trigger-proactive") triggerProactiveEvent(button.dataset.eventId);
  if (action === "remove-emergency-contact") removeEmergencyContact();
  if (action === "delete-account") deleteAccount();
  if (action === "dismiss-reminder") { state.continuousReminder = null; render(); }
  if (action === "back-chat") { state.route = "chat"; render(); }
  if (action === "open-asr") { state.route = "asr"; render(); }
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
  if (action === "confirm-candidate") resolveCandidate("confirm");
  if (action === "confirm-edited-candidate") resolveCandidate("confirm-edited");
  if (action === "reject-candidate") resolveCandidate("reject");
  if (action === "delete-asset") deleteAsset(state.assets.find((asset) => String(assetId(asset)) === button.dataset.assetId));
  if (action === "revise-asset") reviseTimelineAsset((state.timeline ?? []).find((entry) => String(entry.asset_id) === button.dataset.assetId));
  if (action === "refresh-deletion") refreshDeletionJob();
  if (action === "synthesize-message-audio") synthesizeMessageAudio(state.messages.find((message) => String(messageId(message)) === button.dataset.messageId));
  if (action === "delete-message-audio") deleteMessageAudio(state.messages.find((message) => String(messageId(message)) === button.dataset.messageId));
});

bootstrap();
