'use strict';

// 首个审核员账号引导（PG 模式，迁移 055 之后）：
//   node scripts/seed-ops-reviewer.js --username=alice --password='至少12位' \
//     --roles=REVIEWER+SECURITY_ADMIN [--mfa] [--database-url=...]
// 无此脚本则存在鸡生蛋问题：登录需要账号，建账号的 /internal/reviewer-accounts
// 又需要已登录的安全管理员。脚本只做 INSERT（幂等：同名账号已存在则报错退出），
// 密码以 scrypt 哈希落库，--mfa 时生成 TOTP 密钥并打印 otpauth:// URI
// （密钥只出现这一次）。后续账号应改用运营台 /internal/reviewer-accounts。

const nodeCrypto = require('node:crypto');
const { hashPassword, generateTotpSecret, totpUri } = require('../src/domain/reviewer-identity');

function parseArgs(argv) {
  const args = {};
  for (const part of argv) {
    if (!part.startsWith('--')) throw new Error(`无法解析参数：${part}`);
    const [key, ...rest] = part.slice(2).split('=');
    if (!key || rest.length === 0) throw new Error(`参数须为 --key=value 形式：${part}`);
    args[key] = rest.join('=');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const username = String(args.username || '').trim().toLowerCase();
  const password = String(args.password || '');
  const roles = String(args.roles || 'REVIEWER').split('+').map((role) => role.trim().toUpperCase()).filter(Boolean);
  const mfaRequired = args.mfa === '1' || args.mfa === 'true';
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('username 须为 3-32 位小写字母/数字/._-');
  if (password.length < 12) throw new Error('password 至少 12 位');
  const allowed = ['REVIEWER', 'RELEASE', 'SECURITY_ADMIN'];
  if (roles.some((role) => !allowed.includes(role))) throw new Error(`roles 只能是 ${allowed.join('+')}`);

  const databaseUrl = args['database-url'] || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('需要 DATABASE_URL 或 --database-url');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: databaseUrl });
  const mfaSecret = mfaRequired ? generateTotpSecret() : null;
  try {
    const { rows } = await pool.query(`INSERT INTO reviewer_accounts (username, password_hash, display_name, roles, mfa_required, mfa_secret)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING reviewer_id`,
      [username, hashPassword(password), username, roles, mfaRequired, mfaSecret]);
    console.log(`已创建审核员 ${username}（${roles.join('+')}，reviewer_id=${rows[0].reviewer_id}）`);
    if (mfaRequired) console.log(`TOTP 密钥（仅此一次）：${mfaSecret}\n认证器导入：${totpUri({ username, mfa_secret: mfaSecret })}`);
    console.log('登录：POST /internal/auth/login { username, password, totp_code }');
  } finally {
    await pool.end();
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
