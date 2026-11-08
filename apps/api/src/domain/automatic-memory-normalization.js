'use strict';

const DAY_MS = 86400000;
const drinks = new Map([
  ['茶', 'tea'], ['咖啡', 'coffee'], ['热美式', 'hot_americano'], ['热美式咖啡', 'hot_americano']
]);
const equivalentHobbies = new Map([
  ['攀岩', '攀岩'], ['去攀岩', '攀岩'],
  ['烘焙', '烘焙'], ['做烘焙', '烘焙'],
  ['陶艺', '陶艺'], ['做陶艺', '陶艺'],
  ['折纸', '折纸'], ['做折纸', '折纸'],
  ['爵士乐', '爵士乐'], ['听爵士乐', '爵士乐']
]);
const foodPreferences = new Map([
  ['吃', ['酸奶', '无糖酸奶', '香菜', '鸡蛋', '豆腐', '饺子', '牛肉面', '番茄']],
  ['喝', ['豆浆', '热豆浆', '冰豆浆', '牛奶', '无糖牛奶', '柠檬水', '气泡水']]
].flatMap(([verb, foods]) => foods.flatMap((food) => [[food, [food, verb + food]], [verb + food, [food, verb + food]]])));

function normalizeMemoryFact(category, quote) {
  if (category === 'communication' &&
      /^(?:(?:以后|今后|往后|此后|现在|其实)\s*)?(?:我(?:希望|喜欢|更喜欢)你|希望你|请你?|回答我|回复我|的(?:回答|回复|答复))/.test(quote) &&
      /(?:回答|答复|回复|说话|表达)/.test(quote)) {
    const choices = [
      ['direct', /直接|直白/], ['concise', /简短|简洁|精简|言简意赅/], ['detailed', /详细|细致|多解释/]
    ].filter(([, pattern]) => pattern.test(quote));
    if (choices.length === 1 && !/不|别|少|无需|或者/.test(quote)) {
      return { key: 'communication.response_style', value: choices[0][0], revisable: true };
    }
  }
  if (category === 'preference' || category === 'interest') {
    const match = /^(?:(?:其实|现在|目前)\s*)?我(?:特别|很|比较|更|挺|蛮|最)?(?:(不喜欢|讨厌)|喜欢|爱|偏爱|偏好)([\p{L}\p{N}]{1,24})$/u.exec(quote);
    if (match) {
      const value = match[1] ? 'dislike' : 'like';
      const object = match[2].normalize('NFKC').toLowerCase();
      const drink = drinks.get(object.replace(/^喝/, ''));
      if (drink) return { key: `user.preference.drink:${drink}`, value, revisable: true };
      const hobby = equivalentHobbies.get(object);
      const food = foodPreferences.get(object);
      const canonical = hobby || food?.[0] || object;
      const aliases = hobby ? [...equivalentHobbies].filter(([, name]) => name === hobby).map(([alias]) => alias) : food || [match[2]];
      return {
        key: `v2:preference:${canonical}`, value, revisable: Boolean(hobby || food),
        relatedKeys: [
          ...aliases.map((alias) => `user.preference:${alias}`),
          ...aliases.filter((alias) => alias !== canonical && (hobby || food)).map((alias) => `v2:preference:${alias}`)
        ]
      };
    }
  }
  return null;
}

function groundedPreferenceAnswer(quote, previous) {
  if (previous?.actor !== 'ASSISTANT') return null;
  const question = previous.text.trim();
  if (/^(?:你|您)(?:最|更)?喜欢(?:喝什么|喝?哪种饮品)[？?]?$/.test(question) && drinks.has(quote)) {
    return { key: `user.preference.drink:${drinks.get(quote)}`, value: 'like', displayText: `喜欢喝${quote}`, revisable: false };
  }
  const activityPhrase = /^(?:练习|制作|演奏|修复|录制|研究|临摹|修理|冲洗|调制|拼贴|自制)[\p{L}\p{N}]{2,16}$/u.test(quote) &&
    !/这个|那个|这种|那种|这些|那些|之前|刚才/.test(quote);
  if (/^(?:你|您)(?:平时|最)?(?:喜欢做什么|有什么爱好)[？?]?$/.test(question) &&
      (equivalentHobbies.has(quote) || activityPhrase)) {
    const fact = normalizeMemoryFact('interest', `我喜欢${quote}`);
    return { ...fact, displayText: `喜欢${quote}`, revisable: false };
  }
  return null;
}

const calendarDigits = '〇一二三四五六七八九';
function calendarPart(text) {
  if (/^\d+$/.test(text)) return Number(text);
  if (/^[一二三四五六七八九]$/.test(text)) return calendarDigits.indexOf(text);
  const tens = /^([二三])?十([一二三四五六七八九])?$/.exec(text);
  return tens ? (tens[1] ? calendarDigits.indexOf(tens[1]) : 1) * 10 + (tens[2] ? calendarDigits.indexOf(tens[2]) : 0) : NaN;
}

// Expire at the next local midnight using the account's scheduling offset.
// Do not invent a year or treat a lunar date as a Gregorian date.
function explicitMemoryExpiry(quote, utcOffsetMinutes) {
  const normalized = quote.normalize('NFKC');
  if (/(?:农历|阴历).{0,16}月|(?:正|腊)月/.test(normalized)) return { kind: 'ambiguous' };
  const matches = [...normalized.matchAll(/(?<![\d〇零一二三四五六七八九十])(?:(?:(\d{4}|[〇零一二三四五六七八九]{4})年)?([\d〇零一二三四五六七八九十]+)月([\d〇零一二三四五六七八九十]+)(?:日|号)|(\d{4})-(\d{2})-(\d{2}))(?!\d)/g)];
  if (!matches.length) return { kind: 'none' };
  if (matches.length !== 1 || !Number.isInteger(utcOffsetMinutes) || Math.abs(utcOffsetMinutes) > 840) return { kind: 'invalid' };
  const [, yearZh, monthZh, dayZh, yearIso, monthIso, dayIso] = matches[0];
  const yearText = yearZh || yearIso;
  const year = yearText ? Number(yearText.replace(/[〇零一二三四五六七八九]/g, (digit) => digit === '零' ? '0' : String(calendarDigits.indexOf(digit)))) : 2000;
  const month = calendarPart(monthZh || monthIso);
  const day = calendarPart(dayZh || dayIso);
  const start = new Date(Date.UTC(year, month - 1, day));
  if (start.getUTCFullYear() !== year || start.getUTCMonth() !== month - 1 || start.getUTCDate() !== day) return { kind: 'invalid' };
  if (!yearText) return { kind: 'ambiguous' };
  return { kind: 'date', expiresAt: new Date(start.getTime() + DAY_MS - utcOffsetMinutes * 60000).toISOString() };
}

module.exports = { explicitMemoryExpiry, groundedPreferenceAnswer, normalizeMemoryFact };
