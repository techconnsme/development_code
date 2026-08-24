const API_BASE = 'https://opcc-crm-api.ruhan-farhan.workers.dev/api';

// Direct Worker URL for large payloads (bypasses Pages Function body size limits)
export const WORKER_API_BASE = 'https://opcc-crm-api.ruhan-farhan.workers.dev/api';

// Iframe PDF previews can't send the X-Active-Client header, so download URLs
// carry ?client=<firm_client_id> instead; the backend re-resolves it against
// the caller's firm. Returns '' when no active client is selected.
export function iframeClientParam(): string {
  try {
    const c = JSON.parse(localStorage.getItem('activeClient') || '{}');
    return c?.id ? `&client=${encodeURIComponent(c.id)}` : '';
  } catch { return ''; }
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Use direct Worker URL instead of Pages Function proxy (for large uploads) */
  baseUrl?: string;
}

function getHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = localStorage.getItem('token');
  const activeClientJson = localStorage.getItem('activeClient');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extra,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (activeClientJson) {
    try {
      const client = JSON.parse(activeClientJson);
      if (client?.id) headers['X-Active-Client'] = client.id;
    } catch {}
  }
  return headers;
}

export async function api(path: string, options: ApiOptions = {}) {
  const headers = getHeaders(options.headers);
  const base = options.baseUrl || API_BASE;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout prevents infinite hangs

  try {
    const res = await fetch(`${base}${path}`, {
      method: options.method || 'GET',
      headers,
      credentials: 'include',
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    if (res.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Request failed');
    }

    const contentType = res.headers.get('content-type');
    if (contentType?.includes('text/csv')) {
      return res.text();
    }
    return res.json();
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('Request timed out after 60 seconds');
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// Streaming chat: returns body reader + session_id
export async function streamChat(
  body: any,
  onChunk: (text: string) => void,
  onDone: (sessionId?: string, provider?: string, model?: string) => void,
  onError: (err: string) => void,
) {
  try {
    const headers = getHeaders();
    const res = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ ...body, stream: true }),
    });

    if (res.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
      return;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const detail = err?.error_detail || err?.error || res.statusText;
      // Extract the error code + message from backend error_detail like
      // "DeepSeek API error: 402 {"error":{"message":"Insufficient Balance",...}}"
      const codeMatch = detail.match(/\b(\d{3})\b/);
      const jsonMatch = detail.match(/\{.*\}/s);
      let code = codeMatch ? codeMatch[1] : String(res.status);
      let message = detail;
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          message = parsed?.error?.message || parsed?.message || message;
          if (parsed?.error?.code && /^\d+$/.test(String(parsed.error.code))) code = String(parsed.error.code);
        } catch {}
      }
      onError(`Request Failed (${code}): ${message}`);
      return;
    }

    const sessionId = res.headers.get('X-Session-Id');
    const llmProvider = res.headers.get('X-LLM-Provider') || undefined;
    const llmModel = res.headers.get('X-LLM-Model') || undefined;

    // Read stream
    const reader = res.body?.getReader();
    if (!reader) { onDone(sessionId || undefined, llmProvider, llmModel); return; }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      // Flush buffer in chunks
      onChunk(buffer);
      buffer = '';
    }

    onDone(sessionId || undefined, llmProvider, llmModel);
  } catch (e: any) {
    onError(e.message || 'Connection error');
  }
}

