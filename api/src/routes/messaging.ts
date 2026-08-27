import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { v4 as uuidv4 } from 'uuid';
import { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import { wsBroadcast } from './ws';
import { llmCompleteJson, llmKeysFromEnv, hasLlmKey } from '../lib/llm-parse';

const messaging = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ═══════════════════════════════════
// Channel Management
// ═══════════════════════════════════

messaging.get('/channels', authMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const rows = await c.env.DB.prepare(
    'SELECT id, channel_type, name, phone_number, is_active, wuzapi_url, wuzapi_key, created_at FROM channels WHERE user_id = ? ORDER BY channel_type, name'
  ).bind(tenantId).all();
  return c.json({ data: rows.results });
});

messaging.get('/channels/:id', authMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const row = await c.env.DB.prepare('SELECT * FROM channels WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), tenantId).first();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

const channelSchema = z.object({
  channel_type: z.enum(['telegram', 'whatsapp']),
  name: z.string().min(1),
  bot_token: z.string().optional(),
  phone_number: z.string().optional(),
  api_key: z.string().optional(),
  wuzapi_url: z.string().optional(),
  wuzapi_key: z.string().optional(),
});

messaging.post('/channels', authMiddleware, zValidator('json', channelSchema), async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const data = c.req.valid('json');
  const id = `ch-${uuidv4().slice(0, 8)}`;

  await db.prepare(
    'INSERT INTO channels (id, user_id, channel_type, name, bot_token, phone_number, api_key, wuzapi_url, wuzapi_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, user.id, data.channel_type, data.name, data.bot_token || null, data.phone_number || null, data.api_key || null, data.wuzapi_url || null, data.wuzapi_key || null).run();

  const row = await db.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

messaging.put('/channels/:id', authMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await c.req.json();

  const existing = await db.prepare('SELECT id FROM channels WHERE id = ? AND user_id = ?').bind(id, tenantId).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const sets: string[] = []; const params: any[] = [];
  for (const k of ['name','bot_token','phone_number','api_key','wuzapi_url','wuzapi_key']) {
    if (body[k] !== undefined) { sets.push(`${k} = ?`); params.push(body[k]); }
  }
  if (sets.length === 0) return c.json({ error: 'No fields' }, 400);
  sets.push("updated_at = datetime('now')");
  params.push(id, tenantId);
  await db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...params).run();

  const row = await db.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first();
  return c.json(row);
});

messaging.delete('/channels/:id', authMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  await c.env.DB.prepare('UPDATE channels SET is_active = 0 WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), tenantId).run();
  return c.json({ success: true });
});

// ═══════════════════════════════════
// Telegram Bot Setup — register webhook
// ═══════════════════════════════════

messaging.post('/telegram/setup', authMiddleware, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const { bot_token } = body;
  if (!bot_token) return c.json({ error: 'bot_token required' }, 400);

  // Save channel
  const chId = `ch-${uuidv4().slice(0, 8)}`;
  await c.env.DB.prepare(
    "INSERT INTO channels (id, user_id, channel_type, name, bot_token) VALUES (?, ?, 'telegram', 'Telegram Bot', ?)"
  ).bind(chId, user.id, bot_token).run();

  // Register webhook with Telegram
  const webhookUrl = `https://${new URL(c.req.url).hostname}/api/messaging/telegram/webhook/${chId}`;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${bot_token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message'] }),
    });
    const data = await resp.json() as any;
    return c.json({ channel_id: chId, webhook_url: webhookUrl, telegram_response: data });
  } catch (e: any) {
    return c.json({ error: 'Failed to register webhook: ' + e.message }, 500);
  }
});

// ═══════════════════════════════════
// Telegram Bot Webhook
// ═══════════════════════════════════

