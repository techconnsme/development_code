// api/src/lib/journal-snapshots.ts
import { v4 as uuidv4 } from 'uuid';

interface JournalSnapshot {
  entry_number: string;
  entry_date: string;
  description: string;
  status: string;
  reference_type: string | null;
  reference_id: string | null;
  lines: Array<{
    account_code: string;
    account_name: string;
    description: string | null;
    debit: number;
    credit: number;
    project: string | null;
  }>;
}

interface AuditTrailEntry {
  id: string;
  action: string;
  user_email: string;
  created_at: string;
  snapshot: JournalSnapshot;
  changes: Array<{ field: string; old: any; new: any }>;
}

export async function createSnapshot(
  db: any,
  userId: string,
  entryId: string,
  action: string,
  previousSnapshot?: JournalSnapshot | null
): Promise<void> {
  const entry = await db.prepare(
    'SELECT * FROM journal_entries WHERE id = ?'
  ).bind(entryId).first();
  if (!entry) return;

  const lines = await db.prepare(
    'SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY sort_order'
  ).bind(entryId).all();

  const snapshot: JournalSnapshot = {
    entry_number: (entry as any).entry_number,
    entry_date: (entry as any).entry_date,
    description: (entry as any).description,
    status: (entry as any).status,
    reference_type: (entry as any).reference_type,
    reference_id: (entry as any).reference_id,
    lines: (lines.results as any[]).map(l => ({
      account_code: l.account_code,
      account_name: l.account_name,
      description: l.description,
      debit: l.debit,
      credit: l.credit,
      project: l.project,
    })),
  };

  const changedFields = previousSnapshot
    ? computeChangedFields(previousSnapshot, snapshot)
    : [];

  const id = `js-${uuidv4().slice(0, 8)}`;
  await db.prepare(
    'INSERT INTO journal_entry_snapshots (id, user_id, entry_id, snapshot, action, changed_fields) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(
    id, userId, entryId,
    JSON.stringify(snapshot),
    action,
    changedFields.length > 0 ? JSON.stringify(changedFields) : null
  ).run();
}

export async function getLatestSnapshot(
  db: any,
  entryId: string
): Promise<JournalSnapshot | null> {
  const row = await db.prepare(
    'SELECT snapshot FROM journal_entry_snapshots WHERE entry_id = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(entryId).first();
  return row ? JSON.parse((row as any).snapshot) : null;
}

export async function getSnapshots(
  db: any,
  entryId: string
): Promise<AuditTrailEntry[]> {
  const rows = await db.prepare(
    `SELECT js.*, u.email as user_email
     FROM journal_entry_snapshots js
     LEFT JOIN users u ON js.user_id = u.id
     WHERE js.entry_id = ?
     ORDER BY js.created_at DESC`
  ).bind(entryId).all();

  const snapshots = rows.results as any[];
  const result: AuditTrailEntry[] = [];

  for (let i = 0; i < snapshots.length; i++) {
    const current = JSON.parse(snapshots[i].snapshot) as JournalSnapshot;
    const previous = i < snapshots.length - 1
      ? JSON.parse(snapshots[i + 1].snapshot) as JournalSnapshot
      : null;

    const changes = previous
      ? computeChangedFields(previous, current)
      : snapshots[i].action === 'create'
        ? [{ field: '_entry', old: null, new: current }]
        : [{ field: '_entry', old: current, new: null }];

    result.push({
      id: snapshots[i].id,
      action: snapshots[i].action,
      user_email: snapshots[i].user_email || 'unknown',
      created_at: snapshots[i].created_at,
      snapshot: current,
      changes,
    });
  }

  return result;
}

function computeChangedFields(
  oldSnap: JournalSnapshot,
  newSnap: JournalSnapshot
): Array<{ field: string; old: any; new: any }> {
  const changes: Array<{ field: string; old: any; new: any }> = [];

  const scalarFields = ['entry_date', 'description', 'status'] as const;
  for (const field of scalarFields) {
    if (oldSnap[field] !== newSnap[field]) {
      changes.push({ field, old: oldSnap[field], new: newSnap[field] });
    }
  }

  // Compare lines by sort order
  const maxLen = Math.max(oldSnap.lines.length, newSnap.lines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldSnap.lines[i];
    const newLine = newSnap.lines[i];

    if (!oldLine && newLine) {
      changes.push({
        field: `lines[${i}]`,
        old: null,
        new: newLine,
      });
    } else if (oldLine && !newLine) {
      changes.push({
        field: `lines[${i}]`,
        old: oldLine,
        new: null,
      });
    } else if (oldLine && newLine) {
      const lineFields = ['account_code', 'account_name', 'description', 'debit', 'credit', 'project'] as const;
      for (const lf of lineFields) {
        if (oldLine[lf] !== newLine[lf]) {
          changes.push({
            field: `lines[${i}].${lf}`,
            old: oldLine[lf],
            new: newLine[lf],
          });
        }
      }
    }
  }

  return changes;
}