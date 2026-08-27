# Task 7 Design: api() error payload + DocumentPickerModal

**Date:** 2026-08-27

## Part 1: api.ts error payload

### Problem
The `api()` helper throws `new Error(err.error || 'Request failed')`, discarding the full parsed error body. Callers (like the GJE modal's duplicate-entry 409 handler) need access to `error_code` and `similar_entries`.

### Change
In `frontend/src/lib/api.ts`, after parsing `err` from `res.json()`, throw a custom error that carries the parsed body:

```ts
class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}
```

Throw `new ApiError(err.error || 'Request failed', res.status, err)` instead of `new Error(...)`.

Callers can now do:
```ts
catch (e) {
  if (e instanceof ApiError && e.body.error_code === 'similar_entry_exists') { ... }
}
```

Also export `ApiError` for consumers.

### Files changed
- `frontend/src/lib/api.ts`

---

## Part 2: DocumentPickerModal

### Interface
```ts
interface DocumentPickerModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (files: FileRecord[]) => void;
  initialSelection?: FileRecord[];
}
```

### FileRecord (for this component's context)
```ts
interface FileRecord {
  id: string;
  filename: string;
  original_name: string;
  file_type: string;
  folder: string;
  description?: string;
  created_at: string;
}
```

### Behavior
1. On open, fetch `GET /file-storage` (uses `api()` helper)
2. Search input filters by filename/description (client-side)
3. Type filter dropdown: All, Invoices, Receipts, Bank Statements, Card Statements, Others
4. Multi-select checkboxes; max 10 selected — checkbox disabled when at cap
5. Preview pane: clicking a row shows an iframe preview
6. Confirm button passes selected files to `onConfirm`; Cancel closes
7. Selected count shown; "Max 10" note when at cap

### UI Pattern
Follows existing modal conventions:
- Fixed overlay `fixed inset-0 z-50 flex items-center justify-center bg-black/50`
- Card `bg-card border rounded-xl p-5 w-full max-w-3xl`
- Header with title + X button
- Scrollable body with file list
- Footer with Cancel + Confirm buttons

### Files created
- `frontend/src/components/DocumentPickerModal.tsx`
