import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA } from './schema.js';

export type Row = Record<string, any>;
export const nowIso = () => new Date().toISOString();
export const uid = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val);

/** Workspace-scoped data access. Every method requires a workspace id; there is no unscoped read of tenant tables. */
export class Db {
  raw: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.raw.exec(SCHEMA);
    // lightweight forward migration for databases created before a column existed
    const cols = (this.raw.prepare('PRAGMA table_info(outcomes)').all() as any[]).map((c) => c.name);
    if (!cols.includes('completed')) this.raw.exec("ALTER TABLE outcomes ADD COLUMN completed TEXT NOT NULL DEFAULT '[]'");
    const apCols = (this.raw.prepare('PRAGMA table_info(approvals)').all() as any[]).map((c) => c.name);
    if (!apCols.includes('approver_user_id')) this.raw.exec('ALTER TABLE approvals ADD COLUMN approver_user_id TEXT');
    if (!apCols.includes('approver_label')) this.raw.exec('ALTER TABLE approvals ADD COLUMN approver_label TEXT');
    if (!apCols.includes('separate_from_requester')) this.raw.exec('ALTER TABLE approvals ADD COLUMN separate_from_requester INTEGER NOT NULL DEFAULT 0');
    if (!apCols.includes('expires_at')) this.raw.exec('ALTER TABLE approvals ADD COLUMN expires_at TEXT');
    const actCols = (this.raw.prepare('PRAGMA table_info(actions)').all() as any[]).map((c) => c.name);
    if (!actCols.includes('quiet_hours')) this.raw.exec('ALTER TABLE actions ADD COLUMN quiet_hours TEXT');
    const sealCols = (this.raw.prepare('PRAGMA table_info(ledger_seals)').all() as any[]).map((c) => c.name);
    if (!sealCols.includes('last_rowid')) this.raw.exec('ALTER TABLE ledger_seals ADD COLUMN last_rowid INTEGER');
    const qCols = (this.raw.prepare('PRAGMA table_info(questions)').all() as any[]).map((c) => c.name);
    if (!qCols.includes('assignee_only')) this.raw.exec('ALTER TABLE questions ADD COLUMN assignee_only INTEGER NOT NULL DEFAULT 0');
    const mCols = (this.raw.prepare('PRAGMA table_info(missions)').all() as any[]).map((c) => c.name);
    if (!mCols.includes('paused')) this.raw.exec('ALTER TABLE missions ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
    // Compound Failure Arena (session 8): runs share bench_runs/bench_cases, distinguished by kind; evaluator verdicts stored separately.
    const brCols = (this.raw.prepare('PRAGMA table_info(bench_runs)').all() as any[]).map((c) => c.name);
    if (!brCols.includes('kind')) this.raw.exec("ALTER TABLE bench_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'scenario'");
    const bcCols = (this.raw.prepare('PRAGMA table_info(bench_cases)').all() as any[]).map((c) => c.name);
    if (!bcCols.includes('evaluation')) this.raw.exec('ALTER TABLE bench_cases ADD COLUMN evaluation TEXT');
  }
  exec(sql: string, ...params: any[]) { return this.raw.prepare(sql).run(...params); }
  get<T = Row>(sql: string, ...params: any[]): T | undefined { return this.raw.prepare(sql).get(...params) as T | undefined; }
  all<T = Row>(sql: string, ...params: any[]): T[] { return this.raw.prepare(sql).all(...params) as T[]; }
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try { const r = fn(); this.raw.exec('COMMIT'); return r; } catch (e) { this.raw.exec('ROLLBACK'); throw e; }
  }
  insert(table: string, row: Row) {
    const keys = Object.keys(row);
    this.exec(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => ser(row[k])));
  }
  update(table: string, id: string, workspaceId: string, patch: Row) {
    const keys = Object.keys(patch);
    this.exec(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=? AND workspace_id=?`, ...keys.map((k) => ser(patch[k])), id, workspaceId);
  }
}
const ser = (v: any) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
export const j = <T = any>(s: string | null | undefined, d: any = null): T => (s ? JSON.parse(s) : d);
