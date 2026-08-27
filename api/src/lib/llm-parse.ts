/**
 * LLM Parse Helper — Qwen-first provider chain for OCR/document parsing.
 *
 * Replaces the DeepSeek-only parse calls that silently produced empty results
 * when the DeepSeek account ran out of balance (2026-08-26). Mirrors the
 * chatbot's provider chain in routes/chat.ts:
 *   Qwen (DashScope International) → Qwen Token Plan → DeepSeek (last resort)
 *
 * Unlike the old inline calls, provider errors are logged with status/body
 * and trigger a fall-through to the next provider — nothing is swallowed.
 */

export interface LlmKeys {
  qwenKey?: string;          // QWEN_API_KEY — DashScope International
  qwenTokenPlanKey?: string; // QWEN_TOKEN_PLAN_API_KEY — Token Plan (sk-sp-...)
  deepseekKey?: string;      // DEEPSEEK_API_KEY — last-resort fallback
}

export interface LlmParseResult {
  parsed: any | null;       // parsed JSON object, or null if every provider failed
  provider: string | null;  // which provider produced the accepted JSON
  raw: string;              // raw content from the accepted provider ('' if none)
}

export function llmKeysFromEnv(env: any): LlmKeys {
  return {
    qwenKey: env?.QWEN_API_KEY || undefined,
    qwenTokenPlanKey: env?.QWEN_TOKEN_PLAN_API_KEY || undefined,
    deepseekKey: env?.DEEPSEEK_API_KEY || undefined,
  };
}

export function hasLlmKey(keys: LlmKeys): boolean {
  return Boolean(keys.qwenKey || keys.qwenTokenPlanKey || keys.deepseekKey);
}

const QWEN_MODEL = 'qwen3.7-plus';

interface Provider {
  name: string;
  key: string | undefined;
  url: string;
  buildBody: (prompt: string, maxTokens: number) => any;
}

function buildProviders(keys: LlmKeys, prompt: string, maxTokens: number): Provider[] {
  return [
    {
      name: 'Qwen (DashScope International)',
      key: keys.qwenKey,
      url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
      buildBody: () => ({ model: QWEN_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0.1, enable_thinking: false }),
    },
    {
      name: 'Qwen Token Plan',
      key: keys.qwenTokenPlanKey,
      url: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
      buildBody: () => ({ model: QWEN_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0.1, enable_thinking: false }),
    },
    {
      name: 'DeepSeek',
      key: keys.deepseekKey,
      url: 'https://api.deepseek.com/chat/completions',
      buildBody: () => ({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens }),
    },
  ];
}

/**
 * Send `prompt` through the provider chain and extract the first JSON object
 * from the reply. Providers that error, return non-OK status, or produce
 * unparseable output are logged and skipped. Never throws.
 */
export async function llmCompleteJson(
  keys: LlmKeys,
  prompt: string,
  label: string,
  opts?: { maxTokens?: number },
): Promise<LlmParseResult> {
  const maxTokens = opts?.maxTokens ?? 4000;

  for (const provider of buildProviders(keys, prompt, maxTokens)) {
    if (!provider.key) continue;
    try {
      const resp = await fetch(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.key}` },
        body: JSON.stringify(provider.buildBody(prompt, maxTokens)),
      });
      if (!resp.ok) {
        const errBody = await resp.text();
        console.error(`[LLM-PARSE|${label}] ${provider.name} error ${resp.status}: ${String(errBody).slice(0, 300)}`);
        continue;
      }
      const data = await resp.json() as any;
      const raw: string = data?.choices?.[0]?.message?.content || '';
      if (!raw) {
        console.error(`[LLM-PARSE|${label}] ${provider.name} returned empty content`);
        continue;
      }
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) {
        console.error(`[LLM-PARSE|${label}] ${provider.name} returned no JSON object: ${raw.slice(0, 200)}`);
        continue;
      }
      try {
        const parsed = JSON.parse(m[0]);
        console.log(`[LLM-PARSE|${label}] answered by ${provider.name}`);
        return { parsed, provider: provider.name, raw };
      } catch (parseErr: any) {
        console.error(`[LLM-PARSE|${label}] ${provider.name} JSON parse failed: ${String(parseErr?.message || parseErr)}`);
        continue;
      }
    } catch (e: any) {
      console.error(`[LLM-PARSE|${label}] ${provider.name} exception: ${String(e?.message || e)}`);
      continue;
    }
  }

  console.error(`[LLM-PARSE|${label}] all providers failed — no parse produced`);
  return { parsed: null, provider: null, raw: '' };
}
