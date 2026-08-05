-- oppc-crm Database Schema
-- Multi-user CRM with customers, suppliers, invoices, quotations, and bookkeeping

-- Users table (multi-user support)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  company_name TEXT,
  role TEXT NOT NULL DEFAULT 'user', -- 'admin', 'user', 'auditor'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Customers
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  company_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT DEFAULT 'Hong Kong',
  notes TEXT,
  tax_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Suppliers
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  company_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT DEFAULT 'Hong Kong',
  notes TEXT,
  tax_id TEXT,
  payment_terms TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Products / Services
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  unit_price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'HKD',
  unit TEXT DEFAULT 'pcs',
  category TEXT,
  sku TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Invoices
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  invoice_number TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  supplier_id TEXT REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'draft', -- draft, sent, paid, overdue, cancelled
  issue_date TEXT NOT NULL DEFAULT (datetime('now')),
  due_date TEXT NOT NULL,
  subtotal REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'HKD',
  notes TEXT,
  terms TEXT,
  pdf_url TEXT,
  receipt_number TEXT,
  paid_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, invoice_number)
);

-- Invoice Line Items
CREATE TABLE IF NOT EXISTS invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Quotations
CREATE TABLE IF NOT EXISTS quotations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  quotation_number TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'draft', -- draft, sent, accepted, rejected, expired, converted
  issue_date TEXT NOT NULL DEFAULT (datetime('now')),
  valid_until TEXT NOT NULL,
  subtotal REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'HKD',
  notes TEXT,
  terms TEXT,
  pdf_url TEXT,
  converted_invoice_id TEXT REFERENCES invoices(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, quotation_number)
);

-- Quotation Line Items
CREATE TABLE IF NOT EXISTS quotation_items (
  id TEXT PRIMARY KEY,
  quotation_id TEXT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Bookkeeping / Journal Entries
CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  entry_number TEXT NOT NULL,
  entry_date TEXT NOT NULL DEFAULT (datetime('now')),
  description TEXT NOT NULL,
  reference_type TEXT, -- 'invoice', 'bill', 'expense', 'journal'
  reference_id TEXT,
  status TEXT NOT NULL DEFAULT 'posted', -- draft, posted, reconciled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, entry_number)
);

-- Journal Entry Lines (double-entry)
CREATE TABLE IF NOT EXISTS journal_lines (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  description TEXT,
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  project TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Chart of Accounts
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  parent_code TEXT,
  opening_balance REAL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, account_code)
);

-- Closed Periods (prevent modifications to closed accounting periods)
CREATE TABLE IF NOT EXISTS closed_periods (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  closed_by TEXT NOT NULL REFERENCES users(id),
  closed_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT,
  UNIQUE(user_id, period_start, period_end)
);