messaging.post('/telegram/webhook/:channelId', async (c) => {
  const channelId = c.req.param('channelId');
  const db = c.env.DB;

  const channel = await db.prepare('SELECT * FROM channels WHERE id = ?').bind(channelId).first<{ user_id: string; bot_token: string }>();
  if (!channel) return c.json({ error: 'Channel not found' }, 404);

  const body = await c.req.json();

  // Log webhook event
  const eventId = `we-${uuidv4().slice(0, 8)}`;
  await db.prepare(
    'INSERT INTO webhook_events (id, user_id, channel_type, event_type, external_id, from_contact, payload) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(eventId, channel.user_id, 'telegram', body.message ? 'message' : 'callback',
    body.update_id?.toString() || '', body.message?.from?.id?.toString() || '', JSON.stringify(body)).run();

  // Handle message
  if (body.message && body.message.text) {
    const msg = body.message;
    const fromId = msg.from.id.toString();
    const chatId = msg.chat.id.toString();

    // Find or create conversation
    let conv = await db.prepare(
      "SELECT id FROM conversations WHERE user_id = ? AND channel_type = 'telegram' AND external_id = ?"
    ).bind(channel.user_id, chatId).first<{ id: string }>();

    if (!conv) {
      const convId = `cv-${uuidv4().slice(0, 8)}`;
      await db.prepare(
        "INSERT INTO conversations (id, user_id, channel_id, channel_type, external_id, contact_name, contact_username, subject) VALUES (?, ?, ?, 'telegram', ?, ?, ?, ?)"
      ).bind(convId, channel.user_id, channelId, chatId,
        `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim(),
        msg.from.username || null, msg.text.substring(0, 80)).run();
      conv = { id: convId };
    }

    // Save message
    const msgId = `msg-${uuidv4().slice(0, 8)}`;
    await db.prepare(
      "INSERT INTO messages (id, user_id, conversation_id, channel_type, direction, message_type, external_message_id, content, status) VALUES (?, ?, ?, 'telegram', 'inbound', 'text', ?, ?, 'delivered')"
    ).bind(msgId, channel.user_id, conv.id, msg.message_id.toString(), msg.text).run();

    // Update conversation
    await db.prepare(
      "UPDATE conversations SET last_message_at = datetime('now'), last_message_preview = ?, unread_count = unread_count + 1, updated_at = datetime('now') WHERE id = ?"
    ).bind(msg.text.substring(0, 200), conv.id).run();

    // Auto-reply if bot token available
    if (channel.bot_token && msg.text.toLowerCase().includes('invoice')) {
      const replyText = '👋 Hello! I can help you with invoices. Reply with an invoice number to get details.';
      await sendTelegramMessage(channel.bot_token, chatId, replyText, c.env);

      // Save auto-reply
      const outId = `msg-${uuidv4().slice(0, 8)}`;
      await db.prepare(
        "INSERT INTO messages (id, user_id, conversation_id, channel_type, direction, message_type, content, status) VALUES (?, ?, ?, 'telegram', 'outbound', 'text', ?, 'sent')"
      ).bind(outId, channel.user_id, conv.id, replyText).run();
    }

    // Mark processed
    await db.prepare('UPDATE webhook_events SET processed = 1, processed_at = datetime(\'now\') WHERE id = ?').bind(eventId).run();
  }

  // Handle photo — Telegram bill import
  if (body.message && (body.message.photo || body.message.document)) {
    c.executionCtx.waitUntil(processTelegramMedia(channel, body.message, db, c.env));
    // Mark processed immediately
    await db.prepare('UPDATE webhook_events SET processed = 1, processed_at = datetime(\'now\') WHERE id = ?').bind(eventId).run();
  }

  return c.json({ ok: true });
});

// ═══════════════════════════════════
// WhatsApp Webhook (wuzapi-cli style)
// ═══════════════════════════════════

messaging.post('/whatsapp/webhook/:channelId', async (c) => {
  const channelId = c.req.param('channelId');
  const db = c.env.DB;

  const channel = await db.prepare('SELECT * FROM channels WHERE id = ?').bind(channelId).first<{ user_id: string; api_key: string; phone_number: string }>();
  if (!channel) return c.json({ error: 'Channel not found' }, 404);

  const body = await c.req.json();

  // Log webhook
  const eventId = `we-${uuidv4().slice(0, 8)}`;
  await db.prepare(
    'INSERT INTO webhook_events (id, user_id, channel_type, event_type, external_id, from_contact, payload) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(eventId, channel.user_id, 'whatsapp', body.type || 'message', body.id || '',
    body.from || body.contact || '', JSON.stringify(body)).run();

  // Handle incoming WhatsApp message
  if (body.type === 'message' || body.text) {
    const from = body.from || body.contact || '';
    const text = body.text?.body || body.text || body.body || '';

    let conv = await db.prepare(
      "SELECT id FROM conversations WHERE user_id = ? AND channel_type = 'whatsapp' AND external_id = ?"
    ).bind(channel.user_id, from).first<{ id: string }>();

    if (!conv) {
      const convId = `cv-${uuidv4().slice(0, 8)}`;
      await db.prepare(
        "INSERT INTO conversations (id, user_id, channel_id, channel_type, external_id, contact_phone, contact_name, subject) VALUES (?, ?, ?, 'whatsapp', ?, ?, ?, ?)"
      ).bind(convId, channel.user_id, channelId, from, from, body.contact_name || from, text.substring(0, 80)).run();
      conv = { id: convId };
    }

    const msgId = `msg-${uuidv4().slice(0, 8)}`;
    await db.prepare(
      "INSERT INTO messages (id, user_id, conversation_id, channel_type, direction, message_type, external_message_id, content, status, media_url, media_type) VALUES (?, ?, ?, 'whatsapp', 'inbound', ?, ?, ?, 'delivered', ?, ?)"
    ).bind(msgId, channel.user_id, conv.id,
      body.type || 'text', body.id || '', text,
      body.media?.url || null, body.media?.type || null).run();

    await db.prepare(
      "UPDATE conversations SET last_message_at = datetime('now'), last_message_preview = ?, unread_count = unread_count + 1, updated_at = datetime('now') WHERE id = ?"
    ).bind(text.substring(0, 200), conv.id).run();

    await db.prepare('UPDATE webhook_events SET processed = 1, processed_at = datetime(\'now\') WHERE id = ?').bind(eventId).run();

    // Push real-time via WebSocket to all connected clients
    wsBroadcast(channel.user_id, {
      type: 'new_whatsapp_message',
      conversation_id: conv ? conv.id : null,
      from,
      text,
      timestamp: new Date().toISOString(),
    });
  }

  return c.json({ ok: true });
});

// ═══════════════════════════════════
// WhatsApp Session (wuzapi-cli migration)
// ═══════════════════════════════════

messaging.post('/wuzapi/sessions', authMiddleware, zValidator('json', z.object({
  device_name: z.string().min(1),
  phone_number: z.string().optional(),
})), async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const { device_name, phone_number } = c.req.valid('json');
  const id = `ws-${uuidv4().slice(0, 8)}`;

  await db.prepare(
    'INSERT INTO wuzapi_sessions (id, user_id, device_name, phone_number, session_data, pair_status) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, user.id, device_name, phone_number || null, '{}', 'pending').run();

  const row = await db.prepare('SELECT * FROM wuzapi_sessions WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

messaging.get('/wuzapi/sessions', authMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const rows = await c.env.DB.prepare(
    'SELECT id, device_name, phone_number, jid, pair_status, last_connected_at, created_at FROM wuzapi_sessions WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(tenantId).all();
  return c.json({ data: rows.results });
});

messaging.patch('/wuzapi/sessions/:id', authMiddleware, zValidator('json', z.object({
  session_data: z.string().optional(),
  pair_status: z.string().optional(),
  jid: z.string().optional(),
})), async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const sets: string[] = []; const params: any[] = [];
  if (data.session_data) { sets.push('session_data = ?'); params.push(data.session_data); }
  if (data.pair_status) { sets.push('pair_status = ?'); params.push(data.pair_status); }
  if (data.jid) { sets.push('jid = ?'); params.push(data.jid); }
  sets.push("updated_at = datetime('now')");
  if (data.pair_status === 'paired') sets.push("last_connected_at = datetime('now')");
  params.push(id, tenantId);

  await db.prepare(`UPDATE wuzapi_sessions SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...params).run();
  const row = await db.prepare('SELECT * FROM wuzapi_sessions WHERE id = ?').bind(id).first();
  return c.json(row);
});

// ═══════════════════════════════════
// Conversations
// ═══════════════════════════════════

messaging.get('/conversations', authMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const channelType = c.req.query('channel') || '';
  const status = c.req.query('status') || '';

  let query = 'SELECT * FROM conversations WHERE user_id = ?';
  const params: any[] = [tenantId];
  if (channelType) { query += ' AND channel_type = ?'; params.push(channelType); }
  if (status) { query += ' AND status = ?'; params.push(status); }
  query += ' ORDER BY last_message_at DESC NULLS LAST';

  const rows = await c.env.DB.prepare(query).bind(...params).all();
  return c.json({ data: rows.results });
});

messaging.get('/conversations/:id', authMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;

  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), tenantId).first();
  if (!conv) return c.json({ error: 'Not found' }, 404);

  const messages = await db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 200'
  ).bind(c.req.param('id')).all();

  // Mark as read
  await db.prepare("UPDATE conversations SET unread_count = 0, updated_at = datetime('now') WHERE id = ?")
    .bind(c.req.param('id')).run();

  return c.json({ ...conv, messages: messages.results });
});

