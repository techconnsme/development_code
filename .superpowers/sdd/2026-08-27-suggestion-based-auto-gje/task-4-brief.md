# Task 4: Frontend — Replace auto-generate mutation with suggestion panel

**Files:**
- Modify: `frontend/src/pages/Bookkeeping.tsx`

**Interfaces:**
- Consumes: `AutoGenerateSuggestionPanel` component
- Produces: Button that shows suggestion panel instead of direct mutation

## Steps

- [ ] **Step 1: Add state for showing suggestion panel**

After the existing state declarations (around line 100), add:

```typescript
const [showAutoGenPanel, setShowAutoGenPanel] = useState(false);
```

- [ ] **Step 2: Import the new component**

Add to imports at top of file:

```typescript
import AutoGenerateSuggestionPanel from '../components/AutoGenerateSuggestionPanel';
```

- [ ] **Step 3: Replace the auto-generate button onClick**

Change the button (lines 430-436) from:

```typescript
onClick={() => autoGenerateMut.mutate()}
```

to:

```typescript
onClick={() => setShowAutoGenPanel(true)}
```

Also remove `disabled={autoGenerateMut.isPending}` and the spinning icon logic since we're no longer using the mutation directly.

- [ ] **Step 4: Add the suggestion panel render**

After the button (or in a suitable location), add:

```typescript
{showAutoGenPanel && (
  <AutoGenerateSuggestionPanel onDone={() => setShowAutoGenPanel(false)} />
)}
```

- [ ] **Step 5: Remove the old autoGenerateMut mutation**

Remove the `autoGenerateMut` mutation definition (lines 218-235) since it's no longer used.

- [ ] **Step 6: Verify build**

Run: `cd frontend && npm run build 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/Bookkeeping.tsx
git commit -m "feat(frontend): replace auto-generate mutation with suggestion panel

Co-Authored-By: Claude <noreply@anthropic.com>"
```
