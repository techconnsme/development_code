import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware } from '../middleware/auth';
import { Bindings, Variables } from '../types';
import { runLLMMatching } from '../lib/llm-matcher';

const match = new Hono<{ Bindings: Bindings; Variables: Variables }>();
match.use('*', authMiddleware);

// Track active sessions for cancellation
const activeSessions = new Map<string, AbortController>();

// POST /api/match/llm-analyze — SSE streaming endpoint
match.post('/llm-analyze', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));

  const sessionId = uuidv4();
  const controller = new AbortController();
  activeSessions.set(sessionId, controller);

  const { type = 'bank-invoice', direction } = body;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(readableController) {
      const send = (event: string, data: any) => {
        readableController.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        send('progress', { phase: 'rules', current: 0, total: 0, message: 'Starting analysis...', sessionId });

        const suggestions = await runLLMMatching({
          userId: tenantId,
          db,
          env: c.env,
          type,
          direction,
          signal: controller.signal,
          onProgress: (event) => send('progress', { ...event, sessionId }),
          onTokens: (usage) => send('tokens', usage),
        });

        send('suggestions', suggestions);
        send('done', { total: suggestions.length, sessionId });
      } catch (err: any) {
        if (err.message === 'Cancelled' || controller.signal.aborted) {
          send('cancelled', { sessionId });
        } else {
          send('error', { message: err.message || 'Matching failed', sessionId });
        }
      } finally {
        activeSessions.delete(sessionId);
        readableController.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

// POST /api/match/cancel/:sessionId — cancel active matching
match.post('/cancel/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const controller = activeSessions.get(sessionId);

  if (controller) {
    controller.abort();
    activeSessions.delete(sessionId);
    return c.json({ success: true, message: 'Matching cancelled' });
  }

  return c.json({ success: false, message: 'Session not found' }, 404);
});

export default match;
