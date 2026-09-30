'use strict';

const { PLAN_TEMPLATES, validatePlanProposalOutput } = require('./plan-schema');

// 六项能力 A3 计划提议器（方案 §4.4）：模型提出 1-5 步建议，代码限制类型、
// 时长和依赖。三路回退（照 followup-composer）：模型未配置 / 模型抛错 /
// 输出未过校验（步骤数/长度/HTML/链接/时长越界）→ 固定三步兜底草案。
// 只听模式（LISTEN_ONLY）不生成待办——直接返回空步骤，不调用模型。
async function composePlanProposal({ templateVersion = 'INTERVIEW_PREP_V1', supportMode, event = null, character = null, model = null, now = new Date() } = {}) {
  const template = PLAN_TEMPLATES[templateVersion] ?? PLAN_TEMPLATES.INTERVIEW_PREP_V1;
  const fallback = () => ({
    title: event ? `面试前，一起准备「${event.title}」` : '面试前，一起准备一点点',
    steps: template.fallback_steps.map((step) => ({ ...step })),
    provider: 'template', model_version: 'plan-template-v1'
  });
  if (supportMode === 'LISTEN_ONLY') {
    return { title: fallback().title, steps: [], provider: 'template', model_version: 'plan-template-v1', listen_only: true };
  }
  if (typeof model !== 'function') return fallback();
  try {
    const output = await model({ template, supportMode, event, character, now });
    const validation = validatePlanProposalOutput(output);
    if (!validation.ok) {
      return { ...fallback(), provider: 'template-fallback', fallback_reason: `VALIDATION:${validation.errors[0]?.field ?? 'unknown'}` };
    }
    return { ...validation.value, provider: output.provider || 'model', model_version: output.modelVersion ?? null };
  } catch {
    return { ...fallback(), provider: 'template-fallback', fallback_reason: 'MODEL_ERROR' };
  }
}

module.exports = { composePlanProposal };
