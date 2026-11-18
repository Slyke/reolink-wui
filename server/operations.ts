import { createHash } from 'node:crypto';
import { audit, type Sql } from './db.js';
import { Failure, recordError } from './errors.js';

type Outcome = 'pending' | 'confirmed' | 'unverified' | 'rejected' | 'unknown';
export type ActionResult<T = unknown> = { outcome: Outcome; reason?: string; bridgeCorrelationId?: string; data?: T };
type Stored = {
  actor: string; resource: string; action: string; fingerprint: string;
  outcome: Outcome; reason: string | null; correlation: string;
  bridge_correlation: string | null; started: number | string
};
const stalledMs = 95_000;

const publicResult = ({ row }: { row: Stored }) => {
  const stalled = row.outcome === 'pending' && Number(row.started) + stalledMs < Date.now();
  return {
    outcome: stalled ? 'unknown' : row.outcome,
    correlationId: row.correlation,
    bridgeCorrelationId: row.bridge_correlation ?? undefined,
    reason: stalled ? 'OUTCOME_UNKNOWN' : row.reason ?? undefined
  };
};

export class Operations {
  constructor(private readonly sql: Sql) {}

  async status({ id, actor }: { id: string; actor: string }) {
    const [row] = await this.sql.query<Stored>('SELECT * FROM operations WHERE id=$1 AND actor=$2', id, actor);
    if (!row) throw new Failure('BAD_INPUT', 404);
    return { id, ...publicResult({ row }) };
  }

  async run<T>({ id, actor, resource, action, correlation, reconcileGroup, bypass = false, serialized = false, input, execute }: {
    id: string; actor: string; resource: string; action: string; correlation: string; reconcileGroup?: string;
    bypass?: boolean; serialized?: boolean; input: unknown; execute: () => Promise<ActionResult<T>>;
  }) {
    const fingerprint = createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex');
    const replay = await this.sql.transaction(async query => {
      const [previous] = await query<Stored>('SELECT * FROM operations WHERE id=$1', id);
      if (previous) {
        if (previous.actor !== actor || previous.resource !== resource || previous.action !== action || previous.fingerprint !== fingerprint) {
          throw new Failure('OPERATION_CONFLICT', 409);
        }
        return previous;
      }
      if (!bypass && serialized) {
        const busy = await query('SELECT id FROM operations WHERE resource=$1 AND outcome=$2 AND started>=$3 AND reconcile_group IS NOT NULL',
          resource, 'pending', Date.now() - stalledMs);
        if (busy.length) throw new Failure('COMMAND_BUSY', 409);
      }
      if (!bypass && reconcileGroup) {
        const barriers = await query(
          "SELECT id FROM operations WHERE resource=$1 AND reconcile_group=$2 AND (outcome IN ($3,$4) OR (outcome='unverified' AND reconcile_group <> 'ptz'))",
          resource, reconcileGroup, 'unknown', 'pending'
        );
        if (barriers.length) throw new Failure('RECONCILE_REQUIRED', 409);
      }
      await query(
        'INSERT INTO operations(id,actor,resource,action,fingerprint,outcome,correlation,started,reconcile_group) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        id, actor, resource, action, fingerprint, 'pending', correlation, Date.now(), reconcileGroup ?? null
      );
      return undefined;
    });
    if (replay) return { id, ...publicResult({ row: replay }), data: undefined as T | undefined };

    let result: ActionResult<T>;
    try {
      result = await execute();
    } catch (error) {
      const known = error instanceof Failure && error.outcome !== 'unknown';
      result = { outcome: known ? 'rejected' : 'unknown', reason: known ? error.key : 'OUTCOME_UNKNOWN' };
    }
    if (result.outcome === 'rejected' || result.outcome === 'unknown' || result.outcome === 'unverified') {
      const key = { rejected:'OPERATION_REJECTED', unknown:'OPERATION_UNKNOWN', unverified:'OPERATION_UNVERIFIED' } as const;
      recordError({ key:key[result.outcome],caller:'operations::execute',correlationId:correlation,
        context:{ operation:id,action,resource,outcome:result.outcome,bridgeCorrelationId:result.bridgeCorrelationId } });
    }
    await this.sql.transaction(async query => {
      await query('UPDATE operations SET outcome=$1,reason=$2,bridge_correlation=$3 WHERE id=$4',
        result.outcome, result.reason ?? null, result.bridgeCorrelationId ?? null, id);
      await audit({ query, actor, resource, action, operation: id, correlation, outcome: result.outcome, bridgeCorrelation: result.bridgeCorrelationId });
    });
    return { id, correlationId: correlation, ...result };
  }

  async reconcile({ camera, group, before }: { camera: string; group: string; before: number }) {
    // Keep an in-flight or recently disconnected write fenced while it can still be executing on the bridge.
    await this.sql.query(
      `UPDATE operations SET outcome=CASE WHEN outcome='pending' THEN 'unknown' ELSE outcome END,reconcile_group=NULL
       WHERE resource=$1 AND reconcile_group=$2 AND ((outcome='unverified' AND started<$5) OR (outcome='unknown' AND started<$3) OR (outcome='pending' AND started<$4))`,
      camera, group, before - 28_000, before - stalledMs, before
    );
  }

}
