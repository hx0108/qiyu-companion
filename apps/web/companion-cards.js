// 六项能力 A3 前端卡片模块（交互成果卡片）：纯函数——接收卡片数据返回
// HTML 字符串，不直接碰全局 state（app.js 保持唯一状态源）。卡片是事件/
// 计划的服务端视图：内容按需 GET /artifacts/{id} 现场渲染，本地只做展示，
// 不存第二份可编辑事实；动作按钮只带服务端下发的动作 ID，路由归 app.js。
// 样式复用既有 sheet/card/btn 类，不新增设计体系。

const PLAN_STATE_LABELS = { DRAFT: "草案", ACTIVE: "进行中", PAUSED: "已暂停", COMPLETED: "已完成", CANCELLED: "已取消" };
const STEP_STATE_LABELS = { TODO: "待做", DONE: "已完成", SKIPPED: "已跳过" };
const EVENT_STATUS_LABELS = { PLANNED: "计划中", IN_PROGRESS: "进行中", COMPLETED: "已完成", CANCELLED: "已取消" };
const SUPPORT_MODE_LABELS = { PRACTICE_TOGETHER: "一起陪练", BREAK_DOWN_STEPS: "拆成小步骤", LISTEN_ONLY: "只听我说" };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

// 聊天流里的卡片壳（消息本体是 provider='companion-card' 的一条受控摘要）。
// 水合后 [data-artifact-id] 容器内部被替换为完整卡片——只改这个节点，绝不
// 触发整树重渲染（保输入法组合态与滚动位置）。
function companionCardShell(message) {
  const attachment = (message.attachments ?? []).find((item) => item.type === "companion-card");
  const artifactId = attachment?.artifact_id ?? "";
  const cardType = attachment?.card_type ?? "PLAN_V1";
  return `<article class="message ai"><div class="bubble"><div class="message-copy">${escapeHtml(message.text ?? "")}</div><div class="companion-card" data-artifact-id="${escapeHtml(artifactId)}" data-card-type="${escapeHtml(cardType)}"><div class="companion-card-loading">卡片加载中…</div></div></div></article>`;
}

// 水合失败兜底（§4.5）：受控文本摘要 + 重载入口，不伪装成功。
function companionCardFallback(artifactId) {
  return `<div class="companion-card-fallback"><span>卡片暂时无法加载。</span><button type="button" class="btn btn-line" data-action="reload-card" data-artifact-id="${escapeHtml(artifactId)}">重试</button></div>`;
}

// 完整卡片渲染（GET /artifacts/{id} 的 card 数据；动作 ID 来自服务端白名单）。
function companionCardBody(card) {
  if (!card || typeof card !== "object") return companionCardFallback("");
  if (card.type === "PLAN_V1") return planCardBody(card);
  if (card.type === "EVENT_V1" || card.type === "READING_LOG_V1") return eventCardBody(card);
  return companionCardFallback(card.artifact_id);
}

function planCardBody(card) {
  const steps = (card.steps ?? []).map((step) => `<li class="plan-step-row" data-step-id="${escapeHtml(step.step_id)}"><span class="step-state ${escapeHtml(step.state)}">${escapeHtml(STEP_STATE_LABELS[step.state] ?? step.state)}</span><span class="step-title">${escapeHtml(step.title)}</span>${step.estimated_minutes ? `<small>约 ${escapeHtml(String(step.estimated_minutes))} 分钟</small>` : ""}</li>`).join("");
  return `<div class="companion-card-body"><header><span class="aigc">计划卡片</span><b>${escapeHtml(card.title)}</b><small>${escapeHtml(PLAN_STATE_LABELS[card.plan_state] ?? card.plan_state)} · ${escapeHtml(SUPPORT_MODE_LABELS[card.support_mode] ?? card.support_mode)}</small></header>${steps ? `<ol class="plan-step-list">${steps}</ol>` : '<p class="muted">这份计划只有陪伴，没有待办。</p>'}<footer class="card-actions">${(card.actions ?? []).map((action) => cardActionButton(action, card)).join("")}</footer></div>`;
}

