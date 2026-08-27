# Task 5: Frontend — Update FileUpload auto-trigger

**Files:**
- Modify: `frontend/src/pages/FileUpload.tsx`

**Interfaces:**
- Consumes: `AutoGenerateSuggestionPanel` component
- Produces: Auto-trigger shows suggestion panel instead of direct POST

## Steps

- [ ] **Step 1: Add state for showing suggestion panel**

After the existing state declarations, add:

```typescript
const [showAutoGenPanel, setShowAutoGenPanel] = useState(false);
```

- [ ] **Step 2: Import the new component**

Add to imports at top of file:

```typescript
import AutoGenerateSuggestionPanel from '../components/AutoGenerateSuggestionPanel';
```

- [ ] **Step 3: Replace the auto-trigger POST**

Change the auto-trigger (lines 571-573) from:

```typescript
if (batchRef.current.bank > 0 || batchRef.current.card > 0) {
  try { await api('/bookkeeping/auto-generate-entries', { method: 'POST' }); } catch {}
}
```

to:

```typescript
if (batchRef.current.bank > 0 || batchRef.current.card > 0) {
  setShowAutoGenPanel(true);
}
```

- [ ] **Step 4: Add the suggestion panel render**

In a suitable location (e.g., after the upload success message), add:

```typescript
{showAutoGenPanel && (
  <AutoGenerateSuggestionPanel onDone={() => setShowAutoGenPanel(false)} />
)}
```

- [ ] **Step 5: Verify build**

Run: `cd frontend && npm run build 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/FileUpload.tsx
git commit -m "feat(frontend): update FileUpload auto-trigger to show suggestion panel

Co-Authored-By: Claude <noreply@anthropic.com>"
```
