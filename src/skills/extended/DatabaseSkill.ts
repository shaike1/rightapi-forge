import { exec } from 'child_process';
import { promisify } from 'util';
import type { Skill } from '../../types/index.js';
import { shellEscape, assertSafeIdentifier } from '../../utils/shellEscape.js';
import { encode, ok, fail } from '../SkillResult.js';
import type { ServerRegistry } from '../../monitoring/ServerRegistry.js';
import type { RemoteExecutor } from '../../monitoring/RemoteExecutor.js';

const execAsync = promisify(exec);

export interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  data?: any;
}

interface PgParams {
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  password?: string;
  query?: string;
  output?: string;
  serverId?: string;
  minMinutes?: number;
  pid?: number;
}

interface MysqlParams extends PgParams {}

// Database Skill (PostgreSQL + MySQL).
//
// Exposes per-command handler methods so SkillManager's single-object dispatch
// works (handler.call(executor, params)). The legacy `execute(action, params)`
// entry point is preserved as a thin dispatcher so the existing REST router in
// src/web/extendedSkillsApi.ts keeps working.
export class DatabaseSkill {
  private servers?: Pick<ServerRegistry, 'get'>;
  private executor?: Pick<RemoteExecutor, 'execute'>;

  constructor(opts?: { servers?: Pick<ServerRegistry, 'get'>; executor?: Pick<RemoteExecutor, 'execute'> }) {
    this.servers = opts?.servers;
    this.executor = opts?.executor;
  }

  setServers(s: Pick<ServerRegistry, 'get'>): void { this.servers = s; }
  setExecutor(e: Pick<RemoteExecutor, 'execute'>): void { this.executor = e; }

  id = 'database';
  name = 'Database Management';
  description = 'Manage PostgreSQL and MySQL databases';
  category = 'infrastructure';
  version = '1.0.0';

  getSkill(): Skill {
    return {
      id: 'database',
      name: this.name,
      description: this.description,
      category: 'infrastructure',
      enabled: true,
      commands: [
        { name: 'db.pg.query',       description: 'Run a SQL query against PostgreSQL via psql.',                handler: 'pgQuery',       parameters: { host: 'string?', port: 'number?', user: 'string?', database: 'string?', password: 'string?', query: 'string' } },
        { name: 'db.pg.listDbs',     description: 'List PostgreSQL databases.',                                  handler: 'pgListDbs',     parameters: { host: 'string?', port: 'number?', user: 'string?', password: 'string?' } },
        { name: 'db.pg.listTables',  description: 'List tables in the public schema of a PostgreSQL database.',  handler: 'pgListTables',  parameters: { host: 'string?', port: 'number?', user: 'string?', database: 'string?', password: 'string?' } },
        { name: 'db.pg.backup',      description: 'Run pg_dump and write the backup to {output}.',               handler: 'pgBackup',      parameters: { host: 'string?', port: 'number?', user: 'string?', database: 'string?', password: 'string?', output: 'string' } },
        { name: 'db.pg.longRunningQueries', description: 'List PostgreSQL queries running longer than {minMinutes} minutes (default 5).', handler: 'pgLongRunningQueries', parameters: { serverId: 'string?', host: 'string?', port: 'number?', user: 'string?', database: 'string?', password: 'string?', minMinutes: 'number?' } },
        { name: 'db.pg.terminateQuery', description: 'Terminate a stuck PostgreSQL backend via pg_terminate_backend({pid}).', handler: 'pgTerminateQuery', parameters: { serverId: 'string?', host: 'string?', port: 'number?', user: 'string?', database: 'string?', password: 'string?', pid: 'number' } },
        { name: 'db.mysql.query',    description: 'Run a SQL query against MySQL via the mysql CLI.',            handler: 'mysqlQuery',    parameters: { host: 'string?', port: 'number?', user: 'string?', database: 'string?', password: 'string?', query: 'string' } },
        { name: 'db.mysql.listDbs',  description: 'List MySQL databases.',                                       handler: 'mysqlListDbs',  parameters: { host: 'string?', port: 'number?', user: 'string?', password: 'string?' } },
        { name: 'db.mysql.listTables', description: 'List tables in a MySQL database.',                          handler: 'mysqlListTables', parameters: { host: 'string?', port: 'number?', user: 'string?', database: 'string', password: 'string?' } },
        { name: 'db.mysql.backup',   description: 'Run mysqldump and write the backup to {output}.',             handler: 'mysqlBackup',   parameters: { host: 'string?', port: 'number?', user: 'string?', database: 'string?', password: 'string?', output: 'string' } },
      ],
    };
  }

