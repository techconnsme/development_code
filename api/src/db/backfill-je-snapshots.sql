-- Backfill: create initial 'create' snapshot for every existing journal entry
-- that doesn't already have a snapshot.

INSERT INTO journal_entry_snapshots (id, user_id, entry_id, snapshot, action, changed_fields, created_at)
SELECT
  'js-' || substr(hex(randomblob(4)), 1, 8) as id,
  je.user_id,
  je.id as entry_id,
  (
    SELECT json_object(
      'entry_number', je.entry_number,
      'entry_date', je.entry_date,
      'description', je.description,
      'status', je.status,
      'reference_type', je.reference_type,
      'reference_id', je.reference_id,
      'lines', (
        SELECT json_group_array(
          json_object(
            'account_code', jl.account_code,
            'account_name', jl.account_name,
            'description', jl.description,
            'debit', jl.debit,
            'credit', jl.credit,
            'project', NULL
          )
        )
        FROM journal_lines jl
        WHERE jl.entry_id = je.id
        ORDER BY jl.sort_order
      )
    )
  ) as snapshot,
  'create' as action,
  NULL as changed_fields,
  je.created_at
FROM journal_entries je
WHERE je.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM journal_entry_snapshots js WHERE js.entry_id = je.id
  );