function eventCardBody(card) {
  const isReading = card.type === "READING_LOG_V1";
  return `<div class="companion-card-body"><header><span class="aigc">${isReading ? "阅读记录" : "事件卡片"}</span><b>${escapeHtml(card.title)}</b><small>${escapeHtml(EVENT_STATUS_LABELS[card.status] ?? card.status)}${card.scheduled_at ? " · " + escapeHtml(new Date(card.scheduled_at).toLocaleString()) : ""}</small></header>${card.fictional ? '<p class="card-fictional-tag">共同虚构剧情 · 不是现实经历</p>' : ""}${isReading && card.note ? `<p class="muted">${escapeHtml(card.note)}</p>` : ""}<footer class="card-actions">${(card.actions ?? []).map((action) => cardActionButton(action, card)).join("")}</footer></div>`;
}

// 动作按钮：data-card-action 只带服务端白名单下发的动作 ID；未知动作不渲染。
// 计划类动作的目标 plan_id 取卡片 source（服务端锚定的来源，非客户端拼造）。
const CARD_ACTION_LABELS = { OPEN_PLAN: "打开计划", ACCEPT_PLAN: "接受这份计划", PAUSE_PLAN: "暂停", RESUME_PLAN: "恢复", CANCEL_PLAN: "取消计划", COMPLETE_PLAN: "标记完成", OPEN_EVENT: "查看事件" };
function cardActionButton(action, card) {
  const label = CARD_ACTION_LABELS[action];
  if (!label) return "";
  const style = action === "ACCEPT_PLAN" ? "btn-primary" : action === "CANCEL_PLAN" ? "btn-danger" : "btn-line";
  const planId = card?.source?.type === "COMPANION_PLAN" ? card.source.id : "";
  return `<button type="button" class="btn ${style}" data-action="card-action" data-card-action="${escapeHtml(action)}" data-plan-id="${escapeHtml(String(planId ?? ""))}">${escapeHtml(label)}</button>`;
}

// 时间线「查看卡片」bottom-sheet 内容（EVENT_V1/READING_LOG_V1）。
function eventCardSheet(card) {
  return `<section class="sheet" role="dialog" aria-modal="true" aria-label="事件卡片"><div class="grabber"></div><div class="sheet-head"><div><span class="aigc">来源视图</span><h3>事件卡片</h3><p>这是事件当前状态的卡片视图，内容以事件为准</p></div><button class="close" data-action="close-card-sheet" aria-label="关闭">×</button></div><div class="companion-card-sheet-body">${eventCardBody(card)}</div><div class="sheet-actions"><button class="btn btn-line" data-action="export-card" data-artifact-id="${escapeHtml(card.artifact_id)}" data-format="markdown">导出 Markdown</button><button class="btn btn-secondary wide" data-action="close-card-sheet">关闭</button></div></section>`;
}

