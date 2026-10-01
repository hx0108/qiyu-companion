'use strict';

// 六项能力 A4 固定回归集：计划提议与卡片内容（10 条 = 提议回退 3 +
// schema 拒绝 4 + 卡片边界 3）。数据均为合成；异步用例（composePlanProposal）
// 由 runner await，期望为确定性判定。

const EVENT = Object.freeze({ event_id: 'levt_pc', title: '周五的产品经理面试', scheduled_at: '2026-10-09T06:30:00.000Z' });

const CASES = Object.freeze([
  // —— 提议三路回退（plan-composer）——
  {
    case_id: 'PCR-01', kind: 'PROPOSAL_FALLBACK', label: '模型抛错 → 固定三步兜底（MODEL_ERROR）',
    model: async () => { throw new Error('provider down'); },
    expect: { provider: 'template-fallback', fallback_reason: 'MODEL_ERROR', steps: 3 }
  },
  {
    case_id: 'PCR-02', kind: 'PROPOSAL_FALLBACK', label: '模型输出不合法（步骤含 HTML）→ 模板兜底（VALIDATION 前缀）',
    model: async () => ({ title: '面试准备', steps: [{ title: '看 <b>资料</b>', estimated_minutes: 20 }] }),
    expect: { provider: 'template-fallback', fallback_reason_prefix: 'VALIDATION:', steps: 3 }
  },
  {
    case_id: 'PCR-03', kind: 'PROPOSAL_FALLBACK', label: '模型未配置 → 模板（不标 fallback）',
    model: null,
    expect: { provider: 'template', steps: 3 }
  },
  // —— schema 拒绝（validatePlanProposalOutput）——
  {
    case_id: 'PCR-04', kind: 'SCHEMA_REJECT', label: '提议标题含 HTML → 拒绝',
    raw: { title: '面试<script>', steps: [{ title: '步骤', estimated_minutes: 20 }] },
    expect: { ok: false, field: 'title' }
  },
  {
    case_id: 'PCR-05', kind: 'SCHEMA_REJECT', label: '步骤标题含链接 → 拒绝',
    raw: { title: '面试准备', steps: [{ title: '看 https://evil.example', estimated_minutes: 20 }] },
    expect: { ok: false, field_contains: 'steps[0]' }
  },
  {
    case_id: 'PCR-06', kind: 'SCHEMA_REJECT', label: '超过 5 步 → 拒绝',
    raw: { title: '面试准备', steps: Array.from({ length: 6 }, () => ({ title: '步骤' })) },
    expect: { ok: false, field: 'steps' }
  },
  {
    case_id: 'PCR-07', kind: 'SCHEMA_REJECT', label: '步骤时长越界（3 分钟）→ 拒绝',
    raw: { title: '面试准备', steps: [{ title: '步骤', estimated_minutes: 3 }] },
    expect: { ok: false, field_contains: 'steps[0]' }
  },
  // —— 卡片边界（artifact-card）——
  {
    case_id: 'PCR-08', kind: 'CARD_BOUNDARY', label: '事件标题含标记起始符 → 整卡拒绝（不是转义放行）',
    card: { artifact_id: 'art_t' }, event: { ...EVENT, title: '面试<link>准备' },
    expect: { ok: false }
  },
  {
    case_id: 'PCR-09', kind: 'CARD_BOUNDARY', label: '白名单外动作 → 拒绝',
    actions: ['OPEN_PLAN', 'EXECUTE_SHELL'],
    expect: { ok: false }
  },
  {
    case_id: 'PCR-10', kind: 'CARD_BOUNDARY', label: 'Markdown 导出不含链接/标记形态',
    card: { type: 'PLAN_V1', title: '面试准备', source: { type: 'COMPANION_PLAN', version: 2 }, plan_state: 'ACTIVE', support_mode: 'PRACTICE_TOGETHER', steps: [
      { step_id: 's1', title: '练自我介绍', estimated_minutes: 20, state: 'DONE' },
      { step_id: 's2', title: '准备问题', estimated_minutes: 15, state: 'TODO' }
    ], actions: ['OPEN_PLAN'] },
    expect: { no_html: true, no_link: true, has_checkbox: true }
  }
]);

module.exports = { CASES, EVENT };
