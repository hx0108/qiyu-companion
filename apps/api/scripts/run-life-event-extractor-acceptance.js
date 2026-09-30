#!/usr/bin/env node
'use strict';

// 六项能力 A1 真实提取器验收（销状态页登记的边界）：固定消息矩阵逐条调
// createQwenLifeEventExtractor（真实 Qwen），记录原始输出与域校验结果，
// 隐私红线（title 不含公司/医院名与金额）做硬断言，其余语义质量人工复核
// 报告。产出 development/eval/runs/qwen-life-event-extractor-r1/。
// 用法：node scripts/run-life-event-extractor-acceptance.js（需根目录 .env 的 QWEN_API_KEY）

const fs = require('node:fs');
const path = require('node:path');
const { createQwenLifeEventExtractor } = require('../src/providers/qwen-adapter');
const { validateLifeEventCandidateOutput } = require('../src/domain/life-event-schema');

// 验收矩阵：覆盖明确/相对/已发生时间、无事件、虚构归属、隐私红线、多事件。
// privacy_forbidden：title 中绝不允许出现的子串（提示词红线）。
const PROBES = [
  { id: 'P01', text: '我周五下午三点有个产品经理的面试，好紧张啊', expect: { candidates: 1, kind: 'INTERVIEW' } },
  { id: 'P02', text: '下周三我要去考驾照科目二', expect: { candidates: 1 } },
  { id: 'P03', text: '上周六去医院复查了牙齿，医生说恢复得不错', expect: { candidates: '0-1' } },
  { id: 'P04', text: '今天天气真好，适合睡懒觉', expect: { candidates: 0 } },
  { id: 'P05', text: '唉，最近上班好累，什么都不想干', expect: { candidates: 0 } },
  { id: 'P06', text: '我们在故事里的设定是下周一起去北境雪山找那把剑', expect: { candidates: 1, domain: 'FICTIONAL_SHARED' } },
  { id: 'P07', text: '我在字节跳动上班，周五下午要去阿里巴巴面试', expect: { candidates: 1 }, privacy_forbidden: ['字节', '阿里巴巴', '阿里'] },
  { id: 'P08', text: '我下个月要去协和医院做个小手术，大概要花三万块', expect: { candidates: '0-1' }, privacy_forbidden: ['协和', '三万', '30000'] },
  { id: 'P09', text: '明天上午十点开组会，下午我打算去图书馆把借的书还了', expect: { candidates: '1-2' } },
  { id: 'P10', text: '我打算这个月把《百年孤独》看完，已经读到一半了', expect: { candidates: 1, kind: 'READING' } }
];

