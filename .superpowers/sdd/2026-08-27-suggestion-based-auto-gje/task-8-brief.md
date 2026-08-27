# Task 8: Deploy and live round-trip

**Files:**
- None (deployment + manual verification)

**Interfaces:**
- Consumes: All previous tasks
- Produces: Deployed feature, verified on live system

## Steps

- [ ] **Step 1: Run migration (no-op, no schema changes)**

No migration needed — this feature uses existing tables.

- [ ] **Step 2: Deploy API**

Run: `cd api && npx wrangler deploy`
Record the new version hash.

- [ ] **Step 3: Deploy frontend**

Run: `cd frontend && npx wrangler pages deploy dist --project-name=opcc-crm-testing`
Record the preview URL.

- [ ] **Step 4: Live round-trip test**

1. Navigate to the testing URL
2. Go to Bookkeeping → GJE tab
3. Click "+ Auto-Generate Journal Entries"
4. Verify suggestion panel appears with transaction list
5. Verify confidence badges show (CONFIRMED / NEEDS REVIEW)
6. Edit a contra account code on one suggestion
7. Click ✓ Confirm on one suggestion
8. Verify the entry appears in the GJE list
9. Click "Confirm All Confirmed" if multiple confirmed items exist
10. Verify all confirmed entries are created
11. Click "Reject All" to dismiss remaining suggestions
12. Verify panel closes

- [ ] **Step 5: Commit deployment notes**

```bash
git add docs/superpowers/plans/2026-08-27-suggestion-based-auto-gje.md
git commit -m "docs: mark suggestion-based auto-gje as deployed

Co-Authored-By: Claude <noreply@anthropic.com>"
```
