// R2 backup worker — the "safe box".
//
// Copies every created/overwritten object from the production file bucket
// (opcc-crm-files) into the backup bucket (opcc-crm-files-backup) under a
// versioned key: <eventTime ISO>/<original key>.
//
// Deletes are NOT subscribed (notification is object-create only), so backup
// copies are never removed by normal app operation. Restore = copy a
// versioned key back to its original key.

export default {
  async queue(batch: any, env: any): Promise<void> {
    // Delivery shape: { metadata, queue, messages: [{ attempts, body: <R2 event> }] }
    // Normalize: batch array | single message | wrapper object
    const messages = Array.isArray(batch)
      ? batch
      : Array.isArray(batch?.messages)
        ? batch.messages
        : [batch];
    for (const msg of messages) {
      const payload = msg?.body && msg.body.object ? msg.body : msg;
      try {
        await copyObject(payload, env);
      } catch (e: any) {
        console.error(
          `[backup] failed for ${payload?.object?.key}:`,
          e?.message || e,
        );
        // Per-message retry — the queue redelivers this message
        if (typeof msg.retry === 'function') msg.retry();
      }
    }
  },

  // Ops endpoint — list backup keys (guarded; used by the restore runbook)
  async fetch(request: any, env: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/list' && url.searchParams.get('key') === env.DEBUG_KEY) {
      const prefix = url.searchParams.get('prefix') || '';
      const listed = await env.BACKUP.list(prefix ? { prefix } : undefined);
      return Response.json(listed.objects.map((o: any) => o.key));
    }
    return new Response('not found', { status: 404 });
  },
};

async function copyObject(body: any, env: any): Promise<void> {
  const object = body?.object;
  if (!object?.key) return;

  // Versioned key — writes never overwrite a previous backup
  const stamp = String(body.eventTime || new Date().toISOString()).replace(/[:.]/g, '-');
  const backupKey = `${stamp}/${object.key}`;

  const existing = await env.BACKUP.head(backupKey);
  if (existing) return; // already copied (idempotent)

  const src = await env.SOURCE.get(object.key);
  if (!src) return; // source deleted before we got here — nothing to copy

  await env.BACKUP.put(backupKey, src.body, {
    httpMetadata: src.httpMetadata || undefined,
  });
  console.log(`[backup] copied ${object.key} → ${backupKey}`);
}