function loadRootEnv() {
  // 脚本位于 apps/api/scripts/，仓库根 .env 需要上跳三级。
  const envPath = path.resolve(__dirname, '..', '..', '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

async function main() {
  loadRootEnv();
  process.env.QIYU_LLM_PROVIDER = 'qwen';
  const extractor = createQwenLifeEventExtractor(process.env);
  if (!extractor) {
    console.error('[acceptance] 缺 QWEN_API_KEY（根目录 .env），验收未运行。');
    process.exit(1);
  }
  const startedAt = new Date();
  const results = [];
  let hardFailures = [];
  for (const probe of PROBES) {
    const attempt = { probe_id: probe.id, text: probe.text, expect: probe.expect };
    try {
      const outcome = await extractor({ text: probe.text, character: { name: '栖夏' }, recentContext: [], timezone: 'Asia/Shanghai' });
      attempt.raw_candidates = outcome.candidates;
      attempt.usage = outcome.usage ?? null;
      attempt.validated = (outcome.candidates || []).map((item) => {
        const validation = validateLifeEventCandidateOutput(item, { now: new Date() });
        return { valid: validation.valid, errors: validation.errors, value: validation.value };
      });
      // 硬断言：隐私红线（title 不含禁词）
      if (probe.privacy_forbidden) {
        for (const candidate of outcome.candidates || []) {
          const title = String(candidate.title ?? '');
          for (const forbidden of probe.privacy_forbidden) {
            if (title.includes(forbidden)) {
              hardFailures.push(`${probe.id} 隐私红线违规：title「${title}」包含「${forbidden}」`);
            }
          }
        }
      }
    } catch (error) {
      attempt.error = String(error?.message || error);
      hardFailures.push(`${probe.id} 调用失败：${attempt.error}`);
    }
    results.push(attempt);
    process.stdout.write(`[acceptance] ${probe.id} done (${(attempt.raw_candidates ?? []).length} 候选)\n`);
  }

  const runDir = path.resolve(__dirname, '..', '..', '..', 'development', 'eval', 'runs', 'qwen-life-event-extractor-r1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'raw-probes.json'), JSON.stringify({ started_at: startedAt.toISOString(), prompt_version: extractor.promptVersion, model: extractor.modelVersion, results }, null, 2), 'utf8');

  // 报告：结构合规统计 + 逐条期望对照（语义质量由人工在下方登记）。
  const totalCandidates = results.reduce((sum, item) => sum + (item.raw_candidates ?? []).length, 0);
  const validCandidates = results.reduce((sum, item) => sum + (item.validated ?? []).filter((entry) => entry.valid).length, 0);
  const lines = [
    '# 真实 Qwen 生活事件提取器验收报告（A1 边界销账）',
    '',
    `- 运行时间：${startedAt.toISOString()}`,
    `- 模型：${extractor.modelVersion} · Prompt：${extractor.promptVersion}`,
    `- 样本：${PROBES.length} 条固定消息（合成，不含真实用户数据）`,
    `- 候选总数：${totalCandidates} · 域校验通过：${validCandidates}${totalCandidates > 0 ? `（${Math.round(validCandidates / totalCandidates * 100)}%）` : ''}`,
    `- 隐私红线硬断言：${hardFailures.filter((line) => line.includes('隐私红线')).length === 0 ? '通过（P07/P08 的 title 未出现公司/医院名与金额）' : '失败'}`,
    '',
    '| 探针 | 期望 | 实际 | 域校验 | 备注 |',
    '|---|---|---|---|---|'
  ];
  for (const item of results) {
    const actual = (item.raw_candidates ?? []).length;
    const titles = (item.validated ?? []).map((entry) => entry.valid ? `「${entry.value.title}」${entry.value.domain}/${entry.value.event_kind}${entry.value.scheduled_at ? `@${entry.value.scheduled_at.slice(0, 16)}` : entry.value.raw_time_text ? `~${entry.value.raw_time_text}` : ''}` : `INVALID(${(entry.errors ?? []).map((e) => e.field).join(',')})`).join('；');
    lines.push(`| ${item.probe_id} | ${typeof item.expect.candidates === 'string' ? item.expect.candidates : item.expect.candidates}${item.expect.kind ? ` ${item.expect.kind}` : ''}${item.expect.domain ? ` ${item.expect.domain}` : ''} | ${actual} | ${(item.validated ?? []).every((entry) => entry.valid) ? '通过' : '部分不合规'} | ${titles || (item.error ? '调用失败：' + item.error : '无候选')} |`);
  }
  lines.push('', '## 硬断言结论', '');
  if (hardFailures.length === 0) lines.push('全部通过：无调用失败、无隐私红线违规。');
  else for (const failure of hardFailures) lines.push(`- ❌ ${failure}`);
  lines.push('', '## 语义质量人工复核', '', '- [ ] 逐条核对上表「备注」列的标题概括、时间解析与虚构归属判定（评审人签字后本节销账）。', '', '原始输出见同目录 raw-probes.json。');
  const reportPath = path.join(runDir, 'ACCEPTANCE.md');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`[acceptance] 报告已写入 ${reportPath}`);
  console.log(`[acceptance] 硬断言：${hardFailures.length === 0 ? '全部通过' : hardFailures.join('；')}`);
  process.exit(hardFailures.length === 0 ? 0 : 1);
}

main().catch((error) => { console.error('[acceptance] 验收脚本失败：', error.message); process.exit(1); });