-- Audit Trail
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  changes TEXT, -- JSON string of changes
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- API Tokens for WorkBuddy integration
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT 'read',
  last_used_at TEXT,
  expires_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_customers_user ON customers(user_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_user ON suppliers(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(user_id, status);
CREATE INDEX IF NOT EXISTS idx_quotations_user ON quotations(user_id);
CREATE INDEX IF NOT EXISTS idx_quotations_customer ON quotations(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(user_id, status);
CREATE INDEX IF NOT EXISTS idx_journal_entries_user ON journal_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(user_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
-- ═══════════════════════════════════════════
-- OpenClaw Messaging System
-- Telegram + WhatsApp + unified messaging
-- ═══════════════════════════════════════════

-- Bot / Channel configurations
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  channel_type TEXT NOT NULL, -- 'telegram', 'whatsapp', 'email'
  name TEXT NOT NULL,
  bot_token TEXT,            -- Telegram bot token (encrypted)
  webhook_url TEXT,
  webhook_secret TEXT,
  phone_number TEXT,          -- WhatsApp phone
  api_key TEXT,              -- WhatsApp API key
  session_data TEXT,          -- JSON: WhatsApp session / pairing data
  is_active INTEGER NOT NULL DEFAULT 1,
  metadata TEXT,              -- JSON: extra config
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Conversations (grouped by channel + contact)
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  channel_id TEXT REFERENCES channels(id),
  customer_id TEXT REFERENCES customers(id),
  channel_type TEXT NOT NULL,
  external_id TEXT,           -- Telegram chat_id / WhatsApp JID
  contact_name TEXT,
  contact_phone TEXT,
  contact_username TEXT,
  subject TEXT,               -- conversation topic
  status TEXT NOT NULL DEFAULT 'active', -- active, resolved, archived
  last_message_at TEXT,
  last_message_preview TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  tags TEXT,                  -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'inbound', -- inbound, outbound
  message_type TEXT NOT NULL DEFAULT 'text', -- text, image, document, audio, location, template
  external_message_id TEXT,   -- platform-specific ID
  content TEXT NOT NULL,
  media_url TEXT,
  media_type TEXT,
  caption TEXT,
  metadata TEXT,              -- JSON: buttons, interactive, etc.
  status TEXT NOT NULL DEFAULT 'pending', -- pending, sent, delivered, read, failed
  read_at TEXT,
  delivered_at TEXT,
  replied_to_id TEXT REFERENCES messages(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- WhatsApp device sessions (wuzapi-cli migration)
CREATE TABLE IF NOT EXISTS wuzapi_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_name TEXT NOT NULL,
  phone_number TEXT,
  jid TEXT,                   -- WhatsApp JID
  session_data TEXT NOT NULL, -- encrypted session blob
  pair_code TEXT,             -- QR pairing code
  pair_status TEXT NOT NULL DEFAULT 'pending', -- pending, paired, expired, disconnected
  last_connected_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Webhook event log (incoming from Telegram/WhatsApp)
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  channel_type TEXT NOT NULL,
  event_type TEXT NOT NULL,   -- message, callback, status, delivery
  external_id TEXT,
  from_contact TEXT,
  payload TEXT NOT NULL,      -- full JSON payload
  processed INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Quick replies / templates
CREATE TABLE IF NOT EXISTS message_templates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  channel_type TEXT NOT NULL DEFAULT 'all',
  content TEXT NOT NULL,
  shortcut TEXT,              -- /shortcut name
  category TEXT,
  variables TEXT,             -- JSON array of variable names
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Message indexes
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_customer ON conversations(customer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(user_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_external ON messages(external_message_id);
CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_created ON webhook_events(created_at);
-- ═══════════════════════════════════════════
-- Calendar Events
-- ═══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  customer_id TEXT REFERENCES customers(id),
  title TEXT NOT NULL,
  description TEXT,
  event_type TEXT NOT NULL DEFAULT 'appointment', -- appointment, meeting, deadline, reminder, invoice_due
  start_time TEXT NOT NULL,
  end_time TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled, completed, cancelled
  color TEXT DEFAULT '#2563eb',
  location TEXT,
  reference_type TEXT,        -- 'invoice', 'quotation', 'service_booking'
  reference_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════
-- Services & Bookings
-- ═══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'general',
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'HKD',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS service_bookings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  service_id TEXT NOT NULL REFERENCES services(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  booking_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed, completed, cancelled, no_show
  notes TEXT,
  price REAL,
  invoice_id TEXT REFERENCES invoices(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_calendar_user ON calendar_events(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_dates ON calendar_events(user_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_calendar_customer ON calendar_events(customer_id);
CREATE INDEX IF NOT EXISTS idx_services_user ON services(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON service_bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON service_bookings(booking_date);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON service_bookings(customer_id);

-- File Storage (R2-backed)
CREATE TABLE IF NOT EXISTS file_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  folder TEXT NOT NULL DEFAULT 'General',
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  file_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_size INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  description TEXT DEFAULT '',
  ocr_text TEXT DEFAULT '',
  ocr_status TEXT DEFAULT 'pending',
  category TEXT DEFAULT '',
  direction TEXT,
  payment_status TEXT DEFAULT 'unmatched',
  amount REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_file_records_user ON file_records(user_id);
CREATE INDEX IF NOT EXISTS idx_file_records_folder ON file_records(user_id, folder);
CREATE INDEX IF NOT EXISTS idx_file_records_name ON file_records(user_id, filename);

-- Purchase Orders
CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  po_number TEXT NOT NULL,
  supplier_id TEXT REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'draft',
  issue_date TEXT NOT NULL DEFAULT (datetime('now')),
  due_date TEXT,
  receipt_number TEXT,
  paid_date TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'HKD',
  notes TEXT,
  terms TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, po_number)
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id TEXT PRIMARY KEY,
  po_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Service Orders
CREATE TABLE IF NOT EXISTS service_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  so_number TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'draft',
  issue_date TEXT NOT NULL DEFAULT (datetime('now')),
  valid_from TEXT,
  valid_until TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'HKD',
  notes TEXT,
  terms TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, so_number)
);

CREATE TABLE IF NOT EXISTS service_order_items (
  id TEXT PRIMARY KEY,
  so_id TEXT NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_user ON purchase_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_service_orders_user ON service_orders(user_id);

-- Bank Statements (enhanced with R2 support)
CREATE TABLE IF NOT EXISTS bank_statements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  file_name TEXT,
  file_type TEXT DEFAULT 'application/pdf',
  file_data TEXT DEFAULT '',
  r2_key TEXT,
  bank_name TEXT,
  account_number TEXT,
  branch TEXT,
  currency TEXT DEFAULT 'HKD',
  account_type TEXT,
  account_code TEXT,
  statement_year INTEGER,
  statement_month INTEGER,
  period_start TEXT,
  period_end TEXT,
  opening_balance REAL,
  closing_balance REAL,
  page_count INTEGER,
  ocr_text TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bank Transactions (individual records within a statement)
CREATE TABLE IF NOT EXISTS bank_transactions (
  id TEXT PRIMARY KEY,
  bank_statement_id TEXT NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  transaction_date TEXT NOT NULL,
  description TEXT NOT NULL,
  deposit_amount REAL DEFAULT 0,
  withdrawal_amount REAL DEFAULT 0,
  balance REAL DEFAULT 0,
  account_type TEXT,
  reference TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  invoice_id TEXT REFERENCES invoices(id),
  match_confidence TEXT,
  match_status TEXT NOT NULL DEFAULT 'unmatched',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bank_statements_user ON bank_statements(user_id);
CREATE INDEX IF NOT EXISTS idx_bank_statements_period ON bank_statements(user_id, statement_year, statement_month);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_stmt ON bank_transactions(bank_statement_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_user ON bank_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_date ON bank_transactions(user_id, transaction_date);

-- Fixed Asset Register
CREATE TABLE IF NOT EXISTS fixed_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  asset_name TEXT NOT NULL,
  asset_code TEXT,
  category TEXT DEFAULT 'office_equipment',
  purchase_date TEXT NOT NULL,
  cost REAL NOT NULL,
  useful_life_years REAL NOT NULL DEFAULT 5,
  salvage_value REAL DEFAULT 0,
  depreciation_method TEXT NOT NULL DEFAULT 'straight_line',
  monthly_depreciation REAL DEFAULT 0,
  accumulated_depreciation REAL DEFAULT 0,
  net_book_value REAL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  disposal_date TEXT,
  disposal_amount REAL,
  account_code TEXT DEFAULT '12201',
  depn_account_code TEXT DEFAULT '66101',
  acc_depn_account_code TEXT DEFAULT '12301',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fixed_assets_user ON fixed_assets(user_id);

-- Bank Reconciliation
CREATE TABLE IF NOT EXISTS bank_reconciliations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  bank_statement_id TEXT NOT NULL REFERENCES bank_statements(id),
  account_code TEXT NOT NULL,
  statement_date TEXT NOT NULL,
  statement_balance REAL NOT NULL,
  gl_balance REAL NOT NULL,
  outstanding_deposits REAL DEFAULT 0,
  outstanding_withdrawals REAL DEFAULT 0,
  reconciled_balance REAL DEFAULT 0,
  difference REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  notes TEXT,
  reconciled_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_user ON bank_reconciliations(user_id);
CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_stmt ON bank_reconciliations(bank_statement_id);

-- Website Generator Versions
CREATE TABLE IF NOT EXISTS website_versions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  version_number INTEGER NOT NULL,
  html TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  company_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_website_versions_user ON website_versions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_website_versions_user_ver ON website_versions(user_id, version_number);

-- Chat Sessions (AI assistant conversation history)
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);

-- ── Accounting Firm Mode ──

-- Firms: top-level accounting firm organization
CREATE TABLE IF NOT EXISTS firms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════
-- SecondAct — Compliance Dashboard
-- ═══════════════════════════════════════════

-- Company settings — extended for compliance
CREATE TABLE IF NOT EXISTS company_settings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT,
  legal_name TEXT,
  short_name TEXT,
  tagline TEXT,
  address TEXT,
  address2 TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  tax_id TEXT,
  logo_url TEXT,
  bank_name TEXT,
  bank_account TEXT,
  bank_swift TEXT,
  bank_address TEXT,
  signatory_name TEXT,
  invoice_number_pattern TEXT,
  features TEXT DEFAULT '{}',
  -- Compliance fields
  br_number TEXT,
  br_expiry_date TEXT,
  ci_number TEXT,
  industry TEXT DEFAULT 'general',
  employee_count INTEGER DEFAULT 0,
  fiscal_year_start TEXT,
  fiscal_year_end TEXT DEFAULT '03-31',
  secretary_name TEXT,
  secretary_contact TEXT,
  auditor_name TEXT,
  auditor_contact TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id)
);

-- Compliance templates — shared across all tenants
CREATE TABLE IF NOT EXISTS compliance_templates (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  industry TEXT DEFAULT 'general',
  title_zh TEXT NOT NULL,
  title_en TEXT,
  description_zh TEXT,
  is_required INTEGER NOT NULL DEFAULT 1,
  has_deadline INTEGER NOT NULL DEFAULT 0,
  deadline_field TEXT,
  action_url TEXT,
  action_label_zh TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-member compliance status
CREATE TABLE IF NOT EXISTS member_compliance (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  template_id TEXT NOT NULL REFERENCES compliance_templates(id),
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  completed_at TEXT,
  reminder_enabled INTEGER NOT NULL DEFAULT 1,
  last_reminded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, template_id)
);

-- Compliance key dates
CREATE TABLE IF NOT EXISTS compliance_dates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  date_type TEXT NOT NULL,
  date_value TEXT NOT NULL,
  reminder_days TEXT DEFAULT '90,60,30,7',
  notes TEXT,
  last_reminded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, date_type)
);

-- Compliance action log
CREATE TABLE IF NOT EXISTS compliance_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  template_id TEXT REFERENCES compliance_templates(id),
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════
-- Plans & Subscriptions
-- ═══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  plan_key TEXT UNIQUE NOT NULL,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL,
  monthly_price INTEGER NOT NULL,
  skill_allowlist TEXT NOT NULL,
  limits TEXT NOT NULL,
  features TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  auto_renew INTEGER NOT NULL DEFAULT 1,
  payment_method TEXT,
  stripe_subscription_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Firm members: staff who work at a firm
CREATE TABLE IF NOT EXISTS firm_members (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'staff',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(firm_id, user_id)
);

-- Firm clients: companies managed by the firm
CREATE TABLE IF NOT EXISTS firm_clients (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  client_user_id TEXT NOT NULL REFERENCES users(id),
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(firm_id, client_user_id)
);

-- Staff-to-client assignments (M:N)
CREATE TABLE IF NOT EXISTS firm_client_assignments (
  id TEXT PRIMARY KEY,
  firm_member_id TEXT NOT NULL REFERENCES firm_members(id) ON DELETE CASCADE,
  firm_client_id TEXT NOT NULL REFERENCES firm_clients(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(firm_member_id, firm_client_id)
);

CREATE INDEX IF NOT EXISTS idx_firm_members_user ON firm_members(user_id);
CREATE INDEX IF NOT EXISTS idx_firm_members_firm ON firm_members(firm_id);
CREATE INDEX IF NOT EXISTS idx_firm_clients_firm ON firm_clients(firm_id);
CREATE INDEX IF NOT EXISTS idx_firm_clients_user ON firm_clients(client_user_id);
CREATE INDEX IF NOT EXISTS idx_firm_assignments_member ON firm_client_assignments(firm_member_id);
CREATE INDEX IF NOT EXISTS idx_firm_assignments_client ON firm_client_assignments(firm_client_id);
-- Indexes
CREATE INDEX IF NOT EXISTS idx_company_settings_user ON company_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_compliance_templates_industry ON compliance_templates(industry);
CREATE INDEX IF NOT EXISTS idx_member_compliance_user ON member_compliance(user_id);
CREATE INDEX IF NOT EXISTS idx_compliance_dates_user ON compliance_dates(user_id);
CREATE INDEX IF NOT EXISTS idx_compliance_log_user ON compliance_log(user_id);
CREATE INDEX IF NOT EXISTS idx_plans_key ON plans(plan_key);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_plan ON subscriptions(plan_id);

-- ═══════════════════════════════════════════
-- SecondAct — Waitlist
-- ═══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  source TEXT DEFAULT 'landing',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