// ═══════════════════════════════════
// Send Message
// ═══════════════════════════════════

messaging.post('/send', authMiddleware, zValidator('json', z.object({
  conversation_id: z.string().min(1),
  content: z.string().min(1),
  message_type: z.string().optional(),
})), async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const { conversation_id, content, message_type } = c.req.valid('json');

  const conv = await db.prepare(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?'
  ).bind(conversation_id, tenantId).first<{ channel_type: string; external_id: string; channel_id: string }>();
  if (!conv) return c.json({ error: 'Conversation not found' }, 404);

  // Get channel
  const channel = await db.prepare('SELECT * FROM channels WHERE id = ?').bind(conv.channel_id).first<{ bot_token: string; api_key: string }>();
  let sendResult = 'sent';

  // Send via appropriate channel
  if (conv.channel_type === 'telegram' && channel?.bot_token) {
    try {
      await sendTelegramMessage(channel.bot_token, conv.external_id, content, c.env);
    } catch (e) { sendResult = 'failed'; }
  } else if (conv.channel_type === 'whatsapp') {
    // WhatsApp send would go through WhatsApp API
    sendResult = 'sent';
  }

  // Save outbound message
  const msgId = `msg-${uuidv4().slice(0, 8)}`;
  await db.prepare(
    'INSERT INTO messages (id, user_id, conversation_id, channel_type, direction, message_type, content, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(msgId, user.id, conversation_id, conv.channel_type, 'outbound', message_type || 'text', content, sendResult).run();

  await db.prepare("UPDATE conversations SET last_message_at = datetime('now'), last_message_preview = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(content.substring(0, 200), conversation_id).run();

  const msg = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(msgId).first();
  return c.json(msg, 201);
});

// ═══════════════════════════════════
// Message Templates
// ═══════════════════════════════════

messaging.get('/templates', authMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const rows = await c.env.DB.prepare(
    'SELECT * FROM message_templates WHERE user_id = ? AND is_active = 1 ORDER BY category, name'
  ).bind(tenantId).all();
  return c.json({ data: rows.results });
});

