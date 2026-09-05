'use strict';

// Repository owns transaction and RLS scope establishment. Domain state mapping
// remains in PostgresStore so it can preserve the existing M1 Store contract.
class PostgresRepository {
  constructor(client) { this.client = client; }

  async beginAccountScope(accountId) {
    await this.client.query('BEGIN');
    await this.client.query('SET LOCAL ROLE qiyu_app');
    await this.client.query("SELECT set_config('app.account_id', $1, true), set_config('app.character_id', '', true)", [accountId]);
  }

  async seedDevelopmentAccount(accountId, noticeId) {
    await this.client.query('INSERT INTO accounts (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING', [accountId]);
    await this.client.query('INSERT INTO account_interaction_controls (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING', [accountId]);
    await this.client.query(`INSERT INTO required_notices (notice_id, account_id, type, notice_version, state)
      VALUES ($1, $2, 'AI_IDENTITY', 'ai_identity_m1.0', 'PENDING') ON CONFLICT (account_id, type, notice_version) DO NOTHING`, [noticeId, accountId]);
  }

  commit() { return this.client.query('COMMIT'); }
  rollback() { return this.client.query('ROLLBACK'); }
}

module.exports = { PostgresRepository };
