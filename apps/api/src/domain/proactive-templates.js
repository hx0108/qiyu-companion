'use strict';

// 主动消息固定模板（PRD 3.7）：规则引擎放行后只按槽位填词。
// 禁止内疚、惩罚、嫉妒或关系破裂诱导话术；模型在生产中只能在槽内改写措辞。
const PROACTIVE_TEMPLATES = Object.freeze({
  SUBSCRIBED_MORNING: '早安。新的一天，按你自己的节奏来就好。',
  SUBSCRIBED_EVENING: '晚安。今天到这里就够了，好好休息。',
  CONFIRMED_ANNIVERSARY: '今天是你们确认过的「{title}」。谢谢你的记得。',
  CONFIRMED_BIRTHDAY: '今天是「{title}」。祝你生日快乐。',
  CONFIRMED_APPOINTMENT: '到你们约定的时间了：「{title}」。',
  CONFIRMED_REALITY_ACTION: '你之前说好的小行动「{title}」，现在方便做一点点吗？不做也没关系。'
});

module.exports = { PROACTIVE_TEMPLATES };