  // ─── Per-command handlers (Skill-Manager compatible) ─────────────────────

  async pgQuery(params: PgParams = {}): Promise<string> {
    const r = await this._pgQuery(params);
    return resultToString(r);
  }

  async pgListDbs(params: PgParams = {}): Promise<string> {
    const r = await this._pgListDbs(params);
    return resultToString(r);
  }

  async pgListTables(params: PgParams = {}): Promise<string> {
    const r = await this._pgListTables(params);
    return resultToString(r);
  }

  async pgBackup(params: PgParams = {}): Promise<string> {
    const r = await this._pgBackup(params);
    return resultToString(r);
  }

  async pgLongRunningQueries(params: PgParams = {}): Promise<string> {
    const r = await this._pgLongRunningQueries(params);
    return resultToString(r);
  }

  async pgTerminateQuery(params: PgParams = {}): Promise<string> {
    const r = await this._pgTerminateQuery(params);
    return resultToString(r);
  }

  async mysqlQuery(params: MysqlParams = {}): Promise<string> {
    const r = await this._mysqlQuery(params);
    return resultToString(r);
  }

  async mysqlListDbs(params: MysqlParams = {}): Promise<string> {
    const r = await this._mysqlListDbs(params);
    return resultToString(r);
  }

  async mysqlListTables(params: MysqlParams = {}): Promise<string> {
    const r = await this._mysqlListTables(params);
    return resultToString(r);
  }

  async mysqlBackup(params: MysqlParams = {}): Promise<string> {
    const r = await this._mysqlBackup(params);
    return resultToString(r);
  }

  // ─── Legacy REST entry point ─────────────────────────────────────────────

  async execute(action: string, params: any = {}): Promise<SkillResult> {
    try {
      switch (action) {
        case 'pg-query':         return await this._pgQuery(params);
        case 'pg-list-dbs':      return await this._pgListDbs(params);
        case 'pg-list-tables':   return await this._pgListTables(params);
        case 'pg-backup':        return await this._pgBackup(params);
        case 'pg-long-running-queries': return await this._pgLongRunningQueries(params);
        case 'pg-terminate-query': return await this._pgTerminateQuery(params);
        case 'mysql-query':      return await this._mysqlQuery(params);
        case 'mysql-list-dbs':   return await this._mysqlListDbs(params);
        case 'mysql-list-tables': return await this._mysqlListTables(params);
        case 'mysql-backup':     return await this._mysqlBackup(params);
        default:
          return { success: false, output: 'Unknown action: ' + action, error: 'Unknown action' };
      }
    } catch (error: any) {
      return { success: false, output: String(error), error: error.message };
    }
  }

  // ─── Private implementation (returns SkillResult) ────────────────────────

