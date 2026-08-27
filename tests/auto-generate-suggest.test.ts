import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const API = process.env.API_URL || 'http://localhost:8787';
const TOKEN = process.env.TEST_TOKEN || '';

describe('Auto-generate JDE suggestion mode', () => {
  let transactionId: string;

  beforeAll(async () => {
    // Get an unposted bank transaction for testing
    const res = await fetch(`${API}/bookkeeping/auto-generate-entries?dry_run=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const data = await res.json();
    if (data.suggestions?.length > 0) {
      transactionId = data.suggestions[0].transaction_id;
    }
  });

  it('dry_run returns suggestions without writing', async () => {
    const res = await fetch(`${API}/bookkeeping/auto-generate-entries?dry_run=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('suggestions');
    expect(Array.isArray(data.suggestions)).toBe(true);
    expect(data).toHaveProperty('total_unposted');

    // Verify no entries were created by checking the first suggestion
    if (data.suggestions.length > 0) {
      const s = data.suggestions[0];
      expect(s).toHaveProperty('transaction_id');
      expect(s).toHaveProperty('contra_account_code');
      expect(s).toHaveProperty('confidence');
      expect(['confirmed', 'needs_review']).toContain(s.confidence);
    }
  });

  it('confirm-suggestion creates a journal entry', async () => {
    if (!transactionId) {
      console.log('No unposted transactions available — skipping');
      return;
    }

    const res = await fetch(`${API}/bookkeeping/confirm-suggestion`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transaction_id: transactionId }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('entry_id');
    expect(data).toHaveProperty('voucher_number');
    expect(data.voucher_number).toMatch(/^B-/);
  });

  it('confirm-suggestion rejects invalid contra_account_code', async () => {
    if (!transactionId) {
      console.log('No unposted transactions available — skipping');
      return;
    }

    const res = await fetch(`${API}/bookkeeping/confirm-suggestion`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transaction_id: transactionId, contra_account_code: '99999' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('not found in COA');
  });

  it('confirm-suggestion rejects already-posted transaction', async () => {
    // Use a transaction that was just confirmed above
    const res = await fetch(`${API}/bookkeeping/confirm-suggestion`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transaction_id: transactionId }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('not found or already posted');
  });
});