// 计划页的计划卡（草案步骤可行内编辑+接受时可选提醒勾选；进行中可暂停/
// 完成/取消）。草案编辑：step-title-input 的 change 事件触发 PATCH（app.js
// change 监听器接线），保持草案「可编辑、接受才开始」的产品语义。
function planPageCard(plan, { busy = false } = {}) {
  const editable = plan.state === "DRAFT" && !plan.expired;
  const steps = (plan.steps ?? []).map((step) => {
    const title = editable
      ? `<input class="step-title-input" data-plan-id="${escapeHtml(plan.plan_id)}" data-step-id="${escapeHtml(step.step_id)}" data-expected-version="${escapeHtml(String(plan.version))}" value="${escapeHtml(step.title)}" maxlength="80" aria-label="步骤标题（可编辑）">`
      : `<span class="step-title">${escapeHtml(step.title)}</span>`;
    return `<li class="plan-step-row"><button type="button" class="step-toggle ${step.state === "TODO" ? "" : "done"}" data-action="toggle-plan-step" data-plan-id="${escapeHtml(plan.plan_id)}" data-step-id="${escapeHtml(step.step_id)}" data-step-state="${escapeHtml(step.state)}" data-expected-version="${escapeHtml(String(plan.version))}" aria-label="${step.state === "TODO" ? "标记完成" : "退回待做"}" ${busy || editable ? "disabled" : ""}><span class="step-state ${escapeHtml(step.state)}">${escapeHtml(STEP_STATE_LABELS[step.state] ?? step.state)}</span></button>${title}${step.estimated_minutes ? `<small>约 ${escapeHtml(String(step.estimated_minutes))} 分钟</small>` : ""}</li>`;
  }).join("");
  const actions = planPageActions(plan, busy);
  return `<article class="card plan-card" data-plan-id="${escapeHtml(plan.plan_id)}"><header><b>${escapeHtml(plan.title)}</b><small>${escapeHtml(PLAN_STATE_LABELS[plan.state] ?? plan.state)} · ${escapeHtml(SUPPORT_MODE_LABELS[plan.support_mode] ?? plan.support_mode)} · 版本 ${escapeHtml(String(plan.version))}${plan.expired ? " · 草案已过期" : ""}</small></header>${steps ? `<ol class="plan-step-list">${steps}</ol>` : '<p class="muted">只听模式：没有待办，想聊就聊。</p>'}${plan.state === "DRAFT" && !plan.expired ? '<label class="field plan-reminder-optin"><input type="checkbox" class="plan-followup-checkbox"> 接受时顺便开启到期提醒（每天最多一条，可随时关）</label>' : ""}${plan.state === "PAUSED" && plan.reminder?.regrant_available ? '<p class="muted">提醒已随暂停停止；恢复后如需提醒请到事件卡重新开启。</p>' : ""}<div class="button-row">${actions}</div></article>`;
}

function planPageActions(plan, busy) {
  const disabled = busy ? "disabled" : "";
  const expected = `data-expected-version="${escapeHtml(String(plan.version))}"`;
  if (plan.state === "DRAFT") {
    if (plan.expired) return `<button class="btn btn-line" ${disabled} data-action="plan-create-draft" data-event-id="${escapeHtml(plan.event_id ?? "")}">让 TA 重新提议</button>`;
    return `<button class="btn btn-primary" data-action="plan-accept" data-plan-id="${escapeHtml(plan.plan_id)}" ${expected} ${disabled}>接受计划</button><button class="btn btn-danger" data-action="plan-action" data-plan-id="${escapeHtml(plan.plan_id)}" data-plan-action="cancel" ${expected} ${disabled}>不要了</button>`;
  }
  if (plan.state === "ACTIVE") {
    return `<button class="btn btn-line" data-action="plan-action" data-plan-id="${escapeHtml(plan.plan_id)}" data-plan-action="pause" ${expected} ${disabled}>暂停</button><button class="btn btn-secondary" data-action="plan-action" data-plan-id="${escapeHtml(plan.plan_id)}" data-plan-action="complete" ${expected} ${disabled}>全部做完了</button><button class="btn btn-danger" data-action="plan-action" data-plan-id="${escapeHtml(plan.plan_id)}" data-plan-action="cancel" ${expected} ${disabled}>取消计划</button>`;
  }
  if (plan.state === "PAUSED") {
    return `<button class="btn btn-primary" data-action="plan-action" data-plan-id="${escapeHtml(plan.plan_id)}" data-plan-action="resume" ${expected} ${disabled}>恢复</button><button class="btn btn-danger" data-action="plan-action" data-plan-id="${escapeHtml(plan.plan_id)}" data-plan-action="cancel" ${expected} ${disabled}>取消计划</button>`;
  }
  return "";
}

export { companionCardShell, companionCardBody, companionCardFallback, eventCardSheet, planPageCard, PLAN_STATE_LABELS, STEP_STATE_LABELS, SUPPORT_MODE_LABELS };
