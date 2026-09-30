// 六项能力 A1 前端模块（生活事件 + 本轮记忆引用）。全部是纯函数：接收状态
// 返回 HTML 字符串或表单值，不直接碰全局 state（app.js 保持唯一状态源）。
// 样式复用 app.js 既有 sheet/card/field/btn 类，不新增设计体系。

const KIND_LABELS = { INTERVIEW: "面试", READING: "阅读", CREATION: "创作", OTHER: "其他" };
const DOMAIN_LABELS = { REAL_LIFE: "现实生活", FICTIONAL_SHARED: "共同虚构" };
const STATUS_LABELS = { PLANNED: "计划中", IN_PROGRESS: "进行中", COMPLETED: "已完成", CANCELLED: "已取消" };
const REF_REASON_LABELS = {
  MISSING: "来源已不存在",
  DELETED: "来源已被删除",
  SUPERSEDED: "已有新版本",
  UNSUPPORTED: "类型不受支持"
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

// life_event 候选的确认 sheet：与通用候选的差异是日期确认区——含糊时间
// （raw_time_text / time_uncertain）给出修正输入；确认必须整体字段合法
// （confirm-edited 提交完整 life_event 字段集，服务端 400 会带 missing_fields）。
function lifeEventCandidateSheet({ candidate, busy = false, draft = null }) {
  const value = candidate?.normalized_value?.life_event ?? {};
  const title = draft?.title ?? value.title ?? "";
  const scheduledAt = draft?.scheduled_at ?? value.scheduled_at ?? "";
  const vague = !scheduledAt && (value.time_uncertain === true || Boolean(value.raw_time_text));
  const kindOptions = Object.entries(KIND_LABELS).map(([code, label]) => `<option value="${code}" ${value.event_kind === code ? "selected" : ""}>${label}</option>`).join("");
  const domainOptions = Object.entries(DOMAIN_LABELS).map(([code, label]) => `<option value="${code}" ${value.domain === code ? "selected" : ""}>${label}</option>`).join("");
  return `<section class="sheet" role="dialog" aria-modal="true" aria-label="生活事件确认"><div class="grabber"></div><div class="sheet-head"><div><span class="aigc">生活事件</span><h3>这件事需要你确认</h3><p>确认前只是候选，不会自动成为事实</p></div><button class="close" data-action="back-chat" aria-label="关闭">×</button></div>
<label class="field"><span>事件标题（不超过 80 字）</span><input id="life-event-title" maxlength="80" value="${escapeHtml(title)}"></label>
<div class="button-row"><label class="field field-pair"><span>类型</span><select id="life-event-kind">${kindOptions}</select></label><label class="field field-pair"><span>归属</span><select id="life-event-domain">${domainOptions}</select></label></div>
<label class="field"><span>${vague ? "时间待确认（模型只听懂了「" + escapeHtml(value.raw_time_text ?? "大概") + "」，请补充具体时间）" : "时间（可选修改）"}</span><input id="life-event-scheduled-at" type="datetime-local" value="${escapeHtml(toLocalInputValue(scheduledAt))}"></label>
${vague ? '<div class="rights"><span>不补时间也可以确认——之后在时间线里随时补。</span></div>' : ""}
<div class="sheet-actions"><button class="btn btn-line" data-action="reject-candidate" ${busy ? "disabled" : ""}>不记住</button><button class="btn btn-secondary" data-action="confirm-edited-candidate" ${busy ? "disabled" : ""}>保存修改并确认</button><button class="btn btn-primary wide" data-action="confirm-candidate" ${busy ? "disabled" : ""}>直接确认</button></div>
<p class="note">确认后可在「关系时间线 · 事件」中改期、修订或删除；删除带服务端回执。</p></section>`;
}

// 从 DOM 收集完整 life_event 字段集（confirm-edited 的 body.life_event）。
// 空 datetime → null（清空=需要回头补时间，由服务端标记）。
function collectLifeEventCandidateFields(root = document) {
  const title = root.querySelector("#life-event-title")?.value?.trim() ?? "";
  const eventKind = root.querySelector("#life-event-kind")?.value ?? "OTHER";
  const domain = root.querySelector("#life-event-domain")?.value ?? "REAL_LIFE";
  const localValue = root.querySelector("#life-event-scheduled-at")?.value ?? "";
  const scheduledAt = localValue ? new Date(localValue).toISOString() : null;
  return { title, event_kind: eventKind, domain, scheduled_at: scheduledAt, timezone: "Asia/Shanghai" };
}

// 本轮记忆引用面板（bottom-sheet 内容）：逐项列注入来源；available:false 的
// 项只给不可用标记与原因，不回正文（服务端合同如此，前端如实呈现）。
function memoryReferenceSheet(payload) {
  const references = Array.isArray(payload?.references) ? payload.references : [];
  const rows = references.map((ref) => {
    const badge = ref.kind === "LIFE_EVENT" ? "事件" : "记忆";
    const label = ref.kind === "LIFE_EVENT" ? (ref.available ? ref.title : `事件 · ${shortId(ref.id)}`) : (ref.available ? ref.display_text : `记忆 · ${shortId(ref.id)}`);
    const meta = ref.available
      ? (ref.kind === "LIFE_EVENT" ? `${STATUS_LABELS[ref.status] ?? ref.status ?? ""}${ref.scheduled_at ? " · " + escapeHtml(formatWhen(ref)) : ""}` : `v${escapeHtml(ref.version ?? "?")}`)
      : `${REF_REASON_LABELS[ref.reason] ?? "不可用"}${ref.current_version ? " · 当前 v" + escapeHtml(ref.current_version) : ""}`;
    return `<div class="memory-ref-row ${ref.available ? "available" : "unavailable"}"><span class="ref-kind">${badge}</span><span class="ref-copy"><b>${escapeHtml(label)}</b><small>${meta}</small></span><span class="ref-state">${ref.available ? "可用" : "已失效"}</span></div>`;
  }).join("");
  return `<section class="sheet" role="dialog" aria-modal="true" aria-label="本轮记忆引用"><div class="grabber"></div><div class="sheet-head"><div><span class="aigc">来源透明</span><h3>这一轮参考了这些记录</h3><p>生成回复时实际注入的记忆与事件</p></div><button class="close" data-action="close-memory-refs" aria-label="关闭">×</button></div><div class="memory-ref-list">${rows || '<p class="muted">本轮没有注入任何记忆。</p>'}</div><p class="note">来源修订或删除后，这里会如实显示“已失效”，不会假装记忆仍然存在。</p></section>`;
}

// 时间线事件卡（filter=event）：修订/删除走事件路由（带版本与回执）。
function lifeEventTimelineCard(event, { busy = false } = {}) {
  const when = event.scheduled_at ? formatWhen(event) : "时间待补充";
  return `<article class="asset timeline-entry" data-entry-type="LIFE_EVENT"><div><b>${escapeHtml(event.display_text ?? event.title)}</b><small>${DOMAIN_LABELS[event.domain] ?? event.domain} · ${STATUS_LABELS[event.status] ?? event.status} · ${escapeHtml(when)} · 版本 ${escapeHtml(event.version ?? "?")}</small></div><div class="button-row"><button class="btn btn-line" data-action="revise-event" data-event-id="${escapeHtml(event.event_id)}" ${busy ? "disabled" : ""}>修订</button><button class="btn btn-danger" data-action="delete-event" data-event-id="${escapeHtml(event.event_id)}" ${busy ? "disabled" : ""}>删除</button></div></article>`;
}

// 事件修订表单（409 冲突时保留草稿重试）。
function lifeEventReviseForm(event, draft = {}) {
  const title = draft.title ?? event.title ?? "";
  const scheduledAt = draft.scheduled_at ?? event.scheduled_at ?? "";
  const statusOptions = Object.entries(STATUS_LABELS).map(([code, label]) => `<option value="${code}" ${(draft.status ?? event.status) === code ? "selected" : ""}>${label}</option>`).join("");
  return `<section class="sheet" role="dialog" aria-modal="true" aria-label="修订生活事件"><div class="grabber"></div><div class="sheet-head"><div><span class="aigc">修订</span><h3>调整这件事</h3><p>旧版本会保留历史，只改日期不会自动改完成状态</p></div><button class="close" data-action="close-event-revision" aria-label="关闭">×</button></div>
<label class="field"><span>标题</span><input id="event-revise-title" maxlength="80" value="${escapeHtml(title)}"></label>
<label class="field"><span>时间</span><input id="event-revise-scheduled-at" type="datetime-local" value="${escapeHtml(toLocalInputValue(scheduledAt))}"></label>
<label class="field"><span>状态</span><select id="event-revise-status">${statusOptions}</select></label>
<div class="sheet-actions"><button class="btn btn-line" data-action="close-event-revision">取消</button><button class="btn btn-primary wide" data-action="submit-event-revision" data-event-id="${escapeHtml(event.event_id)}" data-expected-version="${escapeHtml(event.version)}">保存修改</button></div></section>`;
}

// datetime-local 需要 YYYY-MM-DDTHH:mm 本地格式。
function toLocalInputValue(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInputValue(local) {
  if (!local) return null;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatWhen(ref) {
  const date = new Date(ref.scheduled_at);
  if (Number.isNaN(date.getTime())) return String(ref.scheduled_at ?? "");
  return ref.time_precision === "MINUTE" ? date.toLocaleString() : date.toLocaleDateString();
}

function shortId(id) { return String(id ?? "").slice(-4); }

export { lifeEventCandidateSheet, collectLifeEventCandidateFields, memoryReferenceSheet, lifeEventTimelineCard, lifeEventReviseForm, fromLocalInputValue, KIND_LABELS, DOMAIN_LABELS, STATUS_LABELS };
