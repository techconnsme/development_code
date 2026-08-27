# Task 7: Playwright spec for suggestion panel UI

**Files:**
- Create: `tests/auto-generate-suggestion.spec.ts`

**Interfaces:**
- Consumes: Suggestion panel UI in Bookkeeping page
- Produces: Non-mutating Playwright spec

## Steps

- [ ] **Step 1: Create the Playwright spec**

Create `tests/auto-generate-suggestion.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test.describe('Auto-generate JDE suggestion panel', () => {
  test('clicking Auto-Generate shows suggestion panel', async ({ page }) => {
    await page.goto('/GJE');
    await page.waitForLoadState('networkidle');

    // Click the Auto-Generate button
    const btn = page.getByRole('button', { name: /auto-generate/i });
    await expect(btn).toBeVisible();
    await btn.click();

    // Should show loading state or suggestion panel
    const panel = page.getByTestId('auto-generate-suggestions');
    const loading = page.getByText(/analyzing transactions/i);

    // Either loading or panel should be visible
    await expect(panel.or(loading)).toBeVisible({ timeout: 10000 });

    // If loading, wait for panel
    if (await loading.isVisible()) {
      await expect(panel).toBeVisible({ timeout: 15000 });
    }

    // Panel should have suggestion rows or "all done" message
    const rows = page.getByTestId('suggestion-row');
    const doneMsg = page.getByText(/all done/i);
    await expect(rows.first().or(doneMsg)).toBeVisible();
  });

  test('suggestion rows show confidence badges', async ({ page }) => {
    await page.goto('/GJE');
    await page.waitForLoadState('networkidle');

    const btn = page.getByRole('button', { name: /auto-generate/i });
    await btn.click();

    const panel = page.getByTestId('auto-generate-suggestions');
    await expect(panel).toBeVisible({ timeout: 15000 });

    const rows = page.getByTestId('suggestion-row');
    const count = await rows.count();
    if (count > 0) {
      // Each row should have a confidence badge
      const firstRow = rows.first();
      await expect(firstRow.getByText(/confirmed|needs review/i)).toBeVisible();
    }
  });

  test('Confirm All button appears when confirmed items exist', async ({ page }) => {
    await page.goto('/GJE');
    await page.waitForLoadState('networkidle');

    const btn = page.getByRole('button', { name: /auto-generate/i });
    await btn.click();

    const panel = page.getByTestId('auto-generate-suggestions');
    await expect(panel).toBeVisible({ timeout: 15000 });

    const rows = page.getByTestId('suggestion-row');
    const count = await rows.count();
    if (count > 0) {
      // Check if any row has CONFIRMED badge
      const confirmedBadges = page.getByText('CONFIRMED');
      const confirmedCount = await confirmedBadges.count();
      if (confirmedCount > 0) {
        await expect(page.getByTestId('confirm-all-btn')).toBeVisible();
      }
    }
  });
});
```

- [ ] **Step 2: Verify the spec is syntactically correct**

Run: `cd tests && npx tsc --noEmit auto-generate-suggestion.spec.ts 2>&1`
Expected: No errors

- [ ] **Step 3: Commit (force-add)**

```bash
git add -f tests/auto-generate-suggestion.spec.ts
git commit -m "test: add Playwright spec for auto-generate JDE suggestion panel

Co-Authored-By: Claude <noreply@anthropic.com>"
```