  private async execPg(p: PgParams, cmd: string): Promise<SkillResult> {
    // db.pg.longRunningQueries / db.pg.terminateQuery honour serverId so they
    // can inspect a remote host's DB via RemoteExecutor, same pattern as
    // KubernetesSkill.execK8s. Other pg.* commands stay local-only for now.
    if (p.serverId) {
      if (!this.servers || !this.executor) return { success: false, output: 'remote host execution is not configured', error: 'unconfigured' };
      const server = this.servers.get(p.serverId);
      if (!server) return { success: false, output: `unknown server: ${p.serverId}`, error: 'unknown_server' };
      const fullCmd = `PGPASSWORD=${shellEscape(p.password ?? '')} ${cmd}`;
      try {
        const res = await this.executor.execute(server, fullCmd, { timeoutMs: 30000 });
        if (res.exitCode !== 0) return { success: false, output: res.stderr || res.stdout || `exit ${res.exitCode}`, error: `exit ${res.exitCode}` };
        return { success: true, output: res.stdout.trim() };
      } catch (e: any) { return failure(e); }
    }
    const env = { ...process.env, PGPASSWORD: p.password ?? '' };
    try {
      const r = await execAsync(cmd, { env });
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }

  private async _pgQuery(p: PgParams): Promise<SkillResult> {
    if (!p.query) return { success: false, output: 'query required', error: 'Missing query' };
    try { validatePgIdentifiers(p); } catch (e: any) { return validationError(e); }
    const env = { ...process.env, PGPASSWORD: p.password ?? '' };
    try {
      const r = await execAsync(`${buildPgCmd(p)} -c ${shellEscape(p.query)} -t`, { env });
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }

  private async _pgListDbs(p: PgParams): Promise<SkillResult> {
    try { validatePgIdentifiers(p); } catch (e: any) { return validationError(e); }
    const env = { ...process.env, PGPASSWORD: p.password ?? '' };
    try {
      const r = await execAsync(`${buildPgCmd(p)} -l -t`, { env });
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }

  private async _pgListTables(p: PgParams): Promise<SkillResult> {
    try { validatePgIdentifiers(p); } catch (e: any) { return validationError(e); }
    const env = { ...process.env, PGPASSWORD: p.password ?? '' };
    try {
      const sql = `SELECT tablename FROM pg_tables WHERE schemaname='public'`;
      const r = await execAsync(`${buildPgCmd(p)} -c ${shellEscape(sql)} -t`, { env });
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }

  private async _pgBackup(p: PgParams): Promise<SkillResult> {
    if (!p.output) return { success: false, output: 'output path required', error: 'Missing output' };
    try { validatePgIdentifiers(p); } catch (e: any) { return validationError(e); }
    const env = { ...process.env, PGPASSWORD: p.password ?? '' };
    try {
      const host = p.host || 'localhost';
      const port = p.port || 5432;
      const user = p.user || 'postgres';
      const db = p.database || 'postgres';
      // Note: shell-redirect target (output path) is escaped so paths with
      // spaces/quotes work; the target is still on the local filesystem.
      await execAsync(`pg_dump -h ${host} -p ${port} -U ${user} ${db} > ${shellEscape(p.output)}`, { env });
      return { success: true, output: 'Backup saved to ' + p.output };
    } catch (e: any) { return failure(e); }
  }

  private async _pgLongRunningQueries(p: PgParams): Promise<SkillResult> {
    try { validatePgIdentifiers(p); } catch (e: any) { return validationError(e); }
    const minutes = typeof p.minMinutes === 'number' && p.minMinutes > 0 ? p.minMinutes : 5;
    const sql = `SELECT pid, now() - query_start AS duration, state, query FROM pg_stat_activity ` +
      `WHERE state != 'idle' AND now() - query_start > interval '${minutes} minutes' ORDER BY duration DESC`;
    return this.execPg(p, `${buildPgCmd(p)} -c ${shellEscape(sql)} -t`);
  }

  private async _pgTerminateQuery(p: PgParams): Promise<SkillResult> {
    if (typeof p.pid !== 'number' || !Number.isFinite(p.pid) || p.pid <= 0) {
      return { success: false, output: 'pid required', error: 'Missing pid' };
    }
    try { validatePgIdentifiers(p); } catch (e: any) { return validationError(e); }
    const sql = `SELECT pg_terminate_backend(${Math.trunc(p.pid)})`;
    return this.execPg(p, `${buildPgCmd(p)} -c ${shellEscape(sql)} -t`);
  }

  private async _mysqlQuery(p: MysqlParams): Promise<SkillResult> {
    if (!p.query) return { success: false, output: 'query required', error: 'Missing query' };
    try { validateMysqlIdentifiers(p); } catch (e: any) { return validationError(e); }
    try {
      const r = await execAsync(`${buildMysqlCmd(p)} -e ${shellEscape(p.query)}`);
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }

  private async _mysqlListDbs(p: MysqlParams): Promise<SkillResult> {
    try { validateMysqlIdentifiers(p); } catch (e: any) { return validationError(e); }
    try {
      const r = await execAsync(`${buildMysqlCmd(p)} -e ${shellEscape('SHOW DATABASES')}`);
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }

  private async _mysqlListTables(p: MysqlParams): Promise<SkillResult> {
    if (!p.database) return { success: false, output: 'database required', error: 'Missing database' };
    try { validateMysqlIdentifiers(p); } catch (e: any) { return validationError(e); }
    try {
      const r = await execAsync(`${buildMysqlCmd(p)} -e ${shellEscape('SHOW TABLES')}`);
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }

  private async _mysqlBackup(p: MysqlParams): Promise<SkillResult> {
    if (!p.output) return { success: false, output: 'output path required', error: 'Missing output' };
    try { validateMysqlIdentifiers(p); } catch (e: any) { return validationError(e); }
    try {
      const host = p.host || 'localhost';
      const port = p.port || 3306;
      const user = p.user || 'root';
      const passOpt = p.password ? `-p${p.password}` : '';
      const db = p.database || '';
      await execAsync(`mysqldump -h ${host} -P ${port} -u ${user} ${passOpt} ${db} > ${shellEscape(p.output)}`);
      return { success: true, output: 'Backup saved to ' + p.output };
    } catch (e: any) { return failure(e); }
  }
}

function validatePgIdentifiers(p: PgParams): void {
  if (p.host) assertSafeIdentifier(p.host, 'host');
  if (p.user) assertSafeIdentifier(p.user, 'user');
  if (p.database) assertSafeIdentifier(p.database, 'database');
}

function validateMysqlIdentifiers(p: MysqlParams): void {
  if (p.host) assertSafeIdentifier(p.host, 'host');
  if (p.user) assertSafeIdentifier(p.user, 'user');
  if (p.database) assertSafeIdentifier(p.database, 'database');
}

function buildPgCmd(p: PgParams): string {
  const host = p.host || 'localhost';
  const port = p.port || 5432;
  const user = p.user || 'postgres';
  const db = p.database || 'postgres';
  return `psql -h ${host} -p ${port} -U ${user} -d ${db}`;
}

function buildMysqlCmd(p: MysqlParams): string {
  const host = p.host || 'localhost';
  const port = p.port || 3306;
  const user = p.user || 'root';
  const passOpt = p.password ? `-p${p.password}` : '';
  const db = p.database || '';
  return `mysql -h ${host} -P ${port} -u ${user} ${passOpt} ${db}`.replace(/\s+/g, ' ');
}

function validationError(e: any): SkillResult {
  return { success: false, output: e?.message ?? String(e), error: e?.message ?? String(e) };
}

function failure(e: any): SkillResult {
  return { success: false, output: String(e?.stderr ?? e?.message ?? e), error: e?.message ?? String(e) };
}

function resultToString(r: SkillResult): string {
  // Convert the legacy SkillResult shape used by the REST router into the
  // standardised SkillResult JSON the agent layer consumes.
  return r.success
    ? encode(ok({ output: r.output, data: r.data }, r.output ? r.output.split('\n')[0].slice(0, 80) : 'ok'))
    : encode(fail(r.error || r.output, 'db error'));
}
