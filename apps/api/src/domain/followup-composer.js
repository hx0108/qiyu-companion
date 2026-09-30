'use strict';

const { PROACTIVE_TEMPLATES } = require('./proactive-templates');
const { FOLLOWUP_KIND_TO_TRIGGER, validateFollowupComposerOutput } = require('./followup-schema');

// 六项能力 A2 措辞器：规则引擎放行后，模型只能在模板槽内组织语言（不得增频、
// 不得绕过静默/频控——那些归 proactive-policy）。三路回退：模型未配置 / 模型
// 抛错 / 输出未过校验（空/超长/不含事件标题=脱 fact）→ 固定模板填词。
function composeFollowupText({ event, character, followupKind, model = null, now = new Date() } = {}) {
  const slot = FOLLOWUP_KIND_TO_TRIGGER[followupKind] ?? FOLLOWUP_KIND_TO_TRIGGER.BEFORE_EVENT;
  const template = PROACTIVE_TEMPLATES[slot] ?? '到你们确认过的时间了：「{title}」。';
  const fallbackText = template.replaceAll('{title}', event.title);
  if (typeof model !== 'function') {
    return { text: fallbackText, provider: 'template', model_version: 'followup-template-v1', template_slot: slot };
  }
  return Promise.resolve(model({ event, character, followupKind, template, fallbackText, now }))
    .then((output) => {
      const validation = validateFollowupComposerOutput(output, { eventTitle: event.title });
      if (!validation.ok) {
        return { text: fallbackText, provider: 'template-fallback', model_version: 'followup-template-v1', template_slot: slot, fallback_reason: validation.reason };
      }
      return { text: validation.value.text, provider: output.provider || 'model', model_version: output.modelVersion ?? null, template_slot: slot };
    })
    .catch(() => ({ text: fallbackText, provider: 'template-fallback', model_version: 'followup-template-v1', template_slot: slot, fallback_reason: 'MODEL_ERROR' }));
}

module.exports = { composeFollowupText };