messaging.post('/templates', authMiddleware, zValidator('json', z.object({
  name: z.string().min(1),
  channel_type: z.string().optional(),
  content: z.string().min(1),
  shortcut: z.string().optional(),
  category: z.string().optional(),
})), async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const data = c.req.valid('json');
  const id = `mt-${uuidv4().slice(0, 8)}`;

  await db.prepare(
    'INSERT INTO message_templates (id, user_id, name, channel_type, content, shortcut, category) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, user.id, data.name, data.channel_type || 'all', data.content,
    data.shortcut || null, data.category || null).run();

  const row = await db.prepare('SELECT * FROM message_templates WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

// ═══════════════════════════════════
// Telegram send helper (uses Cloudflare fetch)
// ═══════════════════════════════════

async function sendTelegramMessage(botToken: string, chatId: string, text: string, env: any) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Telegram API error: ${err}`);
  }
  return response.json();
}

// ═══════════════════════════════════
// Telegram photo/document bill import
// ═══════════════════════════════════

async function processTelegramMedia(
  channel: { user_id: string; bot_token: string },
  msg: any,
  db: D1Database,
  env: any
) {
  const userId = channel.user_id;
  const botToken = channel.bot_token;
  if (!botToken) return;

  try {
    // Get file_id from photo (largest) or document
    let fileId: string | null = null;
    let mimeType = 'image/jpeg';
    let caption = msg.caption || '';

    if (msg.photo && msg.photo.length > 0) {
      // Pick largest photo (last in array)
      const largest = msg.photo[msg.photo.length - 1];
      fileId = largest.file_id;
    } else if (msg.document) {
      fileId = msg.document.file_id;
      mimeType = msg.document.mime_type || 'application/pdf';
      caption = msg.caption || msg.document.file_name || '';
    }
    if (!fileId) return;

    // 1. Get file path from Telegram
    const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
    const fileResp = await fetch(getFileUrl);
    if (!fileResp.ok) return;
    const fileData = await fileResp.json() as any;
    const filePath = fileData?.result?.file_path;
    if (!filePath) return;

    // 2. Download file from Telegram
    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    const downloadResp = await fetch(downloadUrl);
    if (!downloadResp.ok) return;
    const fileBuffer = await downloadResp.arrayBuffer();

    // 3. Save to R2
    const fileId2 = `tg-${uuidv4().slice(0, 8)}`;
    const safeName = filePath.split('/').pop() || `telegram-${Date.now()}`;
    const r2Key = `${userId}/telegram/${fileId2}-${safeName}`;
    await env.FILE_BUCKET.put(r2Key, fileBuffer, {
      httpMetadata: { contentType: mimeType },
    });

    // 4. Convert to base64 for OCR
    const bytes = new Uint8Array(fileBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);

    // 5. Run GLM-OCR
    let ocrText = '';
    if (env.GLM_API_KEY) {
      try {
        const glmResp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GLM_API_KEY}` },
          body: JSON.stringify({ model: 'glm-ocr', file: `data:${mimeType};base64,${base64}` }),
        });
        if (glmResp.ok) {
          const glmData = await glmResp.json() as any;
          ocrText = typeof glmData === 'string' ? glmData : JSON.stringify(glmData);
        }
      } catch {}
    }

    // 6. Save to file_records
    await db.prepare(
      `INSERT INTO file_records (id, user_id, folder, filename, original_name, file_type, file_size, r2_key, description, ocr_text, ocr_status, category, direction)
       VALUES (?, ?, 'Telegram Bills', ?, ?, ?, ?, ?, ?, ?, ?, 'expense_receipt', 'incoming')`
    ).bind(fileId2, userId, safeName, safeName, mimeType, fileBuffer.byteLength, r2Key, caption, ocrText, ocrText.length > 20 ? 'completed' : 'pending').run();

    // 7. Parse via the Qwen-first LLM chain (was DeepSeek-only)
    let parsed: any = null;
    if (hasLlmKey(llmKeysFromEnv(env)) && ocrText.length > 20) {
      try {
        const billPrompt = `Parse this bill/receipt OCR text into JSON. Extract: supplier_name, bill_date (YYYY-MM-DD), due_date, total_amount (number), currency (default HKD), items (array of {description, amount}), bill_number, category (one of: rent, utilities, telecom, office, travel, meals, software, professional, insurance, tax, other). Return ONLY valid JSON, no explanation.\n\n${ocrText.slice(0, 6000)}`;
        parsed = (await llmCompleteJson(llmKeysFromEnv(env), billPrompt, 'telegram:bill', { maxTokens: 2000 })).parsed;
      } catch {}
    }

    // 8. Create expense receipt
    if (parsed?.total_amount || parsed?.supplier_name) {
      const erId = `ex-${uuidv4().slice(0, 8)}`;
      const vendorName = parsed.supplier_name || caption || 'Unknown';
      const billDate = parsed.bill_date || new Date().toISOString().split('T')[0];
      const total = parsed.total_amount || 0;
      const category = parsed.category || 'other';

      await db.prepare(
        `INSERT INTO expense_receipts (id, user_id, file_name, file_type, file_data, vendor_name, amount, expense_date, category, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(erId, userId, safeName, mimeType, `data:${mimeType};base64,${base64}`, vendorName, total, billDate, category, parsed.bill_number || caption || null).run();

      // 9. Reply to user
      const items = (parsed.items || []).slice(0, 5).map((it: any) => `• ${it.description}: $${it.amount}`).join('\n');
      const reply = `✅ <b>帳單已導入</b>\n\n供應商：${vendorName}\n日期：${billDate}\n金額：HKD ${total.toLocaleString()}\n類別：${category}\n${items ? '\n項目：\n' + items : ''}`;
      await sendTelegramMessage(botToken, msg.chat.id.toString(), reply, env);

      // Save reply to messages
      const outId = `msg-${uuidv4().slice(0, 8)}`;
      const chatId = msg.chat.id.toString();
      let conv = await db.prepare(
        "SELECT id FROM conversations WHERE user_id = ? AND channel_type = 'telegram' AND external_id = ?"
      ).bind(userId, chatId).first<{ id: string }>();
      if (conv) {
        await db.prepare(
          "INSERT INTO messages (id, user_id, conversation_id, channel_type, direction, message_type, content, status) VALUES (?, ?, ?, 'telegram', 'outbound', 'text', ?, 'sent')"
        ).bind(outId, userId, conv.id, reply).run();
      }
    } else {
      // File saved but couldn't parse — notify user
      const reply = `📎 已收到檔案「${safeName}」，正在處理中。請稍候或手動分類。`;
      await sendTelegramMessage(botToken, msg.chat.id.toString(), reply, env);
    }
  } catch (e: any) {
    console.error('Telegram media processing error:', e.message);
  }
}

export { messaging as messagingRoutes };
