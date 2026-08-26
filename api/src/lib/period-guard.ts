/** Prevent mutations on closed accounting periods (shared by bookkeeping + invoice posting). */
export async function checkPeriodOpen(db: any, tenantId: string, entryDate: string): Promise<boolean> {
  const closed = await db.prepare(
    'SELECT id FROM closed_periods WHERE user_id = ? AND ? >= period_start AND ? <= period_end LIMIT 1'
  ).bind(tenantId, entryDate, entryDate).first();
  return !closed;
}
