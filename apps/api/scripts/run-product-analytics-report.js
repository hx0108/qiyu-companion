'use strict';

const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

const reports = {
  'closed-trial': [
    ['access', 'closed-trial-access-report.sql', 2],
    ['first_chat', 'closed-trial-first-chat-report.sql', 4],
    ['core_activation', 'closed-trial-core-activation-report.sql', 4],
    ['voice_turns', 'closed-trial-voice-turn-report.sql', 4],
    ['text_return', 'closed-trial-text-return-report.sql', 4],
    ['behavior', 'closed-trial-behavior-report.sql', 2],
    ['behavior_delivery', 'closed-trial-behavior-delivery-report.sql', 2],
    ['quality_feedback', 'closed-trial-quality-feedback-report.sql', 2]
  ],
  'development-simulated': [
    ['offers', 'development-subscription-offer-report.sql', 3],
    ['payments', 'development-subscription-payment-report.sql', 3],
    ['trial_conversion', 'development-subscription-trial-report.sql', 3],
    ['first_renewal', 'development-first-renewal-report.sql', 3]
  ]
};

function parseReportOptions(args) {
  const options = Object.create(null);
  for (const argument of args) {
    const match = /^--(mode|from|to|as-of|coverage-from)=(.+)$/.exec(argument);
    if (!match || Object.hasOwn(options, match[1])) throw new Error('报表参数无效或重复');
    options[match[1]] = match[2];
  }
  if (!Object.hasOwn(reports, options.mode)) throw new Error('mode 必须为 closed-trial 或 development-simulated');
  const date = (name) => {
    const value = options[name];
    const parsed = value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      ? new Date(value) : new Date(NaN);
    if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} 必须是含时区的 ISO 时间`);
    return parsed.toISOString();
  };
  const from = date('from');
  const to = date('to');
  const asOf = date('as-of');
  const coverageFrom = options.mode === 'closed-trial' ? date('coverage-from') : null;
  if (!(from < to && to <= asOf) || (coverageFrom && coverageFrom > asOf)) throw new Error('报表时间窗口无效');
  if (options.mode === 'development-simulated' && options['coverage-from']) throw new Error('模拟支付报表无需 coverage-from');
  return { mode: options.mode, from, to, asOf, coverageFrom };
}

async function runProductAnalyticsReport(client, { mode, from, to, asOf, coverageFrom }) {
  const report = {
    mode, from, to, as_of: asOf, coverage_from: coverageFrom,
    ...(mode === 'development-simulated' ? { offer_cohort_version: 2 } : {}),
    real_subscription_conversion: { status: 'NOT_APPLICABLE' },
    reports: {}
  };
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '20s'");
    for (const [key, file, count] of reports[mode]) {
      const sql = await readFile(join(__dirname, file), 'utf8');
      const parameters = [from, to, asOf, coverageFrom].slice(0, count);
      report.reports[key] = (await client.query(sql, parameters)).rows;
    }
    await client.query('COMMIT');
    return report;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  }
}

async function main() {
  const options = parseReportOptions(process.argv.slice(2));
  const connectionString = process.env.QIYU_ANALYTICS_READONLY_DATABASE_URL;
  if (!connectionString) throw new Error('需要明确配置 QIYU_ANALYTICS_READONLY_DATABASE_URL');
  const { Client } = require('pg');
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const { rows: [identity] } = await client.query(`SELECT NOT (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)
      AND NOT pg_has_role(current_user, 'qiyu_app', 'MEMBER') AS permitted FROM pg_roles WHERE rolname = current_user`);
    if (!identity?.permitted) throw new Error('报表命令需要独立分析登录身份');
    await client.query('SET ROLE qiyu_product_analytics_reader');
    const report = await runProductAnalyticsReport(client, options);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.code ? `报表执行失败（${error.code}）` : '报表执行失败，请核对连接设置和时间参数');
    process.exitCode = 1;
  });
}

module.exports = { parseReportOptions, runProductAnalyticsReport };
