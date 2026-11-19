import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import pg from 'pg';
import type { Config } from './config.js';
import type { PreviewAlert } from '../shared/playback.js';
import { permissions, type Permission } from '../shared/access.js';

type Row = Record<string, unknown>;
type Scalar = string | number | null;
export type Sql = {
  query: <T extends Row = Row>(statement: string, ...parameters: Scalar[]) => Promise<T[]>;
  transaction: <T>(work: (query: Sql['query']) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
};

const migrations = [
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, username TEXT UNIQUE, password_hash TEXT,
    admin INTEGER NOT NULL CHECK (admin IN (0, 1)), enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    CHECK ((username IS NULL AND password_hash IS NULL) OR (username IS NOT NULL AND password_hash IS NOT NULL))
  );
  CREATE TABLE identities (
    issuer TEXT NOT NULL, subject TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    PRIMARY KEY (issuer, subject)
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    method TEXT NOT NULL CHECK (method IN ('local', 'oidc', 'proxy')),
    issuer TEXT, subject TEXT, expires BIGINT NOT NULL
  );
  CREATE INDEX sessions_expiry ON sessions(expires);
  CREATE TABLE oidc_flows (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, nonce TEXT NOT NULL, verifier TEXT NOT NULL, expires BIGINT NOT NULL
  );
  CREATE INDEX oidc_flows_expiry ON oidc_flows(expires);
  CREATE TABLE bridges (id TEXT PRIMARY KEY);
  CREATE TABLE cameras (
    id TEXT PRIMARY KEY, bridge_id TEXT NOT NULL REFERENCES bridges(id), remote_id TEXT NOT NULL,
    UNIQUE (bridge_id, remote_id)
  );
  CREATE TABLE grants (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    camera_id TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    permissions TEXT NOT NULL,
    PRIMARY KEY (account_id, camera_id)
  );
  CREATE TABLE enrollments (
    id TEXT PRIMARY KEY, bridge_id TEXT NOT NULL REFERENCES bridges(id),
    owner_id TEXT NOT NULL REFERENCES accounts(id), created BIGINT NOT NULL
  );
  CREATE TABLE operations (
    id TEXT PRIMARY KEY, actor TEXT NOT NULL REFERENCES accounts(id), resource TEXT NOT NULL,
    action TEXT NOT NULL, fingerprint TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT,
    correlation TEXT NOT NULL, bridge_correlation TEXT, started BIGINT NOT NULL
  );
  CREATE INDEX operations_resource ON operations(resource, action, outcome);
  CREATE TABLE audit (
    id TEXT PRIMARY KEY, actor TEXT REFERENCES accounts(id), resource TEXT NOT NULL,
    action TEXT NOT NULL, outcome TEXT NOT NULL, operation TEXT,
    correlation TEXT NOT NULL, bridge_correlation TEXT, created BIGINT NOT NULL
  );
  `,
  `ALTER TABLE operations ADD COLUMN reconcile_group TEXT;
  CREATE INDEX operations_verify ON operations(resource, reconcile_group, outcome);`,
  `ALTER TABLE enrollments ADD COLUMN request TEXT;
  CREATE TABLE ptz_interrupts (movement TEXT NOT NULL, actor TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, camera TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE, expires BIGINT NOT NULL, PRIMARY KEY(movement,actor,camera));`,
  `ALTER TABLE cameras ADD COLUMN rtsp_proxy TEXT;
  ALTER TABLE bridges ADD COLUMN refreshed_at TEXT;
  CREATE TABLE event_history_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1), retention INTEGER NOT NULL CHECK (retention BETWEEN 0 AND 1000)
  );`,
  `ALTER TABLE cameras ADD COLUMN preview_interval_ms INTEGER NOT NULL DEFAULT 5000 CHECK (preview_interval_ms BETWEEN 50 AND 2147483647);
  ALTER TABLE cameras ADD COLUMN preview_refresh_on_alert TEXT NOT NULL DEFAULT 'off'
    CHECK (preview_refresh_on_alert IN ('off','any','motion','person','vehicle','pet','face','package'));`,
  `CREATE TABLE instance_settings (
    id INTEGER PRIMARY KEY CHECK (id=1),
    appearance TEXT NOT NULL DEFAULT '{}',
    inventory_interval_seconds INTEGER NOT NULL DEFAULT 10 CHECK (inventory_interval_seconds BETWEEN 1 AND 86400)
  );
  INSERT INTO instance_settings(id) VALUES (1);`,
  `ALTER TABLE bridges ADD COLUMN event_sources TEXT;`,
  `ALTER TABLE bridges ADD COLUMN connection_config TEXT;
  ALTER TABLE event_history_settings ADD COLUMN storage TEXT NOT NULL DEFAULT '{"mode":"defaults"}';`,
  `UPDATE cameras SET preview_interval_ms=2000;`,
  `ALTER TABLE cameras ADD COLUMN hardware_source TEXT;
  ALTER TABLE cameras ADD COLUMN history_key TEXT;`
];

const openSqlite = ({ path }: { path: string }): Sql => {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000');
  let chain = Promise.resolve();
  const queue = <T>(task: () => T | Promise<T>): Promise<T> => {
    const result = chain.then(task);
    chain = result.then(() => undefined, () => undefined);
    return result;
  };
  const raw: Sql['query'] = async <T extends Row>(statement: string, ...parameters: Scalar[]) => {
    const args: SQLInputValue[] = [];
    const translated = statement.replace(/\$(\d+)/g, (_, index: string) => {
      args.push(parameters[Number(index) - 1]);
      return '?';
    });
    if (args.length === 0 && !/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(translated)) {
      database.exec(translated);
      return [];
    }
    const prepared = database.prepare(translated);
    if (/^\s*SELECT\b|\bRETURNING\b/i.test(translated)) return prepared.all(...args) as T[];
    prepared.run(...args);
    return [];
  };
  return {
    query: (statement, ...parameters) => queue(() => raw(statement, ...parameters)),
    transaction: work => queue(async () => {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(raw);
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }),
    close: () => queue(() => database.close())
  };
};

const openPostgres = ({ config }: { config: Extract<Config['database'], { driver: 'postgres' }> }): Sql => {
  const pool = new pg.Pool({
    connectionString: config.url, max: 10, connectionTimeoutMillis: 2000,
    statement_timeout: 2000, idle_in_transaction_session_timeout: 5000,
    ssl: config.tls === false ? false : { rejectUnauthorized: true, ca: config.tls.ca }
  });
  // Background socket failures are observed by the next readiness check or query.
  pool.on('error', () => {});
  const query: Sql['query'] = async (statement, ...parameters) => {
    const result = await pool.query(statement, parameters.length ? parameters : undefined);
    return result.rows ?? [];
  };
  return {
    query,
    transaction: async work => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Short transactions have the same serialization semantics as BEGIN IMMEDIATE.
        await client.query('SELECT pg_advisory_xact_lock(2118827209)');
        const result = await work(async (statement, ...parameters) => {
          const reply = await client.query(statement, parameters.length ? parameters : undefined);
          return reply.rows ?? [];
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  };
};

export const openDb = async ({ config }: { config: Config['database'] }) => {
  const sql = config.driver === 'sqlite' ? openSqlite({ path: config.path }) : openPostgres({ config });
  try {
    await sql.transaction(async query => {
      await query('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)');
      const applied = await query<{ version: number }>('SELECT version FROM schema_version ORDER BY version');
      if (applied.length > migrations.length || applied.some((row, index) => row.version !== index + 1)) {
        throw new Error('Unrecognized database schema');
      }
      for (let index = applied.length; index < migrations.length; index++) {
        await query(migrations[index]);
        await query('INSERT INTO schema_version(version) VALUES ($1)', index + 1);
      }
    });
    return sql;
  } catch (error) {
    await sql.close();
    throw error;
  }
};

export type CameraRef = {
  id: string; bridge_id: string; remote_id: string; hardware_source: string | null; history_key: string | null; rtsp_proxy: string | null;
  preview_interval_ms: number; preview_refresh_on_alert: PreviewAlert;
};
export type CameraAccess = CameraRef & { permissions: Permission[] };
export type Account = { id: string; label: string; admin: number; enabled: number };
export type Session = Account & {
  expires: string | number; method: 'local' | 'oidc' | 'proxy'; issuer: string | null; subject: string | null;
};

export const camerasFor = async ({ sql, account, id }: { sql: Sql; account: Account; id?: string }): Promise<CameraAccess[]> => {
  if (account.admin === 1) {
    const rows = await sql.query<CameraRef>(
      id ? 'SELECT * FROM cameras WHERE id=$1' : 'SELECT * FROM cameras ORDER BY id', ...(id ? [id] : [])
    );
    return rows.map(row => ({ ...row, permissions: [...permissions] }));
  }
  const rows = await sql.query<CameraRef & { permissions: string }>(
    'SELECT c.*, g.permissions FROM cameras c JOIN grants g ON g.camera_id=c.id WHERE g.account_id=$1'
      + (id ? ' AND c.id=$2' : ' ORDER BY c.id'),
    account.id, ...(id ? [id] : [])
  );
  return rows.map(row => ({ ...row, permissions: JSON.parse(row.permissions) }));
};

export const audit = ({ query, actor, resource, action, outcome, operation, correlation, bridgeCorrelation }: {
  query: Sql['query']; actor?: string; resource: string; action: string; outcome: string;
  operation?: string; correlation: string; bridgeCorrelation?: string;
}) => query(
  'INSERT INTO audit(id,actor,resource,action,outcome,operation,correlation,bridge_correlation,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  randomUUID(), actor ?? null, resource, action, outcome, operation ?? null, correlation, bridgeCorrelation ?? null, Date.now()
);
