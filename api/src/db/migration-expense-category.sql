-- Add expense_category to invoices for Cash / Employee Reimburse / Director expense tracking
ALTER TABLE invoices ADD COLUMN expense_category TEXT;
CREATE INDEX IF NOT EXISTS idx_invoices_expense_cat ON invoices(user_id, expense_category);
