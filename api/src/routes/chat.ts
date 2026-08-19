import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { hash } from 'bcryptjs';
import { authMiddleware } from '../middleware/auth';
import { Bindings, Variables } from '../types';
import { jePosted } from '../lib/journal-filters';

const chat = new Hono<{ Bindings: Bindings; Variables: Variables }>();
chat.use('*', authMiddleware);

const SYSTEM_PROMPT = `You are the OPCC CRM AI assistant. You use the Qwen LLM.

CRITICAL — STRICT TOOL EXECUTION FORMAT:
- Never print DSML tags or tool invocation code into the final response text. Always execute tools strictly via the defined tool interface.
- Route EVERY tool execution through the structured function-calling interface (the functions provided to you). Never embed raw XML, DSML blocks, <invoke> tags, or function pseudo-code in your visible message content.
- Your visible reply must contain ONLY the final answer for the user — never internal tool-call payloads or invocation syntax.

CRITICAL — ANNOUNCE-AND-EXECUTE MODE:
- When the user asks a question that requires data (counting, listing, searching, querying), you MUST call the appropriate function AND present results in ONE response.
- Format: briefly state what you're doing, then call the function immediately. Do NOT wait for confirmation.
- Example: briefly announce what you're doing (in the user's language), then call get_counts → present the results.
- Example: announce the listing (in the user's language) + call list_bank_statements → present the list.
- NEVER say "I am about to call" or ask the user to confirm. Just execute.

Rules:
- NEVER write tool call syntax (DSML, XML, <invoke> tags, or function pseudo-code) into your visible reply text — always execute tools through the structured function-calling interface.
- NEVER fabricate or make up data. Only present data that was ACTUALLY returned by your function calls.
- When a function returns data, present it EXACTLY as returned. Do not invent fake names, amounts, or transactions.
- If you cannot access the data, say so honestly. Do not create plausible-looking fake data.
- If a user asks "how many", call get_counts
- If a user asks "list" or "search", call the appropriate function
- If a user asks to create something, call the appropriate create function
- DYNAMIC LANGUAGE: Detect the language of each user message and reply in the SAME language (English, 繁體中文, or 简体中文). If the user switches language, switch with them.
- Be concise and direct
- When presenting numbers, format them clearly
- When presenting lists, show the REAL data from your function calls — do not summarize into fake examples

CRITICAL DELETE RULES:
- NEVER call delete_invoice, delete_quotation, delete_purchase_order, or delete_service_order immediately
- When the user asks to delete something, FIRST list all items that will be deleted (show ID, number, status, amount)
- Then ask the user to confirm (e.g. by replying "確認/确认" or "yes") before proceeding
- Only after explicit user confirmation should you call the delete function(s)
- If the user does not confirm, do NOT delete anything

CRITICAL BOOKKEEPING RULES:
- NEVER call create_bookkeeping_transaction, update_journal_entry, or delete_journal_entry immediately
- When the user asks to create, modify, or delete a journal entry, FIRST show the full details of what will be done (date, description, all debit/credit lines with account codes and amounts)
- Then ask the user to confirm (e.g. by replying "確認/确认" or "yes") before proceeding
- Only after explicit user confirmation should you call the function
- If the user does not confirm, do NOT make any changes
- When modifying an existing entry, use update_journal_entry to change it directly rather than creating offsetting entries
- IMPORTANT: Use EXACTLY these function names: get_bookkeeping_transactions, create_bookkeeping_transaction, update_journal_entry, delete_journal_entry. Do NOT invent other names like get_account_transactions or get_journal_entries.
- If an account code does not exist, use add_account to create it first, then retry the transaction. For example, if "Account code 5105 not found", call add_account with account_code=5105, then retry the original operation.

DYNAMIC QUERY RULES:
- If you need to query data that is NOT covered by any specific function, use query_database with a SQL SELECT query
- ALWAYS include WHERE user_id = ? and pass the user_id as the first parameter
- Example: query_database with sql="SELECT * FROM invoices WHERE user_id = ? AND status = ? LIMIT 10" and params=["user_id", "paid"]
- NEVER use query_database for INSERT, UPDATE, or DELETE — only SELECT
- For any write operations (create, update, delete) on customers, suppliers, products, invoices, etc., ALWAYS ask user to confirm first
- All operations are logged automatically.

BANK STATEMENT RULES:
- Use get_bank_statement_raw to list transactions. It returns a "display" field — present that text VERBATIM in your reply. Do not modify it at all.
- Use get_bank_statement_summary for a quick overview (opening/closing, totals, top 10 transactions).
- Use list_bank_statements to see all available statements.
- Use ocr_bank_statement ONLY when the user explicitly asks to re-OCR the original PDF.
- When the user asks to "list transactions" or "show statement", use get_bank_statement_raw — NEVER get_bank_statement or ocr_bank_statement.

FIRM TOOLS: Use list_firms for firm info, list_staff for staff, add_staff_member to add employees. NEVER use query_database for these.
CODE TOOLS: Use read_code/write_code/list_project_files/git_log/deploy_frontend to edit code. Always read_code first, then write COMPLETE file content.
For counts/numbers: if user asks "多少/幾個/數量/how many/count", call get_counts.

CLIENT COMPANY SCOPE RULES:
- By default, ALL tools operate ONLY on the CURRENT CLIENT COMPANY shown in your system context. Never report data from other companies unless the user EXPLICITLY asks about ALL their clients/companies.
- If the user asks about "all clients" or "all companies", use list_client_companies FIRST to show the available client companies, then ask the user to pick which companies to include (or confirm "all") BEFORE running any aggregation.
- Use get_bookkeeping_all_clients ONLY when the user has explicitly confirmed they want ALL client companies included. It returns per-company and combined totals.
- Never use query_database or any other tool to bypass client scoping or read another company's data.`;

type UiLang = 'en' | 'zh-Hant' | 'zh-Hans';

// Characters unique to each script, used to tell Simplified from Traditional Chinese
const SIMPLIFIED_ONLY = '们这说让现见样东马实发后点么对时问开关经会过国为与认语记账单询还请帮户买卖报录车长头写网页员货费总结数据读计应该没银顾产价购采余额详细输选择确删编辑显载传导电电话邮称码状态类贷税凭证审务业专转调阅览图标办无万亿号档约议谈论评测试验检复';
const TRADITIONAL_ONLY = '們這說讓現見樣東馬實發後點麼對時問開關經會過國為與認語記賬單詢還請幫戶買賣報錄車長頭寫網頁員貨費總結數據讀計應該沒銀顧產價購採餘額詳細輸選擇確刪編輯顯載傳導電電話郵稱碼狀態類貸稅憑證審務業專轉調閱覽圖標辦無萬億號檔約議談論評測試驗檢復複簽籤';

function countChars(text: string, set: string): number {
  let n = 0;
  for (const ch of text) if (set.includes(ch)) n++;
  return n;
}

// Detect the user's language from message text, with the UI language as a hint
// (used when the message contains no CJK, e.g. "ok" or "thanks")
function detectLang(text: string, hint?: string): UiLang {
  const hasCjk = /[一-鿿]/.test(text || '');
  if (!hasCjk) {
    if (hint === 'en' || hint === 'zh-Hans' || hint === 'zh-Hant') return hint;
    return 'en';
  }
  const simp = countChars(text, SIMPLIFIED_ONLY);
  const trad = countChars(text, TRADITIONAL_ONLY);
  if (simp > trad) return 'zh-Hans';
  if (trad > simp) return 'zh-Hant';
  // Ambiguous (only characters shared by both scripts): fall back to hint, then app default (zh-HK)
  if (hint === 'zh-Hans') return 'zh-Hans';
  return 'zh-Hant';
}

// Localized UI strings for chatbot fallbacks / status text
const UI_STRINGS: Record<UiLang, {
  bankStatementHeader: string; askAgain: string; cannotProcess: string;
  processing: string; error: string; done: string; langName: string;
}> = {
  en: {
    bankStatementHeader: '## Bank Statement Transactions\n\n',
    askAgain: 'Sorry, please re-enter your question.',
    cannotProcess: 'Sorry, I could not process that.',
    processing: 'Processing...',
    error: 'Sorry, an error occurred while processing your request.',
    done: 'Done.',
    langName: 'English',
  },
  'zh-Hant': {
    bankStatementHeader: '## 月結單交易記錄\n\n',
    askAgain: '抱歉，請重新輸入您的問題。',
    cannotProcess: '抱歉，我無法處理這個請求。',
    processing: '處理中...',
    error: '抱歉，處理您的請求時發生錯誤。',
    done: '完成。',
    langName: '繁體中文 (Traditional Chinese)',
  },
  'zh-Hans': {
    bankStatementHeader: '## 月结单交易记录\n\n',
    askAgain: '抱歉，请重新输入您的问题。',
    cannotProcess: '抱歉，我无法处理这个请求。',
    processing: '处理中...',
    error: '抱歉，处理您的请求时发生错误。',
    done: '完成。',
    langName: '简体中文 (Simplified Chinese)',
  },
};

const TOOLS: any[] = [
  // ── Dashboard / Summary ──
  { type: 'function', function: { name: 'get_counts', description: 'Get counts of all CRM records for the current user', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_summary', description: 'Get dashboard summary: customer/supplier/invoice/quotation counts plus P&L (income, expense, net)', parameters: { type: 'object', properties: {}, required: [] } } },

  // ── Customers ──
  { type: 'function', function: { name: 'list_customers', description: 'List recent active customers', parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] } } },
  { type: 'function', function: { name: 'search_customers', description: 'Search customers by name, email, or company', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search keyword' }, limit: { type: 'number' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'get_customer', description: 'Get customer details by ID', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Customer ID' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'create_customer', description: 'Create a new customer', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Customer name' }, company_name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, address: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'update_customer', description: 'Update customer fields', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Customer ID' }, name: { type: 'string' }, company_name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, address: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'delete_customer', description: 'Soft-delete a customer', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Customer ID' } }, required: ['id'] } } },

  // ── Suppliers ──
  { type: 'function', function: { name: 'search_suppliers', description: 'Search suppliers by name or company', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search keyword' }, limit: { type: 'number' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'list_suppliers', description: 'List recent active suppliers', parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] } } },
  { type: 'function', function: { name: 'get_supplier', description: 'Get supplier details by ID', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Supplier ID' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'create_supplier', description: 'Create a new supplier', parameters: { type: 'object', properties: { name: { type: 'string' }, company_name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, address: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'update_supplier', description: 'Update supplier fields', parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, company_name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'delete_supplier', description: 'Soft-delete a supplier', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },

  // ── Products ──
  { type: 'function', function: { name: 'list_products', description: 'List all active products and services', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'search_products', description: 'Search products by name or category', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search keyword' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'create_product', description: 'Create a new product or service', parameters: { type: 'object', properties: { name: { type: 'string' }, unit_price: { type: 'number' }, currency: { type: 'string', description: 'HKD/USD/CNY' }, unit: { type: 'string', description: 'pcs/hr/etc' }, category: { type: 'string' } }, required: ['name', 'unit_price'] } } },
  { type: 'function', function: { name: 'update_product', description: 'Update product fields', parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, unit_price: { type: 'number' }, category: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'delete_product', description: 'Soft-delete a product', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },

  // ── Invoices ──
  { type: 'function', function: { name: 'search_invoices', description: 'Search invoices by number or customer name', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search keyword' }, limit: { type: 'number' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'list_invoices', description: 'List recent invoices with optional status filter', parameters: { type: 'object', properties: { status: { type: 'string', description: 'draft, sent, paid, overdue' }, limit: { type: 'number' } }, required: [] } } },
  { type: 'function', function: { name: 'get_invoice', description: 'Get full invoice details by ID including line items', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Invoice ID' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'create_invoice', description: 'Create a new invoice', parameters: { type: 'object', properties: { customer_id: { type: 'string' }, invoice_number: { type: 'string' }, items: { type: 'array', description: 'Array of {description, quantity, unit_price, amount}', items: { type: 'object' } }, due_date: { type: 'string', description: 'YYYY-MM-DD' }, currency: { type: 'string' }, notes: { type: 'string' } }, required: ['customer_id'] } } },
  { type: 'function', function: { name: 'update_invoice_status', description: 'Update invoice status (e.g. mark as sent/paid)', parameters: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', description: 'draft, sent, paid, overdue, cancelled' } }, required: ['id', 'status'] } } },
  { type: 'function', function: { name: 'delete_invoice', description: 'Delete an invoice by ID', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Invoice ID' } }, required: ['id'] } } },

  // ── Quotations ──
  { type: 'function', function: { name: 'list_quotations', description: 'List recent quotations with optional status filter', parameters: { type: 'object', properties: { status: { type: 'string', description: 'draft, sent, accepted, rejected, converted' }, limit: { type: 'number' } }, required: [] } } },
  { type: 'function', function: { name: 'get_quotation', description: 'Get quotation details by ID', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'create_quotation', description: 'Create a new quotation', parameters: { type: 'object', properties: { customer_id: { type: 'string' }, quotation_number: { type: 'string' }, items: { type: 'array', description: 'Array of {description, quantity, unit_price, amount}', items: { type: 'object' } }, valid_until: { type: 'string', description: 'YYYY-MM-DD' }, currency: { type: 'string' } }, required: ['customer_id'] } } },
  { type: 'function', function: { name: 'convert_quotation', description: 'Convert a quotation to an invoice', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Quotation ID' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'delete_quotation', description: 'Delete a quotation by ID', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },

  // ── Purchase Orders ──
  { type: 'function', function: { name: 'get_purchase_order', description: 'Get purchase order details by ID', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'list_purchase_orders', description: 'List recent purchase orders with optional status filter', parameters: { type: 'object', properties: { status: { type: 'string', description: 'draft, approved, received, paid, cancelled' }, limit: { type: 'number' } }, required: [] } } },
  { type: 'function', function: { name: 'create_purchase_order', description: 'Create a new purchase order', parameters: { type: 'object', properties: { supplier_id: { type: 'string' }, items: { type: 'array', description: 'Array of {description, quantity, unit_price, amount}', items: { type: 'object' } }, due_date: { type: 'string', description: 'YYYY-MM-DD' }, currency: { type: 'string' }, notes: { type: 'string' } }, required: [] } } },
  { type: 'function', function: { name: 'update_purchase_order_status', description: 'Update PO status', parameters: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', description: 'draft, approved, received, paid, cancelled' } }, required: ['id', 'status'] } } },
  { type: 'function', function: { name: 'delete_purchase_order', description: 'Delete a purchase order by ID', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },

  // ── Service Orders ──
  { type: 'function', function: { name: 'get_service_order', description: 'Get service order details by ID', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'list_service_orders', description: 'List recent service orders', parameters: { type: 'object', properties: { status: { type: 'string', description: 'draft, active, completed, cancelled' }, limit: { type: 'number' } }, required: [] } } },
  { type: 'function', function: { name: 'create_service_order', description: 'Create a new service order', parameters: { type: 'object', properties: { customer_id: { type: 'string' }, items: { type: 'array', description: 'Array of {description, quantity, unit_price, amount}', items: { type: 'object' } }, valid_from: { type: 'string', description: 'YYYY-MM-DD' }, valid_until: { type: 'string' }, currency: { type: 'string' } }, required: ['customer_id'] } } },
  { type: 'function', function: { name: 'update_service_order_status', description: 'Update SO status', parameters: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', description: 'draft, active, completed, cancelled' } }, required: ['id', 'status'] } } },
  { type: 'function', function: { name: 'delete_service_order', description: 'Delete a service order by ID', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },

  // ── Services & Bookings ──
  { type: 'function', function: { name: 'list_services', description: 'List all active services', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'create_service', description: 'Create a new service', parameters: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number' }, duration_minutes: { type: 'number' }, category: { type: 'string' } }, required: ['name', 'price'] } } },
  { type: 'function', function: { name: 'update_service', description: 'Update a service', parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, price: { type: 'number' }, duration_minutes: { type: 'number' }, category: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'delete_service', description: 'Delete a service', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'list_bookings', description: 'List service bookings', parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' } }, required: [] } } },
  { type: 'function', function: { name: 'create_booking', description: 'Create a service booking', parameters: { type: 'object', properties: { service_id: { type: 'string' }, customer_id: { type: 'string' }, booking_date: { type: 'string', description: 'YYYY-MM-DD' }, start_time: { type: 'string' }, end_time: { type: 'string' }, notes: { type: 'string' } }, required: ['service_id', 'customer_id', 'booking_date', 'start_time'] } } },

  // ── Todos ──
  { type: 'function', function: { name: 'list_todos', description: 'List pending todos, sorted by priority', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'create_todo', description: 'Create a todo item', parameters: { type: 'object', properties: { title: { type: 'string' }, priority: { type: 'string', description: 'high, medium, low' }, due_date: { type: 'string', description: 'YYYY-MM-DD' }, description: { type: 'string' } }, required: ['title'] } } },
  { type: 'function', function: { name: 'update_todo', description: 'Update a todo (complete, edit)', parameters: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', description: 'pending, completed' }, title: { type: 'string' }, priority: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'delete_todo', description: 'Delete a todo item', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },

  // ── Calendar ──
  { type: 'function', function: { name: 'list_calendar_events', description: 'List calendar events for a date range', parameters: { type: 'object', properties: { start: { type: 'string', description: 'YYYY-MM-DD' }, end: { type: 'string', description: 'YYYY-MM-DD' } }, required: [] } } },
  { type: 'function', function: { name: 'create_calendar_event', description: 'Create a calendar event', parameters: { type: 'object', properties: { title: { type: 'string' }, start_time: { type: 'string', description: 'ISO datetime' }, end_time: { type: 'string' }, description: { type: 'string' }, location: { type: 'string' }, customer_id: { type: 'string' } }, required: ['title', 'start_time'] } } },
  { type: 'function', function: { name: 'update_calendar_event', description: 'Update a calendar event', parameters: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, start_time: { type: 'string' }, end_time: { type: 'string' }, description: { type: 'string' }, location: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'delete_calendar_event', description: 'Delete a calendar event', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },

  // ── Company / Profile ──
  { type: 'function', function: { name: 'get_company', description: 'Get company profile settings', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'update_company', description: 'Update company profile fields', parameters: { type: 'object', properties: { name: { type: 'string' }, address: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, website: { type: 'string' }, tagline: { type: 'string' } }, required: [] } } },

  // ── Bookkeeping / Reports ──
  { type: 'function', function: { name: 'get_bookkeeping', description: 'Get P&L (income statement) for a date range', parameters: { type: 'object', properties: { start_date: { type: 'string', description: 'YYYY-MM-DD' }, end_date: { type: 'string', description: 'YYYY-MM-DD' } }, required: [] } } },
  { type: 'function', function: { name: 'list_accounts', description: 'List all chart of accounts with code, name, and type', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'add_account', description: 'Add a new account to the chart of accounts', parameters: { type: 'object', properties: { account_code: { type: 'string', description: 'Account code (e.g. 5105)' }, account_name: { type: 'string', description: 'Account name (e.g. 差旅費用)' }, account_type: { type: 'string', description: 'Type: asset, liability, equity, revenue, expense' }, parent_code: { type: 'string', description: 'Optional parent account code' } }, required: ['account_code', 'account_name', 'account_type'] } } },
  { type: 'function', function: { name: 'get_bookkeeping_transactions', description: 'Get detailed transactions. If account_code is provided, returns transactions for that account with running balance. If account_code is omitted, returns ALL journal entries for the date range with their line items.', parameters: { type: 'object', properties: { account_code: { type: 'string', description: 'Optional account code (e.g. 2102, 1101). Omit to get all entries.' }, start_date: { type: 'string', description: 'YYYY-MM-DD' }, end_date: { type: 'string', description: 'YYYY-MM-DD' } }, required: [] } } },
  { type: 'function', function: { name: 'create_bookkeeping_transaction', description: 'Create a double-entry journal entry. Debits must equal credits. Use this to record transactions like Director Loans, repayments, revenue, expenses, etc.', parameters: { type: 'object', properties: { date: { type: 'string', description: 'Entry date YYYY-MM-DD' }, description: { type: 'string', description: 'Description of the journal entry' }, entries: { type: 'array', description: 'Array of line items. Each line has account_code, debit (number, default 0), credit (number, default 0), description (optional)', items: { type: 'object', properties: { account_code: { type: 'string', description: 'Account code (e.g. 1101, 2102, 4100)' }, debit: { type: 'number' }, credit: { type: 'number' }, description: { type: 'string' } }, required: ['account_code'] } } }, required: ['date', 'description', 'entries'] } } },
  { type: 'function', function: { name: 'update_journal_entry', description: 'Update an existing journal entry. Can change date, description, and line items. Debits must equal credits. Pass ALL lines (existing lines not included will be deleted). Accepts entry_number (e.g. JE-7db3) or entry id (e.g. je-xxxxxxxx).', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Journal entry ID or entry_number (e.g. je-xxxxxxxx or JE-7db3)' }, date: { type: 'string', description: 'New entry date YYYY-MM-DD' }, description: { type: 'string', description: 'New description' }, entries: { type: 'array', description: 'New array of line items (replaces all existing lines)', items: { type: 'object', properties: { account_code: { type: 'string' }, debit: { type: 'number' }, credit: { type: 'number' }, description: { type: 'string' } }, required: ['account_code'] } } }, required: ['id'] } } },
  { type: 'function', function: { name: 'delete_journal_entry', description: 'Delete a journal entry and all its line items', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Journal entry ID (e.g. je-xxxxxxxx)' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'get_balance_sheet', description: 'Get the balance sheet (Assets, Liabilities, Equity) as of a date. Shows financial position.', parameters: { type: 'object', properties: { as_of: { type: 'string', description: 'As-of date YYYY-MM-DD, defaults to today' } }, required: [] } } },
  { type: 'function', function: { name: 'get_recent_activity', description: 'Get recent audit log entries (recent changes)', parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] } } },

  // ── Bank Statements ──
  { type: 'function', function: { name: 'list_bank_statements', description: 'List bank statements with optional year filter', parameters: { type: 'object', properties: { year: { type: 'number', description: 'Filter by year (e.g. 2025)' }, limit: { type: 'number' } }, required: [] } } },
  { type: 'function', function: { name: 'get_bank_statement', description: 'Get a bank statement with its REAL transactions. The data returned is ACTUAL bank data — present it EXACTLY as returned. Do NOT invent or modify any transaction details.', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Bank statement ID' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'get_bank_statement_raw', description: 'Get pre-formatted bank statement listing ready for display. The returned "display" field is a COMPLETE formatted transaction list — copy it VERBATIM into your reply. Do NOT modify, summarize, or invent anything.', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Bank statement ID' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'delete_bank_statement', description: 'Delete a bank statement and its transactions', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Bank statement ID' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'get_bank_statement_summary', description: 'Get a compact summary of a bank statement: opening/closing balances, deposit/withdrawal totals, and key transactions (top 10 by amount). Use this to quickly overview a statement without listing all transactions.', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Bank statement ID' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'ocr_bank_statement', description: 'Run GLM-OCR AI vision on a bank statement PDF to extract detailed transaction text. Use ONLY when user explicitly asks to verify or re-OCR the original PDF. This is SLOW (30+ seconds).', parameters: { type: 'object', properties: { statement_id: { type: 'string', description: 'Bank statement ID (e.g. bs-xxxxxxxx)' } }, required: ['statement_id'] } } },

  // ── Expense Receipts ──
  { type: 'function', function: { name: 'list_expense_receipts', description: 'List expense receipts with optional category and year filter', parameters: { type: 'object', properties: { category: { type: 'string', description: 'Filter by category' }, year: { type: 'number', description: 'Filter by year' }, limit: { type: 'number' } }, required: [] } } },
  { type: 'function', function: { name: 'get_expense_receipt', description: 'Get expense receipt details', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Receipt ID' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'delete_expense_receipt', description: 'Delete an expense receipt', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Receipt ID' } }, required: ['id'] } } },

  // ── File Storage ──
  { type: 'function', function: { name: 'list_files', description: 'List files with optional folder and search filter', parameters: { type: 'object', properties: { folder: { type: 'string', description: 'Filter by folder name' }, query: { type: 'string', description: 'Search filename, description, or OCR text' }, limit: { type: 'number' } }, required: [] } } },
  { type: 'function', function: { name: 'get_file', description: 'Get file metadata details', parameters: { type: 'object', properties: { id: { type: 'string', description: 'File ID' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'update_file', description: 'Update file metadata (filename, folder, description)', parameters: { type: 'object', properties: { id: { type: 'string', description: 'File ID' }, filename: { type: 'string' }, folder: { type: 'string' }, description: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'delete_file', description: 'Delete a file', parameters: { type: 'object', properties: { id: { type: 'string', description: 'File ID' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'read_file_content', description: 'Read the text content of a file (PDF, image, or text). Downloads from storage, extracts text via OCR if needed. Use this to read bank statements, invoices, receipts, or any uploaded document.', parameters: { type: 'object', properties: { id: { type: 'string', description: 'File ID (e.g. fs-xxxxxxxx)' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'import_bank_statement', description: 'Import a file from File Storage as a bank statement. Extracts text, parses transactions (dates, descriptions, deposits, withdrawals, balances), and creates bank_statement + bank_transactions records. The file must already exist in File Storage.', parameters: { type: 'object', properties: { file_id: { type: 'string', description: 'File record ID (e.g. fs-xxxxxxxx)' }, bank_name: { type: 'string', description: 'Optional bank name (e.g. HSBC, BOC, Hang Seng)' }, account_number: { type: 'string', description: 'Optional account number' }, currency: { type: 'string', description: 'Currency code, default HKD' }, statement_year: { type: 'number', description: 'e.g. 2025' }, statement_month: { type: 'number', description: '1-12' } }, required: ['file_id'] } } },
  { type: 'function', function: { name: 'import_invoice_from_file', description: 'Import a file from File Storage as an invoice. Extracts text via OCR, parses invoice number, customer, dates, line items, and amounts, then creates the invoice and customer records. The file must already exist in File Storage.', parameters: { type: 'object', properties: { file_id: { type: 'string', description: 'File record ID (e.g. fs-xxxxxxxx)' } }, required: ['file_id'] } } },

  // ── Documents (BR/CI/EI etc.) ──
  { type: 'function', function: { name: 'list_documents', description: 'List documents (BR, CI, EI, EC, TC, RL) with optional type filter', parameters: { type: 'object', properties: { type: { type: 'string', description: 'Document type: br, ci, ei, ec, tc, rl' }, limit: { type: 'number' } }, required: [] } } },
  { type: 'function', function: { name: 'get_document', description: 'Get document details', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Document ID' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'update_document', description: 'Update document metadata (br_number, company_name, issue_date, expiry_date)', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Document ID' }, br_number: { type: 'string' }, company_name: { type: 'string' }, issue_date: { type: 'string' }, expiry_date: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'delete_document', description: 'Delete a document', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Document ID' } }, required: ['id'] } } },

  // ── Dynamic Query (fallback for any data not covered by specific functions) ──
  { type: 'function', function: { name: 'list_firms', description: 'List firms the current user belongs to', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'list_staff', description: 'List all staff members in the firm', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'add_staff_member', description: 'Add a staff member to the firm. Returns login password.', parameters: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' } }, required: ['email'] } } },
  { type: 'function', function: { name: 'list_client_companies', description: 'List the client companies the current user can access. Firm staff see the firm\'s clients; standalone owners see their sub-accounts. Use this before any "all clients" aggregation to show the user what companies exist and ask which to include.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_bookkeeping_all_clients', description: 'Aggregate profit & loss (bookkeeping) across ALL accessible client companies. Only use when the user has EXPLICITLY confirmed they want all clients included. Returns per-company breakdown and combined totals for the given date range.', parameters: { type: 'object', properties: { start_date: { type: 'string', description: 'Start date YYYY-MM-DD' }, end_date: { type: 'string', description: 'End date YYYY-MM-DD' } }, required: [] } } },
  { type: 'function', function: { name: 'read_code', description: 'Read source code from GitHub repo ai-caseylai/opcc-crm', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_code', description: 'Write a file to GitHub. Read first, then write COMPLETE content.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, message: { type: 'string' } }, required: ['path', 'content', 'message'] } } },
  { type: 'function', function: { name: 'list_project_files', description: 'List files in project repo directory', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] } } },
  { type: 'function', function: { name: 'git_log', description: 'Show recent git commits', parameters: { type: 'object', properties: { count: { type: 'number' } }, required: [] } } },
  { type: 'function', function: { name: 'deploy_frontend', description: 'Deploy frontend to Cloudflare Pages', parameters: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] } } },

  { type: 'function', function: { name: 'query_database', description: 'Execute a SQL SELECT query on the database to retrieve data. Only SELECT queries are allowed and ONLY on these tenant-scoped tables (each has a user_id column): customers, suppliers, products, invoices, quotations, purchase_orders, service_orders, services, service_bookings, todos, calendar_events, journal_entries, accounts, bank_statements, bank_transactions, expense_receipts, file_records, documents, chat_sessions, chat_messages, company_settings, domains. NEVER query journal_lines or any *_items table directly. Use this when no specific function covers the data you need.', parameters: { type: 'object', properties: { sql: { type: 'string', description: 'SQL SELECT query on an allowed table. Must include WHERE user_id = ? placeholder. Example: SELECT * FROM customers WHERE user_id = ? AND name LIKE ? LIMIT 10' }, params: { type: 'array', description: 'Parameters for the query. First param must always be the user_id, additional params as needed.', items: { type: 'string' } } }, required: ['sql'] } } },
];

async function ensureAccount(db: D1Database, userId: string, code: string): Promise<{ code: string; name: string } | null> {
  const acct = await db.prepare('SELECT account_code, account_name FROM accounts WHERE user_id = ? AND account_code = ?').bind(userId, code).first();
  if (acct) return { code: acct.account_code as string, name: acct.account_name as string };
  // Auto-create expense accounts (5xxx)
  if (/^5\d{3}$/.test(code)) {
    await db.prepare('INSERT INTO accounts (id, user_id, account_code, account_name, account_type, parent_code) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(`acc-${uuidv4().slice(0, 8)}`, userId, code, `Expense ${code}`, 'expense', '5000').run();
    return { code, name: `Expense ${code}` };
  }
  return null;
}

// Resolve the client companies a user can access (mirrors firms.ts /my-clients logic):
// - Firm admins: all firm_clients + sub-accounts linked via parent_user_id
// - Firm staff: assigned firm_clients only
// - Standalone supervisor/accountant/admin: sub-accounts linked via parent_user_id
async function resolveAccessibleClients(db: D1Database, firmUserId: string): Promise<{ client_user_id: string; display_name: string | null }[]> {
  const fm = await db.prepare('SELECT firm_id, role FROM firm_members WHERE user_id = ? AND is_active = 1 LIMIT 1').bind(firmUserId).first<{ firm_id: string; role: string }>();
  if (fm) {
    if (fm.role === 'admin') {
      const rows = await db.prepare(
        `SELECT client_user_id, display_name FROM firm_clients WHERE firm_id = ? AND status = ?
         UNION ALL
         SELECT id, company_name FROM users WHERE parent_user_id = ? AND status = ?`
      ).bind(fm.firm_id, 'active', firmUserId, 'active').all();
      return (rows.results as any[]).map(r => ({ client_user_id: r.client_user_id, display_name: r.display_name || r.company_name || null }));
    }
    const rows = await db.prepare(
      `SELECT fc.client_user_id, fc.display_name
       FROM firm_clients fc
       JOIN firm_client_assignments fca ON fca.firm_client_id = fc.id
       JOIN firm_members fme ON fme.id = fca.firm_member_id
       WHERE fme.user_id = ? AND fme.firm_id = ? AND fc.status = ? AND fme.is_active = 1`
    ).bind(firmUserId, fm.firm_id, 'active').all();
    return (rows.results as any[]).map(r => ({ client_user_id: r.client_user_id, display_name: r.display_name || null }));
  }
  const u = await db.prepare('SELECT role FROM users WHERE id = ?').bind(firmUserId).first<{ role: string }>();
  if (u && ['admin', 'supervisor', 'accountant'].includes(u.role)) {
    const rows = await db.prepare(
      `SELECT id, company_name FROM users WHERE parent_user_id = ? AND status = 'active' ORDER BY created_at DESC`
    ).bind(firmUserId).all();
    return (rows.results as any[]).map(r => ({ client_user_id: r.id, display_name: r.company_name || null }));
  }
  return [];
}

// Compute P&L (revenue / expenses / net) for a single client user using the properly
// scoped JOIN (je.user_id = a.user_id) so account codes never fan out across tenants.
async function computeClientPnl(db: D1Database, userId: string, startDate: string, endDate: string): Promise<{ revenue: number; expenses: number; net: number } | null> {
  const rows = await db.prepare(
    `SELECT a.account_type as type, SUM(COALESCE(jl.debit,0)) as total_debit, SUM(COALESCE(jl.credit,0)) as total_credit
     FROM journal_lines jl JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id JOIN journal_entries je ON jl.entry_id = je.id
     WHERE je.user_id = ? AND je.entry_date BETWEEN ? AND ? AND ${jePosted()}
     GROUP BY a.account_type`
  ).bind(userId, startDate, endDate).all();
  if (!rows.results.length) return null;
  let revenue = 0, expenses = 0;
  for (const r of rows.results as any[]) {
    if (r.type === 'revenue') revenue += Number(r.total_credit) || 0;
    else if (r.type === 'expense' || r.type === 'cost') expenses += Number(r.total_debit) || 0;
  }
  return { revenue, expenses, net: revenue - expenses };
}

async function executeTool(name: string, db: D1Database, userId: string, args: any = {}, env?: any, realUserId?: string): Promise<string> {
  const firmUserId = realUserId || userId;
  const limit = args?.limit || 10;
  switch (name) {
    case 'get_counts': {
      const tables = ['customers', 'suppliers', 'products', 'invoices', 'quotations', 'purchase_orders', 'service_orders', 'todos', 'bank_statements', 'bank_transactions', 'journal_entries'];
      const result: Record<string, number> = {};
      for (const t of tables) {
        try {
          const r = await db.prepare(`SELECT COUNT(*) as cnt FROM ${t} WHERE user_id = ?`).bind(userId).first<{cnt:number}>();
          result[t] = r?.cnt || 0;
        } catch { result[t] = 0; }
      }
      return JSON.stringify(result);
    }
    case 'get_summary': {
      const counts: Record<string, number> = {};
      for (const t of ['customers','suppliers','products','invoices','quotations','purchase_orders','service_orders','todos','bank_statements','bank_transactions','journal_entries']) {
        try {
          const r = await db.prepare(`SELECT COUNT(*) as cnt FROM ${t} WHERE user_id = ?`).bind(userId).first<{cnt:number}>();
          counts[t] = r?.cnt || 0;
        } catch { counts[t] = 0; }
      }
      try {
        const invTotal = await db.prepare("SELECT COALESCE(SUM(total),0) as total FROM invoices WHERE user_id = ? AND status = 'paid'").bind(userId).first<{total:number}>();
        const poTotal = await db.prepare("SELECT COALESCE(SUM(total),0) as total FROM purchase_orders WHERE user_id = ? AND status = 'paid'").bind(userId).first<{total:number}>();
        counts.income_paid = invTotal?.total || 0;
        counts.expense_paid = poTotal?.total || 0;
        counts.net = (invTotal?.total || 0) - (poTotal?.total || 0);
      } catch {}
      return JSON.stringify(counts);
    }
    case 'search_invoices': {
      const q = args?.query || '';
      const rows = await db.prepare(
        `SELECT i.id, i.invoice_number, i.status, i.total, i.currency, i.issue_date, c.name as customer_name FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id WHERE i.user_id = ? AND (i.invoice_number LIKE ? OR c.name LIKE ?) ORDER BY i.created_at DESC LIMIT ?`
      ).bind(userId, `%${q}%`, `%${q}%`, limit).all();
      return JSON.stringify(rows.results);
    }
    case 'list_invoices': {
      let q = `SELECT i.id, i.invoice_number, i.status, i.total, i.currency, i.issue_date, i.due_date, i.paid_date, c.name as customer_name FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id WHERE i.user_id = ?`;
      const params: any[] = [userId];
      if (args?.status) { q += ' AND i.status = ?'; params.push(args.status); }
      q += ' ORDER BY i.created_at DESC LIMIT ?'; params.push(limit);
      const rows = await db.prepare(q).bind(...params).all();
      return JSON.stringify(rows.results);
    }
    case 'get_invoice': {
      const inv = await db.prepare(
        'SELECT i.*, c.name as customer_name FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id WHERE i.id = ? AND i.user_id = ?'
      ).bind(args.id, userId).first();
      if (!inv) return JSON.stringify({ error: 'Invoice not found' });
      const items = await db.prepare('SELECT description, quantity, unit_price, amount FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order').bind(args.id).all();
      return JSON.stringify({ ...inv, items: items.results });
    }
    case 'list_quotations': {
      let q = `SELECT q.quotation_number, q.status, q.total, q.currency, q.issue_date, q.valid_until, c.name as customer_name FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id WHERE q.user_id = ?`;
      const params: any[] = [userId];
      if (args?.status) { q += ' AND q.status = ?'; params.push(args.status); }
      q += ' ORDER BY q.created_at DESC LIMIT ?'; params.push(limit);
      const rows = await db.prepare(q).bind(...params).all();
      return JSON.stringify(rows.results);
    }
    case 'list_customers': {
      const rows = await db.prepare('SELECT id, name, company_name, email, phone, created_at FROM customers WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT ?').bind(userId, limit).all();
      return JSON.stringify(rows.results);
    }
    case 'search_customers': {
      const q = args?.query || '';
      const rows = await db.prepare(
        'SELECT id, name, company_name, email, phone, address, created_at FROM customers WHERE user_id = ? AND is_active = 1 AND (name LIKE ? OR email LIKE ? OR company_name LIKE ?) ORDER BY created_at DESC LIMIT ?'
      ).bind(userId, `%${q}%`, `%${q}%`, `%${q}%`, limit).all();
      return JSON.stringify(rows.results);
    }
    case 'get_customer': {
      const row = await db.prepare(
        'SELECT * FROM customers WHERE id = ? AND user_id = ?'
      ).bind(args.id, userId).first();
      if (!row) return JSON.stringify({ error: 'Customer not found' });
      return JSON.stringify(row);
    }
    case 'list_products': {
      const rows = await db.prepare('SELECT id, name, category, unit_price, currency, unit FROM products WHERE user_id = ? AND is_active = 1 ORDER BY name').bind(userId).all();
      return JSON.stringify(rows.results);
    }
    case 'search_products': {
      const q = args?.query || '';
      const rows = await db.prepare(
        'SELECT id, name, category, unit_price, currency, unit FROM products WHERE user_id = ? AND is_active = 1 AND (name LIKE ? OR category LIKE ?) ORDER BY name LIMIT ?'
      ).bind(userId, `%${q}%`, `%${q}%`, limit).all();
      return JSON.stringify(rows.results);
    }
    case 'search_suppliers': {
      const q = args?.query || '';
      const rows = await db.prepare(
        'SELECT id, name, company_name, email, phone FROM suppliers WHERE user_id = ? AND is_active = 1 AND (name LIKE ? OR company_name LIKE ? OR email LIKE ?) ORDER BY name LIMIT ?'
      ).bind(userId, `%${q}%`, `%${q}%`, `%${q}%`, limit).all();
      return JSON.stringify(rows.results);
    }
    case 'list_suppliers': {
      const rows = await db.prepare('SELECT id, name, company_name, email, phone, created_at FROM suppliers WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT ?').bind(userId, limit).all();
      return JSON.stringify(rows.results);
    }
    case 'list_purchase_orders': {
      let q = `SELECT p.id, p.po_number, p.status, p.total, p.currency, p.issue_date, p.paid_date, s.name as supplier_name FROM purchase_orders p LEFT JOIN suppliers s ON p.supplier_id = s.id WHERE p.user_id = ?`;
      const params: any[] = [userId];
      if (args?.status) { q += ' AND p.status = ?'; params.push(args.status); }
      q += ' ORDER BY p.created_at DESC LIMIT ?'; params.push(limit);
      const rows = await db.prepare(q).bind(...params).all();
      return JSON.stringify(rows.results);
    }
    case 'list_todos': {
      const rows = await db.prepare("SELECT id, title, priority, due_date FROM todos WHERE user_id = ? AND status = 'pending' ORDER BY sort_order LIMIT 10").bind(userId).all();
      return JSON.stringify(rows.results);
    }
    case 'get_bookkeeping': {
      const startDate = args?.start_date || '2020-01-01';
      const endDate = args?.end_date || '2099-12-31';
      // Try journal entries first
      try {
        const jlRows = await db.prepare(
          `SELECT a.account_code as code, a.account_name as name, a.account_type as type, SUM(COALESCE(jl.debit,0)) as total_debit, SUM(COALESCE(jl.credit,0)) as total_credit FROM journal_lines jl JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id JOIN journal_entries je ON jl.entry_id = je.id WHERE je.user_id = ? AND je.entry_date BETWEEN ? AND ? AND ${jePosted()} GROUP BY a.account_code, a.account_name, a.account_type ORDER BY a.account_code`
        ).bind(userId, startDate, endDate).all();
        if (jlRows.results.length > 0) return JSON.stringify(jlRows.results);
      } catch {}
      // Fallback: bank transactions
      try {
        const deposits = await db.prepare(
          'SELECT COALESCE(SUM(deposit_amount),0) as total FROM bank_transactions WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ? AND deleted_at IS NULL'
        ).bind(userId, startDate, endDate).first<{ total: number }>();
        const withdrawals = await db.prepare(
          'SELECT COALESCE(SUM(withdrawal_amount),0) as total FROM bank_transactions WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ? AND deleted_at IS NULL'
        ).bind(userId, startDate, endDate).first<{ total: number }>();
        return JSON.stringify([
          { code: 'REV', name: 'Revenue (Bank Deposits)', type: 'revenue', total_credit: deposits?.total || 0 },
          { code: 'EXP', name: 'Expenses (Bank Withdrawals)', type: 'expense', total_debit: withdrawals?.total || 0 },
          { code: 'NET', name: 'Net Income', type: 'equity', total_credit: (deposits?.total || 0) - (withdrawals?.total || 0) },
        ]);
      } catch {
        return JSON.stringify([]);
      }
    }
    case 'get_balance_sheet': {
      const asOf = args?.as_of || new Date().toISOString().split('T')[0];
      const rows = await db.prepare(
        `SELECT jl.account_code, jl.account_name, a.account_type, SUM(jl.debit) as total_debit, SUM(jl.credit) as total_credit
         FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
         LEFT JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
         WHERE je.user_id = ? AND je.entry_date <= ? AND ${jePosted()}
         GROUP BY jl.account_code, jl.account_name
         ORDER BY jl.account_code`
      ).bind(userId, asOf).all();
      if (rows.results.length > 0) {
        const assets: any[] = [], liabilities: any[] = [], equity: any[] = [];
        let rev = 0, exp = 0;
        for (const r of rows.results as any[]) {
          const bal = (r.account_type === 'asset' || r.account_type === 'cost' || r.account_type === 'expense' || (r.account_code||'').startsWith('1')) ? (r.total_debit - r.total_credit) : (r.total_credit - r.total_debit);
          if (r.account_code?.startsWith('1') || r.account_type === 'asset') assets.push({ code: r.account_code, name: r.account_name, balance: bal });
          else if (r.account_code?.startsWith('2') || r.account_type === 'liability') liabilities.push({ code: r.account_code, name: r.account_name, balance: bal });
          else if (r.account_code?.startsWith('3') || r.account_type === 'equity') equity.push({ code: r.account_code, name: r.account_name, balance: bal });
          else if (r.account_code?.startsWith('4') || r.account_type === 'revenue') rev += bal;
          else if (r.account_type === 'cost' || r.account_type === 'expense' || r.account_code?.startsWith('5')) exp += bal;
        }
        const re = rev - exp;
        if (Math.abs(re) > 0.01) equity.push({ code: '3xxx', name: 'Retained Earnings', balance: re });
        const ta = assets.reduce((s: number, a: any) => s + a.balance, 0);
        const tl = liabilities.reduce((s: number, l: any) => s + l.balance, 0);
        const te = equity.reduce((s: number, e: any) => s + e.balance, 0);
        return JSON.stringify({ as_of: asOf, total_assets: ta, total_liabilities: tl, total_equity: te, retained_earnings: re, check: Math.abs(ta - (tl + te)) < 0.01, assets, liabilities, equity });
      }
      // Fallback
      const dep = await db.prepare('SELECT COALESCE(SUM(deposit_amount),0) as amount FROM bank_transactions WHERE user_id = ? AND transaction_date <= ? AND deleted_at IS NULL').bind(userId, asOf).first<{amount:number}>();
      const wit = await db.prepare('SELECT COALESCE(SUM(withdrawal_amount),0) as amount FROM bank_transactions WHERE user_id = ? AND transaction_date <= ? AND deleted_at IS NULL').bind(userId, asOf).first<{amount:number}>();
      const net = (dep?.amount||0) - (wit?.amount||0);
      return JSON.stringify({ as_of: asOf, total_assets: Math.max(net,0), total_liabilities: Math.max(-net,0), total_equity: net, retained_earnings: net, check: true, assets: [{code:'1101',name:'Cash (est.)',balance:Math.max(net,0)}], liabilities: net<0?[{code:'2102',name:'Dir Loan (est.)',balance:-net}]:[], equity: [{code:'3xxx',name:'Retained Earnings (est.)',balance:net}], source: 'bank_estimate' });
    }
    case 'list_accounts': {
      const rows = await db.prepare('SELECT account_code, account_name, account_type, parent_code FROM accounts WHERE user_id = ? ORDER BY account_code').bind(userId).all();
      return JSON.stringify(rows.results);
    }
    case 'add_account': {
      const code = args?.account_code;
      const name = args?.account_name;
      const type = args?.account_type;
      if (!code || !name || !type) return JSON.stringify({ error: 'account_code, account_name, and account_type are required' });
      const validTypes = ['asset', 'liability', 'equity', 'revenue', 'cost', 'expense'];
      if (!validTypes.includes(type)) return JSON.stringify({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
      const existing = await db.prepare('SELECT account_code FROM accounts WHERE user_id = ? AND account_code = ?').bind(userId, code).first();
      if (existing) return JSON.stringify({ error: `Account ${code} already exists` });
      const id = `acc-${uuidv4().slice(0, 8)}`;
      await db.prepare('INSERT INTO accounts (id, user_id, account_code, account_name, account_type, parent_code) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, userId, code, name, type, args?.parent_code || null).run();
      return JSON.stringify({ success: true, account: { code, name, type } });
    }
    case 'get_bookkeeping_transactions': {
      const accountCode = args?.account_code || '';
      const startDate = args?.start_date || '2000-01-01';
      const endDate = args?.end_date || '2099-12-31';
      if (!accountCode) {
        // Return all journal entries with their lines for the date range
        const entries = await db.prepare(
          `SELECT je.id, je.entry_number, je.entry_date, je.description, je.status FROM journal_entries je WHERE je.user_id = ? AND je.entry_date BETWEEN ? AND ? AND ${jePosted()} ORDER BY je.entry_date ASC, je.created_at ASC LIMIT 50`
        ).bind(userId, startDate, endDate).all();
        const result: any[] = [];
        for (const e of entries.results as any[]) {
          const lines = await db.prepare('SELECT account_code, account_name, description, debit, credit FROM journal_lines WHERE entry_id = ? ORDER BY sort_order').bind(e.id).all();
          result.push({ id: e.id, entry_number: e.entry_number, date: e.entry_date, description: e.description, status: e.status, lines: lines.results });
        }
        return JSON.stringify({ entries: result });
      }
      // Get account info
      const acct = await db.prepare('SELECT account_code, account_name, account_type FROM accounts WHERE user_id = ? AND account_code = ?').bind(userId, accountCode).first();
      if (!acct) return JSON.stringify({ error: `Account ${accountCode} not found` });
      // Get all lines for this account within date range, ordered by date
      const rows = await db.prepare(
        `SELECT je.entry_date, je.entry_number, je.id as entry_id, je.description as entry_description, jl.account_code, jl.account_name, jl.description as line_description, jl.debit, jl.credit
         FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
         WHERE je.user_id = ? AND jl.account_code = ? AND je.entry_date BETWEEN ? AND ? AND ${jePosted()}
         ORDER BY je.entry_date ASC, je.created_at ASC`
      ).bind(userId, accountCode, startDate, endDate).all();
      let balance = 0;
      const txns = (rows.results as any[]).map(r => {
        const dr = Number(r.debit) || 0;
        const cr = Number(r.credit) || 0;
        balance += dr - cr;
        return { id: r.entry_id, date: r.entry_date, entry: r.entry_number, description: r.entry_description, line_desc: r.line_description, debit: dr, credit: cr, balance };
      });
      return JSON.stringify({ account: { code: acct.account_code, name: acct.account_name, type: acct.account_type }, total_debit: txns.reduce((s, t) => s + t.debit, 0), total_credit: txns.reduce((s, t) => s + t.credit, 0), closing_balance: balance, transactions: txns });
    }
    case 'create_bookkeeping_transaction': {
      const date = args?.date;
      const desc = args?.description;
      const entries = args?.entries;
      if (!date || !desc || !Array.isArray(entries) || entries.length < 2) {
        return JSON.stringify({ error: 'date, description, and at least 2 entries are required' });
      }
      // Validate debits = credits
      const totalDr = entries.reduce((s: number, e: any) => s + (Number(e.debit) || 0), 0);
      const totalCr = entries.reduce((s: number, e: any) => s + (Number(e.credit) || 0), 0);
      if (Math.abs(totalDr - totalCr) > 0.01) {
        return JSON.stringify({ error: `Debits (${totalDr}) must equal credits (${totalCr})` });
      }
      // Validate account codes exist
      for (const e of entries) {
        const acct = await ensureAccount(db, userId, e.account_code);
        if (!acct) return JSON.stringify({ error: `Account code ${e.account_code} not found. Use add_account to create it first.` });
        e.account_name = acct.name;
      }
      const entryId = `je-${uuidv4().slice(0, 8)}`;
      const entryNumber = `JE-${Date.now().toString(36).toUpperCase()}`;
      await db.prepare(
        'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(entryId, userId, entryNumber, date, desc, 'posted').run();
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        await db.prepare(
          'INSERT INTO journal_lines (entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(entryId, e.account_code, e.account_name, e.description || null, Number(e.debit) || 0, Number(e.credit) || 0, i).run();
      }
      return JSON.stringify({ success: true, entry_id: entryId, entry_number: entryNumber, date, description: desc, total_debit: totalDr, total_credit: totalCr });
    }
    case 'update_journal_entry': {
      let entryId = args?.id;
      if (!entryId) return JSON.stringify({ error: 'id or entry_number is required' });
      // Try lookup by id first, then by entry_number
      let existing = await db.prepare('SELECT * FROM journal_entries WHERE id = ? AND user_id = ?').bind(entryId, userId).first();
      if (!existing) {
        existing = await db.prepare('SELECT * FROM journal_entries WHERE entry_number = ? AND user_id = ?').bind(entryId, userId).first();
        if (existing) entryId = (existing as any).id;
      }
      if (!existing) return JSON.stringify({ error: 'Journal entry not found' });
      const updates: string[] = [];
      const params: any[] = [];
      if (args?.date) { updates.push('entry_date = ?'); params.push(args.date); }
      if (args?.description) { updates.push('description = ?'); params.push(args.description); }
      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        params.push(entryId, userId);
        await db.prepare(`UPDATE journal_entries SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).bind(...params).run();
      }
      // If entries provided, replace all lines
      if (Array.isArray(args?.entries) && args.entries.length >= 2) {
        const totalDr = args.entries.reduce((s: number, e: any) => s + (Number(e.debit) || 0), 0);
        const totalCr = args.entries.reduce((s: number, e: any) => s + (Number(e.credit) || 0), 0);
        if (Math.abs(totalDr - totalCr) > 0.01) return JSON.stringify({ error: `Debits (${totalDr}) must equal credits (${totalCr})` });
        for (const e of args.entries) {
          const acct = await ensureAccount(db, userId, e.account_code);
          if (!acct) return JSON.stringify({ error: `Account code ${e.account_code} not found. Use add_account to create it first.` });
          e.account_name = acct.name;
        }
        await db.prepare('DELETE FROM journal_lines WHERE entry_id = ?').bind(entryId).run();
        for (let i = 0; i < args.entries.length; i++) {
          const e = args.entries[i];
          await db.prepare('INSERT INTO journal_lines (entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(entryId, e.account_code, e.account_name, e.description || null, Number(e.debit) || 0, Number(e.credit) || 0, i).run();
        }
      }
      const updated = await db.prepare('SELECT * FROM journal_entries WHERE id = ?').bind(entryId).first();
      const lines = await db.prepare('SELECT account_code, account_name, description, debit, credit FROM journal_lines WHERE entry_id = ? ORDER BY sort_order').bind(entryId).all();
      return JSON.stringify({ success: true, entry: updated, lines: lines.results });
    }
    case 'delete_journal_entry': {
      const entryId = args?.id;
      if (!entryId) return JSON.stringify({ error: 'id is required' });
      const existing = await db.prepare('SELECT * FROM journal_entries WHERE id = ? AND user_id = ?').bind(entryId, userId).first();
      if (!existing) return JSON.stringify({ error: 'Journal entry not found' });
      await db.prepare('DELETE FROM journal_lines WHERE entry_id = ?').bind(entryId).run();
      await db.prepare('DELETE FROM journal_entries WHERE id = ? AND user_id = ?').bind(entryId, userId).run();
      return JSON.stringify({ success: true, deleted: entryId, entry_number: existing.entry_number, description: existing.description });
    }
    case 'get_recent_activity': {
      const rows = await db.prepare(
        "SELECT action, entity_type, entity_id, created_at FROM audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
      ).bind(userId, limit).all();
      return JSON.stringify(rows.results);
    }

    // ── Customers CRUD ──
    case 'create_customer': {
      const id = `c-${uuidv4().slice(0, 8)}`;
      await db.prepare('INSERT INTO customers (id, user_id, name, company_name, email, phone, address) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, userId, args.name, args.company_name || null, args.email || null, args.phone || null, args.address || null).run();
      const row = await db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
      return JSON.stringify({ success: true, customer: row });
    }
    case 'update_customer': {
      const fields = ['name', 'company_name', 'email', 'phone', 'address'];
      const sets: string[] = [];
      const params: any[] = [];
      for (const f of fields) {
        if (args[f] !== undefined) { sets.push(`${f} = ?`); params.push(args[f]); }
      }
      if (sets.length === 0) return JSON.stringify({ error: 'No fields to update' });
      sets.push("updated_at = datetime('now')");
      params.push(args.id, userId);
      await db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...params).run();
      const row = await db.prepare('SELECT * FROM customers WHERE id = ?').bind(args.id).first();
      return JSON.stringify({ success: true, customer: row });
    }
    case 'delete_customer': {
      await db.prepare('UPDATE customers SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?').bind(args.id, userId).run();
      return JSON.stringify({ success: true, deleted: args.id });
    }

    // ── Suppliers CRUD ──
    case 'get_supplier': {
      const row = await db.prepare('SELECT * FROM suppliers WHERE id = ? AND user_id = ?').bind(args.id, userId).first();
      if (!row) return JSON.stringify({ error: 'Supplier not found' });
      return JSON.stringify(row);
    }
    case 'create_supplier': {
      const id = `s-${uuidv4().slice(0, 8)}`;
      await db.prepare('INSERT INTO suppliers (id, user_id, name, company_name, email, phone, address) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, userId, args.name, args.company_name || null, args.email || null, args.phone || null, args.address || null).run();
      const row = await db.prepare('SELECT * FROM suppliers WHERE id = ?').bind(id).first();
      return JSON.stringify({ success: true, supplier: row });
    }
    case 'update_supplier': {
      const fields = ['name', 'company_name', 'email', 'phone', 'address'];
      const sets: string[] = [];
      const params: any[] = [];
      for (const f of fields) {
        if (args[f] !== undefined) { sets.push(`${f} = ?`); params.push(args[f]); }
      }
      if (sets.length === 0) return JSON.stringify({ error: 'No fields to update' });
      sets.push("updated_at = datetime('now')");
      params.push(args.id, userId);
      await db.prepare(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...params).run();
      const row = await db.prepare('SELECT * FROM suppliers WHERE id = ?').bind(args.id).first();
      return JSON.stringify({ success: true, supplier: row });
    }
    case 'delete_supplier': {
      await db.prepare('UPDATE suppliers SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?').bind(args.id, userId).run();
      return JSON.stringify({ success: true, deleted: args.id });
    }

    // ── Products CRUD ──
    case 'create_product': {
      const id = `p-${uuidv4().slice(0, 8)}`;
      await db.prepare('INSERT INTO products (id, user_id, name, unit_price, currency, unit, category) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, userId, args.name, args.unit_price || 0, args.currency || 'HKD', args.unit || 'pcs', args.category || null).run();
      const row = await db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
      return JSON.stringify({ success: true, product: row });
    }
    case 'update_product': {
      const fields = ['name', 'unit_price', 'currency', 'unit', 'category'];
      const sets: string[] = [];
      const params: any[] = [];
      for (const f of fields) {
        if (args[f] !== undefined) { sets.push(`${f} = ?`); params.push(args[f]); }
      }
      if (sets.length === 0) return JSON.stringify({ error: 'No fields to update' });
      sets.push("updated_at = datetime('now')");
      params.push(args.id, userId);
      await db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...params).run();
      const row = await db.prepare('SELECT * FROM products WHERE id = ?').bind(args.id).first();
      return JSON.stringify({ success: true, product: row });
    }
    case 'delete_product': {
      await db.prepare('UPDATE products SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?').bind(args.id, userId).run();
      return JSON.stringify({ success: true, deleted: args.id });
    }

    // ── Invoices Create / Status ──
    case 'create_invoice': {
      const id = `i-${uuidv4().slice(0, 8)}`;
      const items: any[] = args.items || [];
      const subtotal = items.reduce((s: number, i: any) => s + (i.amount || (i.quantity || 1) * (i.unit_price || 0)), 0);
      const invNum = args.invoice_number || `INV-${Date.now().toString(36).toUpperCase()}`;
      await db.prepare(
        'INSERT INTO invoices (id, user_id, invoice_number, customer_id, issue_date, due_date, subtotal, total, currency, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, userId, invNum, args.customer_id, args.issue_date || new Date().toISOString().split('T')[0], args.due_date || null, subtotal, subtotal, args.currency || 'HKD', args.notes || null).run();
      for (let idx = 0; idx < items.length; idx++) {
        const it = items[idx];
        await db.prepare('INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(`ii-${uuidv4().slice(0, 8)}`, id, it.description, it.quantity || 1, it.unit_price || 0, it.amount || 0, idx).run();
      }
      const row = await db.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
      return JSON.stringify({ success: true, invoice: row });
    }
    case 'update_invoice_status': {
      await db.prepare("UPDATE invoices SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(args.status, args.id, userId).run();
      if (args.status === 'paid') await db.prepare("UPDATE invoices SET paid_date = datetime('now') WHERE id = ? AND user_id = ?").bind(args.id, userId).run();
      return JSON.stringify({ success: true, id: args.id, status: args.status });
    }

    // ── Quotations Create / Get / Convert ──
    case 'get_quotation': {
      const row = await db.prepare('SELECT q.*, c.name as customer_name FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id WHERE q.id = ? AND q.user_id = ?').bind(args.id, userId).first();
      if (!row) return JSON.stringify({ error: 'Quotation not found' });
      const items = await db.prepare('SELECT description, quantity, unit_price, amount FROM quotation_items WHERE quotation_id = ? ORDER BY sort_order').bind(args.id).all();
      return JSON.stringify({ ...row, items: items.results });
    }
    case 'create_quotation': {
      const id = `q-${uuidv4().slice(0, 8)}`;
      const items: any[] = args.items || [];
      const subtotal = items.reduce((s: number, i: any) => s + (i.amount || (i.quantity || 1) * (i.unit_price || 0)), 0);
      const qNum = args.quotation_number || `QUO-${Date.now().toString(36).toUpperCase()}`;
      await db.prepare(
        'INSERT INTO quotations (id, user_id, quotation_number, customer_id, issue_date, valid_until, subtotal, total, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, userId, qNum, args.customer_id, new Date().toISOString().split('T')[0], args.valid_until || null, subtotal, subtotal, args.currency || 'HKD').run();
      for (let idx = 0; idx < items.length; idx++) {
        const it = items[idx];
        await db.prepare('INSERT INTO quotation_items (id, quotation_id, description, quantity, unit_price, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(`qi-${uuidv4().slice(0, 8)}`, id, it.description, it.quantity || 1, it.unit_price || 0, it.amount || 0, idx).run();
      }
      const row = await db.prepare('SELECT * FROM quotations WHERE id = ?').bind(id).first();
      return JSON.stringify({ success: true, quotation: row });
    }
    case 'convert_quotation': {
      const quo = await db.prepare('SELECT * FROM quotations WHERE id = ? AND user_id = ?').bind(args.id, userId).first<any>();
      if (!quo) return JSON.stringify({ error: 'Quotation not found' });
      const invId = `i-${uuidv4().slice(0, 8)}`;
      const invNum = `INV-${Date.now().toString(36).toUpperCase()}`;
      await db.prepare('INSERT INTO invoices (id, user_id, invoice_number, customer_id, issue_date, due_date, subtotal, total, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(invId, userId, invNum, quo.customer_id, new Date().toISOString().split('T')[0], null, quo.subtotal, quo.total, quo.currency).run();
      const qItems = await db.prepare('SELECT * FROM quotation_items WHERE quotation_id = ?').bind(args.id).all();
      for (const qi of qItems.results as any[]) {
        await db.prepare('INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(`ii-${uuidv4().slice(0, 8)}`, invId, qi.description, qi.quantity, qi.unit_price, qi.amount, qi.sort_order).run();
      }
      await db.prepare("UPDATE quotations SET status = 'converted', converted_invoice_id = ? WHERE id = ?").bind(invId, args.id).run();
      return JSON.stringify({ success: true, invoice_id: invId, invoice_number: invNum });
    }

    // ── Purchase Orders Create / Status ──
    case 'create_purchase_order': {
      const id = `po-${uuidv4().slice(0, 8)}`;
      const items: any[] = args.items || [];
      const subtotal = items.reduce((s: number, i: any) => s + (i.amount || (i.quantity || 1) * (i.unit_price || 0)), 0);
      const poNum = args.po_number || `PO-${Date.now().toString(36).toUpperCase()}`;
      await db.prepare(
        'INSERT INTO purchase_orders (id, user_id, po_number, supplier_id, issue_date, due_date, subtotal, total, currency, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, userId, poNum, args.supplier_id || null, new Date().toISOString().split('T')[0], args.due_date || null, subtotal, subtotal, args.currency || 'HKD', args.notes || null).run();
      for (let idx = 0; idx < items.length; idx++) {
        const it = items[idx];
        await db.prepare('INSERT INTO purchase_order_items (id, po_id, description, quantity, unit_price, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(`poi-${uuidv4().slice(0, 8)}`, id, it.description, it.quantity || 1, it.unit_price || 0, it.amount || 0, idx).run();
      }
      const row = await db.prepare('SELECT * FROM purchase_orders WHERE id = ?').bind(id).first();
      return JSON.stringify({ success: true, purchase_order: row });
    }
    case 'get_purchase_order': {
      const row = await db.prepare('SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id WHERE po.id = ? AND po.user_id = ?').bind(args.id, userId).first();
      if (!row) return JSON.stringify({ error: 'Purchase order not found' });
      const items = await db.prepare('SELECT description, quantity, unit_price, amount FROM purchase_order_items WHERE po_id = ? ORDER BY sort_order').bind(args.id).all();
      return JSON.stringify({ ...row, items: items.results });
    }
    case 'update_purchase_order_status': {
      await db.prepare("UPDATE purchase_orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(args.status, args.id, userId).run();
      if (args.status === 'paid') await db.prepare("UPDATE purchase_orders SET paid_date = datetime('now') WHERE id = ? AND user_id = ?").bind(args.id, userId).run();
      return JSON.stringify({ success: true, id: args.id, status: args.status });
    }

    // ── Service Orders Create / Status ──
    case 'list_service_orders': {
      let q = `SELECT so.id, so.so_number, so.status, so.total, so.currency, so.issue_date, so.valid_from, so.valid_until, c.name as customer_name FROM service_orders so LEFT JOIN customers c ON so.customer_id = c.id WHERE so.user_id = ?`;
      const params: any[] = [userId];
      if (args?.status) { q += ' AND so.status = ?'; params.push(args.status); }
      q += ' ORDER BY so.created_at DESC LIMIT ?'; params.push(limit);
      const rows = await db.prepare(q).bind(...params).all();
      return JSON.stringify(rows.results);
    }
    case 'create_service_order': {
      const id = `so-${uuidv4().slice(0, 8)}`;
      const items: any[] = args.items || [];
      const subtotal = items.reduce((s: number, i: any) => s + (i.amount || (i.quantity || 1) * (i.unit_price || 0)), 0);
      const soNum = args.so_number || `SO-${Date.now().toString(36).toUpperCase()}`;
      await db.prepare(
        'INSERT INTO service_orders (id, user_id, so_number, customer_id, issue_date, valid_from, valid_until, subtotal, total, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, userId, soNum, args.customer_id, new Date().toISOString().split('T')[0], args.valid_from || null, args.valid_until || null, subtotal, subtotal, args.currency || 'HKD').run();
      for (let idx = 0; idx < items.length; idx++) {
        const it = items[idx];
        await db.prepare('INSERT INTO service_order_items (id, so_id, description, quantity, unit_price, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(`soi-${uuidv4().slice(0, 8)}`, id, it.description, it.quantity || 1, it.unit_price || 0, it.amount || 0, idx).run();
      }
      const row = await db.prepare('SELECT * FROM service_orders WHERE id = ?').bind(id).first();
      return JSON.stringify({ success: true, service_order: row });
    }
    case 'get_service_order': {
      const row = await db.prepare('SELECT so.*, c.name as customer_name FROM service_orders so LEFT JOIN customers c ON so.customer_id = c.id WHERE so.id = ? AND so.user_id = ?').bind(args.id, userId).first();
      if (!row) return JSON.stringify({ error: 'Service order not found' });
      const items = await db.prepare('SELECT description, quantity, unit_price, amount FROM service_order_items WHERE so_id = ? ORDER BY sort_order').bind(args.id).all();
      return JSON.stringify({ ...row, items: items.results });
    }
    case 'update_service_order_status': {
      await db.prepare("UPDATE service_orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(args.status, args.id, userId).run();
      return JSON.stringify({ success: true, id: args.id, status: args.status });
    }

    // ── Services & Bookings ──
    case 'list_services': {
      const rows = await db.prepare('SELECT id, name, category, price, duration_minutes FROM services WHERE user_id = ? AND is_active = 1 ORDER BY name').bind(userId).all();
      return JSON.stringify(rows.results);
    }
    case 'create_service': {
      const id = `svc-${uuidv4().slice(0, 8)}`;
      await db.prepare('INSERT INTO services (id, user_id, name, price, duration_minutes, category) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, userId, args.name, args.price || 0, args.duration_minutes || 60, args.category || 'general').run();
      return JSON.stringify({ success: true, id });
    }
    case 'update_service': {
      const fields = ['name', 'price', 'duration_minutes', 'category'];
      const sets: string[] = [];
      const params: any[] = [];
      for (const f of fields) {
        if (args[f] !== undefined) { sets.push(`${f} = ?`); params.push(args[f]); }
      }
      if (sets.length === 0) return JSON.stringify({ error: 'No fields to update' });
      sets.push("updated_at = datetime('now')");
      params.push(args.id, userId);
      await db.prepare(`UPDATE services SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...params).run();
      return JSON.stringify({ success: true, id: args.id });
    }
    case 'delete_service': {
      await db.prepare('UPDATE services SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?').bind(args.id, userId).run();
      return JSON.stringify({ success: true, deleted: args.id });
    }
    case 'list_bookings': {
      let q = 'SELECT sb.*, s.name as service_name, c.name as customer_name FROM service_bookings sb JOIN services s ON sb.service_id = s.id LEFT JOIN customers c ON sb.customer_id = c.id WHERE sb.user_id = ?';
      const params: any[] = [userId];
      if (args?.date) { q += ' AND sb.booking_date = ?'; params.push(args.date); }
      q += ' ORDER BY sb.booking_date DESC, sb.start_time LIMIT ?'; params.push(limit);
      const rows = await db.prepare(q).bind(...params).all();
      return JSON.stringify(rows.results);
    }
    case 'create_booking': {
      const id = `bk-${uuidv4().slice(0, 8)}`;
      await db.prepare('INSERT INTO service_bookings (id, user_id, service_id, customer_id, booking_date, start_time, end_time, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, userId, args.service_id, args.customer_id, args.booking_date, args.start_time, args.end_time || null, args.notes || null).run();
      return JSON.stringify({ success: true, id });
    }

    // ── Todos CRUD ──
    case 'create_todo': {
      const id = `td-${uuidv4().slice(0, 8)}`;
      await db.prepare('INSERT INTO todos (id, user_id, title, description, priority, due_date) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, userId, args.title, args.description || null, args.priority || 'medium', args.due_date || null).run();
      return JSON.stringify({ success: true, id, title: args.title });
    }
    case 'update_todo': {
      const fields = ['title', 'description', 'status', 'priority', 'due_date'];
      const sets: string[] = [];
      const params: any[] = [];
      for (const f of fields) {
        if (args[f] !== undefined) { sets.push(`${f} = ?`); params.push(args[f]); }
      }
      if (sets.length === 0) return JSON.stringify({ error: 'No fields to update' });
      params.push(args.id, userId);
      await db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...params).run();
      return JSON.stringify({ success: true, id: args.id });
    }
    case 'delete_todo': {
      await db.prepare('DELETE FROM todos WHERE id = ? AND user_id = ?').bind(args.id, userId).run();
      return JSON.stringify({ success: true, deleted: args.id });
    }

    // ── Calendar ──
    case 'list_calendar_events': {
      const start = args?.start || new Date().toISOString().split('T')[0];
      const end = args?.end || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const rows = await db.prepare('SELECT id, title, event_type, start_time, end_time, all_day, status, location FROM calendar_events WHERE user_id = ? AND start_time BETWEEN ? AND ? ORDER BY start_time')
        .bind(userId, start, end).all();
      return JSON.stringify(rows.results);
    }
    case 'create_calendar_event': {
      const id = `evt-${uuidv4().slice(0, 8)}`;
      await db.prepare('INSERT INTO calendar_events (id, user_id, title, start_time, end_time, description, location, customer_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, userId, args.title, args.start_time, args.end_time || null, args.description || null, args.location || null, args.customer_id || null).run();
      return JSON.stringify({ success: true, id, title: args.title });
    }
    case 'update_calendar_event': {
      const fields = ['title', 'start_time', 'end_time', 'description', 'location', 'status'];
      const sets: string[] = [];
      const params: any[] = [];
      for (const f of fields) {
        if (args[f] !== undefined) { sets.push(`${f} = ?`); params.push(args[f]); }
      }
      if (sets.length === 0) return JSON.stringify({ error: 'No fields to update' });
      sets.push("updated_at = datetime('now')");
      params.push(args.id, userId);
      await db.prepare(`UPDATE calendar_events SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...params).run();
      return JSON.stringify({ success: true, id: args.id });
    }
    case 'delete_calendar_event': {
      await db.prepare('DELETE FROM calendar_events WHERE id = ? AND user_id = ?').bind(args.id, userId).run();
      return JSON.stringify({ success: true, deleted: args.id });
    }

    // ── Company ──
    case 'get_company': {
      const row = await db.prepare('SELECT * FROM company_settings WHERE user_id = ?').bind(userId).first();
      if (!row) return JSON.stringify({ error: 'Company not configured' });
      return JSON.stringify(row);
    }
    case 'update_company': {
      const fields = ['name', 'address', 'phone', 'email', 'website', 'tagline', 'legal_name', 'short_name', 'tax_id'];
      const sets: string[] = [];
      const params: any[] = [];
      for (const f of fields) {
        if (args[f] !== undefined) { sets.push(`${f} = ?`); params.push(args[f]); }
      }
      if (sets.length === 0) return JSON.stringify({ error: 'No fields to update' });
      sets.push("updated_at = datetime('now')");
      params.push(userId);
      await db.prepare(`UPDATE company_settings SET ${sets.join(', ')} WHERE user_id = ?`).bind(...params).run();
      return JSON.stringify({ success: true });
    }

    // ── Bank Statements ──
    case 'list_bank_statements': {
      let q = 'SELECT id, bank_name, account_number, statement_year, statement_month, opening_balance, closing_balance, file_name, created_at FROM bank_statements WHERE user_id = ? AND deleted_at IS NULL';
      const params: any[] = [userId];
      if (args?.year) { q += ' AND statement_year = ?'; params.push(args.year); }
      q += ' ORDER BY statement_year DESC, statement_month DESC LIMIT ?'; params.push(limit);
      const rows = await db.prepare(q).bind(...params).all();
      return JSON.stringify(rows.results);
    }
    case 'get_bank_statement': {
      const bs = await db.prepare('SELECT * FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(args.id, userId).first();
      if (!bs) return JSON.stringify({ error: 'Bank statement not found' });
      const txns = await db.prepare('SELECT transaction_date, description, deposit_amount, withdrawal_amount FROM bank_transactions WHERE bank_statement_id = ? AND deleted_at IS NULL AND description NOT LIKE ? ORDER BY sort_order LIMIT 50').bind(args.id, '%TRANSACTION SUMMARY%').all();
      const lines = txns.results.map((t: any) =>
        `${t.transaction_date} | ${(t.deposit_amount||0) > 0 ? '+' + t.deposit_amount : ''}${(t.withdrawal_amount||0) > 0 ? '-' + t.withdrawal_amount : ''} | ${(t.description||'').slice(0,60)}`
      ).join('\n');
      return JSON.stringify({
        statement: `${bs.file_name} (${bs.bank_name} ${bs.account_number})`,
        period: `${bs.period_start || ''} ~ ${bs.period_end || ''}`,
        opening: bs.opening_balance,
        closing: bs.closing_balance,
        transactions: lines,
        count: txns.results.length,
      });
    }
    case 'get_bank_statement_raw': {
      const bs = await db.prepare('SELECT id, file_name, bank_name, account_number, currency, statement_year, statement_month, period_start, period_end, opening_balance, closing_balance FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(args.id, userId).first<any>();
      if (!bs) return JSON.stringify({ error: 'Bank statement not found' });
      const txns = await db.prepare(
        "SELECT transaction_date, description, deposit_amount, withdrawal_amount, balance FROM bank_transactions WHERE bank_statement_id = ? AND deleted_at IS NULL AND description NOT LIKE '%TRANSACTION SUMMARY%' AND description NOT LIKE '%CARRIED FORWARD%' ORDER BY sort_order LIMIT 100"
      ).bind(args.id).all();

      let display = `## ${bs.file_name} — ${bs.bank_name} ${bs.account_number}\n`;
      display += `**${bs.statement_year}-${String(bs.statement_month).padStart(2,'0')}** | Opening: ${Number(bs.opening_balance).toLocaleString()} | Closing: ${Number(bs.closing_balance).toLocaleString()}\n\n`;
      display += `| Date | Description | Deposit | Withdrawal | Balance |\n`;
      display += `|------|-------------|---------|------------|--------|\n`;

      for (const tx of txns.results as any[]) {
        const dep = tx.deposit_amount > 0 ? Number(tx.deposit_amount).toLocaleString() : '';
        const wit = tx.withdrawal_amount > 0 ? Number(tx.withdrawal_amount).toLocaleString() : '';
        const bal = tx.balance != null ? Number(tx.balance).toLocaleString() : '';
        const desc = (tx.description || '').replace(/\|/g, '/').slice(0, 60);
        display += `| ${tx.transaction_date} | ${desc} | ${dep} | ${wit} | ${bal} |\n`;
      }

      display += `\n**Total: ${txns.results.length} transactions**`;
      return JSON.stringify({ display, count: txns.results.length });
    }
    case 'get_bank_statement_summary': {
      const bs = await db.prepare('SELECT id, file_name, bank_name, account_number, currency, statement_year, statement_month, period_start, period_end, opening_balance, closing_balance FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(args.id, userId).first();
      if (!bs) return JSON.stringify({ error: 'Bank statement not found' });
      const totals = await db.prepare(
        "SELECT COUNT(*) as tx_count, COALESCE(SUM(deposit_amount),0) as total_dep, COALESCE(SUM(withdrawal_amount),0) as total_wit FROM bank_transactions WHERE bank_statement_id = ? AND deleted_at IS NULL AND description NOT LIKE '%TRANSACTION SUMMARY%' AND description NOT LIKE '%CARRIED FORWARD%'"
      ).bind(args.id).first();
      const topTx = await db.prepare(
        "SELECT transaction_date, description, deposit_amount, withdrawal_amount FROM bank_transactions WHERE bank_statement_id = ? AND deleted_at IS NULL ORDER BY (deposit_amount + withdrawal_amount) DESC LIMIT 10"
      ).bind(args.id).all();
      return JSON.stringify({ ...bs, ...totals, top_transactions: topTx.results });
    }
    case 'delete_bank_statement': {
      await db.prepare('DELETE FROM bank_transactions WHERE bank_statement_id = ? AND user_id = ?').bind(args.id, userId).run();
      await db.prepare('DELETE FROM bank_statements WHERE id = ? AND user_id = ?').bind(args.id, userId).run();
      return JSON.stringify({ success: true, deleted: args.id });
    }
    case 'ocr_bank_statement': {
      const stmt = await db.prepare('SELECT id, r2_key, file_name, file_type, ocr_text FROM bank_statements WHERE id = ? AND user_id = ?').bind(args.statement_id, userId).first<{ id: string; r2_key: string; file_name: string; file_type: string; ocr_text: string }>();
      if (!stmt) return JSON.stringify({ error: 'Bank statement not found' });
      if (!env?.FILE_BUCKET) return JSON.stringify({ error: 'Storage not available' });
      if (!env?.GLM_API_KEY) return JSON.stringify({ error: 'GLM_API_KEY not configured' });

      try {
        const obj = await env.FILE_BUCKET.get(stmt.r2_key);
        if (!obj) return JSON.stringify({ error: 'PDF file not found in storage' });

        const buffer = await obj.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const base64 = btoa(binary);

        const glmResp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.GLM_API_KEY}`,
          },
          body: JSON.stringify({ model: 'glm-ocr', file: `data:${stmt.file_type || 'application/pdf'};base64,${base64}` }),
        });

        if (!glmResp.ok) {
          const errText = await glmResp.text();
          return JSON.stringify({ error: 'GLM-OCR API failed', status: glmResp.status, detail: errText.slice(0, 500) });
        }

        const glmData = await glmResp.json() as any;

        // Save FULL GLM-OCR result to bank_statements
        const fullResult = JSON.stringify(glmData);
        await db.prepare("UPDATE bank_statements SET ocr_text = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(fullResult.slice(0, 50000), stmt.id).run();

        // Also extract text from layout_details for readability
        const layouts = glmData?.layout_details || [];
        let readableText = '';
        for (const pageIdx in layouts) {
          readableText += `\n=== Page ${parseInt(pageIdx)+1} ===\n`;
          for (const item of layouts[pageIdx]) {
            if (item.content) {
              const label = item.label || 'text';
              readableText += `[${label}] ${item.content}\n`;
            }
          }
        }

        return JSON.stringify({
          success: true,
          statement_id: stmt.id,
          file_name: stmt.file_name,
          pages: glmData?.data_info?.num_pages || 0,
          full_text: readableText.slice(0, 20000),
        });
      } catch (e: any) {
        return JSON.stringify({ error: 'OCR failed: ' + (e.message || 'unknown') });
      }
    }

    // ── Expense Receipts ──
    case 'list_expense_receipts': {
      let q = 'SELECT id, file_name, vendor_name, amount, expense_date, category, description, payment_method, status, created_at FROM expense_receipts WHERE user_id = ?';
      const params: any[] = [userId];
      if (args?.category) { q += ' AND category = ?'; params.push(args.category); }
      if (args?.year) { q += " AND substr(expense_date,1,4) = ?"; params.push(String(args.year)); }
      q += ' ORDER BY created_at DESC LIMIT ?'; params.push(limit);
      const rows = await db.prepare(q).bind(...params).all();
      return JSON.stringify(rows.results);
    }
    case 'get_expense_receipt': {
      const row = await db.prepare('SELECT * FROM expense_receipts WHERE id = ? AND user_id = ?').bind(args.id, userId).first();
      if (!row) return JSON.stringify({ error: 'Expense receipt not found' });
      return JSON.stringify(row);
    }
    case 'delete_expense_receipt': {
      await db.prepare('DELETE FROM expense_receipts WHERE id = ? AND user_id = ?').bind(args.id, userId).run();
      return JSON.stringify({ success: true, deleted: args.id });
    }

    // ── File Storage ──
    case 'list_files': {
      let q = 'SELECT id, folder, filename, file_type, file_size, category, direction, ocr_status, description, created_at FROM file_records WHERE user_id = ?';
      const params: any[] = [userId];
      if (args?.folder) { q += ' AND folder = ?'; params.push(args.folder); }
      if (args?.query) { q += ' AND (filename LIKE ? OR description LIKE ? OR ocr_text LIKE ?)'; params.push(`%${args.query}%`, `%${args.query}%`, `%${args.query}%`); }
      q += ' ORDER BY created_at DESC LIMIT ?'; params.push(limit);
      const rows = await db.prepare(q).bind(...params).all();
      return JSON.stringify(rows.results);
    }
    case 'get_file': {
      const row = await db.prepare('SELECT id, folder, filename, original_name, file_type, file_size, category, direction, ocr_status, ocr_text, description, amount, payment_status, created_at FROM file_records WHERE id = ? AND user_id = ?').bind(args.id, userId).first();
      if (!row) return JSON.stringify({ error: 'File not found' });
      return JSON.stringify(row);
    }
    case 'update_file': {
      const fields = ['filename', 'folder', 'description'];
      const sets: string[] = [];
      const params: any[] = [];
      for (const f of fields) {
        if (args[f] !== undefined) { sets.push(`${f} = ?`); params.push(args[f]); }
      }
      if (sets.length === 0) return JSON.stringify({ error: 'No fields to update' });
      sets.push("updated_at = datetime('now')");
      params.push(args.id, userId);
      await db.prepare(`UPDATE file_records SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...params).run();
      return JSON.stringify({ success: true, id: args.id });
    }
    case 'delete_file': {
      await db.prepare('DELETE FROM file_records WHERE id = ? AND user_id = ?').bind(args.id, userId).run();
      return JSON.stringify({ success: true, deleted: args.id });
    }
    case 'read_file_content': {
      const row = await db.prepare('SELECT id, r2_key, filename, original_name, file_type, ocr_text, ocr_status, category FROM file_records WHERE id = ? AND user_id = ?').bind(args.id, userId).first<{ id: string; r2_key: string; filename: string; original_name: string; file_type: string; ocr_text: string; ocr_status: string; category: string }>();
      if (!row) return JSON.stringify({ error: 'File not found' });
      if (row.ocr_text && row.ocr_text.length > 20) {
        return JSON.stringify({ file_id: row.id, filename: row.filename, file_type: row.file_type, category: row.category, ocr_status: row.ocr_status, content: row.ocr_text });
      }
      if (!env?.FILE_BUCKET) return JSON.stringify({ error: 'Storage not available', ocr_status: row.ocr_status, ocr_text: row.ocr_text || '' });
      try {
        const obj = await env.FILE_BUCKET.get(row.r2_key);
        if (!obj) return JSON.stringify({ error: 'File data not found in storage' });
        const buffer = await obj.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const base64 = btoa(binary);
        const mimeType = row.file_type || 'application/octet-stream';
        const isPdf = mimeType.includes('pdf');
        const isImage = mimeType.includes('image') || mimeType.includes('png') || mimeType.includes('jpg') || mimeType.includes('jpeg');
        if (!isPdf && !isImage) {
          const text = new TextDecoder().decode(buffer);
          return JSON.stringify({ file_id: row.id, filename: row.filename, file_type: row.file_type, content: text.slice(0, 10000) });
        }
        let ocrText = '';
        if (env.AI) {
          try {
            const aiResponse = await env.AI.run('@cf/unum/uform-gen2-qwen-500m', {
              prompt: 'Extract all visible text from this document. Include all dates, amounts, transaction descriptions, account numbers, company names, and any financial data.',
              image: isPdf ? [...bytes].map(b => String.fromCharCode(b)).join('') : base64,
            });
            ocrText = aiResponse?.description || '';
          } catch {}
        }
        if (!ocrText && env.DEEPSEEK_API_KEY && isImage) {
          try {
            const resp = await fetch('https://api.deepseek.com/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}` },
              body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: [{ type: 'text', text: 'Extract all visible text from this document thoroughly.' }, { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }] }], max_tokens: 2000 }),
            });
            const data = await resp.json() as any;
            ocrText = data.choices?.[0]?.message?.content || '';
          } catch {}
        }
        if (ocrText) {
          await db.prepare("UPDATE file_records SET ocr_text = ?, ocr_status = 'completed', updated_at = datetime('now') WHERE id = ?").bind(ocrText, row.id).run();
        }
        return JSON.stringify({ file_id: row.id, filename: row.filename, file_type: row.file_type, category: row.category, ocr_status: ocrText ? 'completed' : (row.ocr_status || 'failed'), content: ocrText || row.ocr_text || '(No text could be extracted. The file may be a scanned PDF that requires a different OCR engine.)' });
      } catch (e: any) {
        return JSON.stringify({ error: 'Failed to read file: ' + (e.message || 'unknown error') });
      }
    }
    case 'import_bank_statement': {
      const fileId = args.file_id;
      const fileRow = await db.prepare('SELECT id, r2_key, filename, original_name, file_type, ocr_text, ocr_status, category, folder FROM file_records WHERE id = ? AND user_id = ?').bind(fileId, userId).first<{ id: string; r2_key: string; filename: string; original_name: string; file_type: string; ocr_text: string; ocr_status: string; category: string; folder: string }>();
      if (!fileRow) return JSON.stringify({ error: 'File not found. Use list_files to find available files.' });
      const existing = await db.prepare('SELECT id FROM bank_statements WHERE user_id = ? AND r2_key = ? AND deleted_at IS NULL').bind(userId, fileRow.r2_key).first();
      if (existing) return JSON.stringify({ error: 'This file has already been imported as a bank statement', statement_id: existing.id });
      let ocrText = fileRow.ocr_text || '';
      if (!ocrText || ocrText.length < 20) {
        if (env?.FILE_BUCKET) {
          try {
            const obj = await env.FILE_BUCKET.get(fileRow.r2_key);
            if (obj) {
              const buffer = await obj.arrayBuffer();
              const bytes = new Uint8Array(buffer);
              let binary = '';
              for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
              const base64 = btoa(binary);
              const mimeType = fileRow.file_type || 'application/pdf';
              if (env.AI) {
                try {
                  const aiResponse = await env.AI.run('@cf/unum/uform-gen2-qwen-500m', { prompt: 'Extract all visible text from this bank statement. Include all transaction dates, descriptions, deposit amounts, withdrawal amounts, balances, account numbers, bank name, statement period, opening and closing balances.', image: base64 });
                  ocrText = aiResponse?.description || '';
                } catch {}
              }
            }
          } catch {}
        }
      }
      if (!ocrText || ocrText.length < 10) return JSON.stringify({ error: 'Could not extract text from this file. The file may be corrupted or in an unsupported format.' });
      let parsed: any = null;
      const deepseekKey = env?.DEEPSEEK_API_KEY;
      if (deepseekKey) {
        try {
          const parseResp = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${deepseekKey}` },
            body: JSON.stringify({
              model: 'deepseek-chat',
              messages: [{ role: 'user', content: `Parse the following bank statement OCR text into structured JSON. Extract:
- bank_name: the bank name
- account_number: account number if visible
- currency: default "HKD"
- statement_year and statement_month: from statement period
- period_start and period_end: dates in YYYY-MM-DD
- opening_balance and closing_balance: numbers
- transactions: array of { transaction_date (YYYY-MM-DD), description, deposit_amount (number, 0 if withdrawal), withdrawal_amount (number, 0 if deposit), balance (number or null) }

Return ONLY valid JSON, no explanation. If you can't parse something, use null.

OCR TEXT:
${ocrText.slice(0, 8000)}` }],
              max_tokens: 4000,
            }),
          });
          const parseData = await parseResp.json() as any;
          const raw = parseData.choices?.[0]?.message?.content || '';
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
        } catch {}
      }
      const stmtId = `bs-${uuidv4().slice(0, 8)}`;
      const bankName = args.bank_name || parsed?.bank_name || null;
      const accountNumber = args.account_number || parsed?.account_number || null;
      const currency = args.currency || parsed?.currency || 'HKD';
      const stmtYear = args.statement_year || parsed?.statement_year || null;
      const stmtMonth = args.statement_month || parsed?.statement_month || null;
      const periodStart = parsed?.period_start || null;
      const periodEnd = parsed?.period_end || null;
      const openingBal = parsed?.opening_balance ?? null;
      const closingBal = parsed?.closing_balance ?? null;
      await db.prepare(
        `INSERT INTO bank_statements (id, user_id, file_name, file_type, file_data, r2_key, bank_name, account_number, branch, currency, account_type, statement_year, statement_month, period_start, period_end, opening_balance, closing_balance, page_count, ocr_text)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(stmtId, userId, fileRow.original_name || fileRow.filename, fileRow.file_type, '', fileRow.r2_key, bankName, accountNumber, null, currency, null, stmtYear, stmtMonth, periodStart, periodEnd, openingBal, closingBal, null, ocrText).run();
      let txCount = 0;
      const transactions = parsed?.transactions || [];
      for (const tx of transactions) {
        if (!tx.transaction_date) continue;
        const txId = `bt-${uuidv4().slice(0, 8)}`;
        await db.prepare(
          `INSERT INTO bank_transactions (id, bank_statement_id, user_id, transaction_date, description, deposit_amount, withdrawal_amount, balance, sort_order)
           VALUES (?,?,?,?,?,?,?,?,?)`
        ).bind(txId, stmtId, userId, tx.transaction_date, tx.description || '', tx.deposit_amount || 0, tx.withdrawal_amount || 0, tx.balance ?? null, txCount).run();
        txCount++;
      }
      await db.prepare("UPDATE file_records SET category = 'bank_statement', folder = 'Bank Statements', updated_at = datetime('now') WHERE id = ?").bind(fileId).run();
      return JSON.stringify({ success: true, statement_id: stmtId, file_name: fileRow.original_name || fileRow.filename, bank_name: bankName, account_number: accountNumber, currency, statement_year: stmtYear, statement_month: stmtMonth, opening_balance: openingBal, closing_balance: closingBal, transactions_count: txCount, parsed_via_ai: !!parsed });
    }
    case 'import_invoice_from_file': {
      const fileId = args.file_id;
      const fileRow = await db.prepare('SELECT id, r2_key, filename, original_name, file_type, ocr_text, ocr_status, category, direction FROM file_records WHERE id = ? AND user_id = ?').bind(fileId, userId).first<{ id: string; r2_key: string; filename: string; original_name: string; file_type: string; ocr_text: string; ocr_status: string; category: string; direction: string }>();
      if (!fileRow) return JSON.stringify({ error: 'File not found. Use list_files to find available files.' });
      let ocrText = fileRow.ocr_text || '';
      if (!ocrText || ocrText.length < 20) {
        if (env?.FILE_BUCKET) {
          try {
            const obj = await env.FILE_BUCKET.get(fileRow.r2_key);
            if (obj) {
              const buffer = await obj.arrayBuffer();
              const bytes = new Uint8Array(buffer);
              let binary = '';
              for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
              const base64 = btoa(binary);
              if (env.AI) {
                try {
                  const aiResponse = await env.AI.run('@cf/unum/uform-gen2-qwen-500m', { prompt: 'Extract all visible text from this invoice. Include invoice number, dates, company names, amounts, line items with descriptions and prices.', image: base64 });
                  ocrText = aiResponse?.description || '';
                } catch {}
              }
            }
          } catch {}
        }
      }
      if (!ocrText || ocrText.length < 10) return JSON.stringify({ error: 'Could not extract text. This file may not be readable.' });
      const deepseekKey = env?.DEEPSEEK_API_KEY;
      let parsed: any = null;
      if (deepseekKey) {
        try {
          const resp = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${deepseekKey}` },
            body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: `Parse this invoice OCR text into structured JSON. Extract: invoice_number, customer_name, customer_email, issue_date (YYYY-MM-DD), due_date, currency (default "HKD"), items as array of { description, quantity, unit_price, amount }, total, notes. Return ONLY valid JSON. OCR:\n${ocrText.slice(0, 8000)}` }], max_tokens: 4000 }),
          });
          const data = await resp.json() as any;
          const raw = data.choices?.[0]?.message?.content || '';
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
        } catch {}
      }
      // Match or create customer
      let customerId: string | null = null;
      if (parsed?.customer_email) {
        const c = await db.prepare('SELECT id FROM customers WHERE user_id = ? AND email = ?').bind(userId, parsed.customer_email).first<{ id: string }>();
        if (c) customerId = c.id;
      }
      if (!customerId && parsed?.customer_name) {
        const c = await db.prepare('SELECT id FROM customers WHERE user_id = ? AND name LIKE ?').bind(userId, `%${parsed.customer_name}%`).first<{ id: string }>();
        if (c) customerId = c.id;
      }
      if (!customerId && parsed?.customer_name) {
        customerId = `c-${uuidv4().slice(0, 8)}`;
        await db.prepare('INSERT INTO customers (id, user_id, name, email, is_active) VALUES (?, ?, ?, ?, 1)').bind(customerId, userId, parsed.customer_name, parsed.customer_email || null).run();
      }
      if (!customerId) return JSON.stringify({ error: 'Could not identify customer from invoice. The OCR text may not contain a company name.' });
      const items: any[] = (parsed?.items || []).map((it: any, i: number) => ({ description: it.description || 'Item', quantity: it.quantity || 1, unit_price: it.unit_price || 0, amount: it.amount || ((it.quantity || 1) * (it.unit_price || 0)), sort_order: i }));
      if (items.length === 0 && parsed?.total) {
        items.push({ description: 'Invoice item', quantity: 1, unit_price: parsed.total, amount: parsed.total, sort_order: 0 });
      }
      if (items.length === 0) return JSON.stringify({ error: 'No line items found in invoice' });
      const subtotal = items.reduce((s: number, it: any) => s + it.amount, 0);
      const total = parsed?.total || subtotal;
      const invNumber = parsed?.invoice_number || `INV-${Date.now().toString(36).toUpperCase()}`;
      const existing = await db.prepare('SELECT id FROM invoices WHERE user_id = ? AND invoice_number = ?').bind(userId, invNumber).first();
      if (existing) return JSON.stringify({ error: `Invoice ${invNumber} already exists`, invoice_id: existing.id });
      const invId = `i-${uuidv4().slice(0, 8)}`;
      await db.prepare('INSERT INTO invoices (id, user_id, invoice_number, customer_id, status, issue_date, due_date, subtotal, total, currency, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(invId, userId, invNumber, customerId, 'draft', parsed?.issue_date || new Date().toISOString().split('T')[0], parsed?.due_date || new Date(Date.now() + 30*86400000).toISOString().split('T')[0], subtotal, total, parsed?.currency || 'HKD', parsed?.notes || null).run();
      for (const item of items) {
        await db.prepare('INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount, sort_order) VALUES (?,?,?,?,?,?,?)').bind(`ii-${uuidv4().slice(0, 8)}`, invId, item.description, item.quantity, item.unit_price, item.amount, item.sort_order).run();
      }
      await db.prepare("UPDATE file_records SET category = 'invoice', payment_status = 'unmatched', amount = ?, updated_at = datetime('now') WHERE id = ?").bind(total, fileId).run();
      return JSON.stringify({ success: true, invoice_id: invId, invoice_number: invNumber, customer_name: parsed?.customer_name, items_count: items.length, total, parsed_via_ai: !!parsed });
    }

    // ── Documents ──
    case 'list_documents': {
      let q = 'SELECT id, doc_type, doc_year, file_name, br_number, company_name_ocr, issue_date, expiry_date, status, created_at FROM documents WHERE user_id = ?';
      const params: any[] = [userId];
      if (args?.type) { q += ' AND doc_type = ?'; params.push(args.type); }
      q += ' ORDER BY created_at DESC LIMIT ?'; params.push(limit);
      const rows = await db.prepare(q).bind(...params).all();
      return JSON.stringify(rows.results);
    }
    case 'get_document': {
      const row = await db.prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?').bind(args.id, userId).first();
      if (!row) return JSON.stringify({ error: 'Document not found' });
      return JSON.stringify(row);
    }
    case 'update_document': {
      const fields = ['br_number', 'company_name_ocr', 'issue_date', 'expiry_date', 'doc_year'];
      const sets: string[] = [];
      const params: any[] = [];
      for (const f of fields) {
        if (args[f] !== undefined) { sets.push(`${f} = ?`); params.push(args[f]); }
      }
      if (sets.length === 0) return JSON.stringify({ error: 'No fields to update' });
      sets.push("updated_at = datetime('now')");
      params.push(args.id, userId);
      await db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...params).run();
      return JSON.stringify({ success: true, id: args.id });
    }
    case 'delete_document': {
      await db.prepare('DELETE FROM documents WHERE id = ? AND user_id = ?').bind(args.id, userId).run();
      return JSON.stringify({ success: true, deleted: args.id });
    }

    // ── Dynamic Query (fallback for unmapped data queries) ──
    case 'query_database': {
      let sql = args?.sql || '';
      if (!sql) return JSON.stringify({ error: 'sql is required' });
      // Security: only allow SELECT
      const normalizedSql = sql.trim().toUpperCase();
      if (!normalizedSql.startsWith('SELECT')) {
        return JSON.stringify({ error: 'Only SELECT queries are allowed' });
      }
      // Block dangerous keywords
      const blocked = ['DROP', 'DELETE', 'INSERT', 'UPDATE', 'ALTER', 'CREATE', 'ATTACH', 'PRAGMA'];
      for (const kw of blocked) {
        if (normalizedSql.includes(kw)) {
          return JSON.stringify({ error: `Keyword ${kw} is not allowed` });
        }
      }
      // Only allow tables that have a user_id column (tenant-scoped). Reject any query
      // that references tables without one (e.g. journal_lines, *_items, users, firms,
      // firm_clients) to prevent unscoped cross-tenant reads.
      const userScopedTables = ['customers', 'suppliers', 'products', 'invoices', 'quotations', 'purchase_orders', 'service_orders', 'services', 'service_bookings', 'todos', 'calendar_events', 'journal_entries', 'accounts', 'bank_statements', 'bank_transactions', 'expense_receipts', 'file_records', 'documents', 'chat_sessions', 'chat_messages', 'company_settings', 'domains'];
      const tableRefs = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map(m => m[1].toLowerCase());
      const badTables = tableRefs.filter(t => !userScopedTables.includes(t));
      if (badTables.length > 0) {
        return JSON.stringify({ error: `Query references table(s) that are not tenant-scoped: ${badTables.join(', ')}. Only these tables are allowed (each has user_id): ${userScopedTables.join(', ')}` });
      }
      // Ensure user_id filter — inject if not present
      if (!sql.includes('user_id')) {
        // Try to inject WHERE user_id = ? before LIMIT/ORDER BY/GROUP BY
        const insertBefore = /\b(LIMIT|ORDER|GROUP|HAVING)\b/i.exec(sql);
        if (insertBefore) {
          sql = sql.substring(0, insertBefore.index) + ' WHERE user_id = ? ' + sql.substring(insertBefore.index);
        } else {
          sql += ' WHERE user_id = ?';
        }
        // Shift params: add userId at the position where we injected
        const params = Array.isArray(args?.params) ? [userId, ...args.params] : [userId];
        const rows = await db.prepare(sql).bind(...params).all();
        return JSON.stringify({ rows: rows.results, count: rows.results.length });
      }
      // user_id already in query — replace first ? with userId if params don't include it
      const params = Array.isArray(args?.params) ? args.params : [];
      if (params[0] !== userId) {
        params.unshift(userId);
      }
      try {
        const rows = await db.prepare(sql).bind(...params.slice(0, 20)).all();
        return JSON.stringify({ rows: rows.results, count: rows.results.length });
      } catch (e: any) {
        return JSON.stringify({ error: `SQL error: ${e.message}`, sql });
      }
    }

    case 'list_firms': {
      const rows = await db.prepare('SELECT f.id, f.name, fm.role FROM firms f JOIN firm_members fm ON fm.firm_id = f.id WHERE fm.user_id = ? AND fm.is_active = 1').bind(firmUserId).all();
      return JSON.stringify(rows.results);
    }
    case 'list_client_companies': {
      const clients = await resolveAccessibleClients(db, firmUserId);
      return JSON.stringify({ count: clients.length, clients });
    }
    case 'get_bookkeeping_all_clients': {
      const clients = await resolveAccessibleClients(db, firmUserId);
      if (clients.length === 0) return JSON.stringify({ error: 'No client companies accessible' });
      const startDate = args?.start_date || '2020-01-01';
      const endDate = args?.end_date || '2099-12-31';
      const perClient: any[] = [];
      let combined = { revenue: 0, expenses: 0, net: 0 };
      for (const c of clients) {
        const pnl = await computeClientPnl(db, c.client_user_id, startDate, endDate);
        if (pnl) {
          perClient.push({ client_user_id: c.client_user_id, display_name: c.display_name, ...pnl });
          combined.revenue += pnl.revenue;
          combined.expenses += pnl.expenses;
          combined.net += pnl.net;
        }
      }
      return JSON.stringify({ start_date: startDate, end_date: endDate, per_client: perClient, combined });
    }
    case 'list_staff': {
      const rows = await db.prepare('SELECT u.name, u.email, fm.role, fm.is_active FROM firm_members fm JOIN users u ON u.id = fm.user_id WHERE fm.firm_id IN (SELECT firm_id FROM firm_members WHERE user_id = ? AND is_active = 1) ORDER BY fm.is_active DESC').bind(firmUserId).all();
      return JSON.stringify({ count: rows.results.length, staff: rows.results });
    }
    case 'add_staff_member': {
      const fm = await db.prepare('SELECT firm_id, role FROM firm_members WHERE user_id = ? AND is_active = 1 LIMIT 1').bind(firmUserId).first<{ firm_id: string; role: string }>();
      if (!fm || fm.role !== 'admin') return JSON.stringify({ error: 'Only firm admins can add staff' });
      const { email, password, name, role } = args;
      if (!email) return JSON.stringify({ error: 'email required' });
      let mu = await db.prepare('SELECT id, email, name FROM users WHERE email = ?').bind(email).first<{ id: string; email: string; name: string }>();
      let createdPw: string | null = null;
      if (!mu) {
        const id = 'u-' + require('uuid').v4().slice(0, 8);
        createdPw = password || require('uuid').v4().slice(0, 12);
        const pwHash = await hash(createdPw, 10);
        await db.prepare('INSERT INTO users (id, email, password_hash, name, role) VALUES (?,?,?,?,?)').bind(id, email, pwHash, name || email.split('@')[0], 'user').run();
        mu = { id, email, name: name || email.split('@')[0] };
      } else if (password) {
        const pwHash = await hash(password, 10);
        await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(pwHash, mu.id).run();
        createdPw = password;
      }
      const ex = await db.prepare('SELECT id FROM firm_members WHERE firm_id = ? AND user_id = ?').bind(fm.firm_id, mu.id).first();
      if (ex) return JSON.stringify({ error: 'Already a member' });
      const fmId = 'fm-' + require('uuid').v4().slice(0, 8);
      await db.prepare('INSERT INTO firm_members (id, firm_id, user_id, role) VALUES (?,?,?,?)').bind(fmId, fm.firm_id, mu.id, role || 'staff').run();
      return JSON.stringify({ success: true, firm_id: fm.firm_id, user_id: mu.id, email, name: mu.name, role: role || 'staff', ...(createdPw ? { password: createdPw } : {}) });
    }
    case 'read_code': {
      const p = args?.path; if (!p) return JSON.stringify({ error: 'path required' });
      try {
        const r = await fetch('https://api.github.com/repos/ai-caseylai/opcc-crm/contents/'+encodeURIComponent(p)+'?ref=main', { headers: { Authorization: 'Bearer '+(env.GITHUB_TOKEN||''), 'User-Agent': 'opcc-crm', Accept: 'application/vnd.github.v3+json' } });
        if (!r.ok) return JSON.stringify({ error: 'GitHub '+r.status });
        const d = await r.json() as any;
        const content = d.content ? (()=>{const b=atob(d.content.replace(/\n/g,''));const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return new TextDecoder('utf-8').decode(u);})() : '(no content)';
        return JSON.stringify({ path: p, size: d.size, content });
      } catch(e: any) { return JSON.stringify({ error: e.message }); }
    }
    case 'write_code': {
      const { path: fp, content: fc, message: fm } = args; if (!fp || fc === undefined) return JSON.stringify({ error: 'path and content required' });
      try {
        let sha = '';
        try { const gr = await fetch('https://api.github.com/repos/ai-caseylai/opcc-crm/contents/'+encodeURIComponent(fp)+'?ref=main', { headers: { Authorization: 'Bearer '+(env.GITHUB_TOKEN||''), 'User-Agent': 'opcc-crm', Accept: 'application/vnd.github.v3+json' } }); if (gr.ok) { const gd = await gr.json() as any; sha = gd.sha || ''; } } catch {}
        const body: any = { message: fm || 'Update via AI', content: btoa(fc), branch: 'main' }; if (sha) body.sha = sha;
        const pr = await fetch('https://api.github.com/repos/ai-caseylai/opcc-crm/contents/'+encodeURIComponent(fp), { method: 'PUT', headers: { Authorization: 'Bearer '+(env.GITHUB_TOKEN||''), 'User-Agent': 'opcc-crm', Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!pr.ok) return JSON.stringify({ error: 'GitHub '+pr.status });
        const pd = await pr.json() as any;
        return JSON.stringify({ success: true, path: fp, commit: pd.commit?.sha?.slice(0,7) });
      } catch(e: any) { return JSON.stringify({ error: e.message }); }
    }
    case 'list_project_files': {
      try {
        const r = await fetch('https://api.github.com/repos/ai-caseylai/opcc-crm/contents/'+(args?.path||''), { headers: { Authorization: 'Bearer '+(env.GITHUB_TOKEN||''), 'User-Agent': 'opcc-crm', Accept: 'application/vnd.github.v3+json' } });
        if (!r.ok) return JSON.stringify({ error: 'GitHub '+r.status });
        const d = await r.json() as any[];
        return JSON.stringify(Array.isArray(d) ? d.map(f=>({name:f.name,path:f.path,type:f.type,size:f.size})) : [d]);
      } catch(e: any) { return JSON.stringify({ error: e.message }); }
    }
    case 'git_log': {
      try {
        const r = await fetch('https://api.github.com/repos/ai-caseylai/opcc-crm/commits?per_page='+(args?.count||10), { headers: { Authorization: 'Bearer '+(env.GITHUB_TOKEN||''), 'User-Agent': 'opcc-crm', Accept: 'application/vnd.github.v3+json' } });
        if (!r.ok) return JSON.stringify({ error: 'GitHub '+r.status });
        const d = await r.json() as any[];
        return JSON.stringify(d.map(c=>({sha:c.sha.slice(0,7),message:c.commit.message.split('\n')[0],date:c.commit.author.date})));
      } catch(e: any) { return JSON.stringify({ error: e.message }); }
    }
    case 'deploy_frontend': {
      if (!args?.confirm) return JSON.stringify({ error: 'Confirm required' });
      try {
        const r = await fetch('https://api.cloudflare.com/client/v4/accounts/'+env.CF_ACCOUNT_ID+'/pages/projects/oppc-crm/deployments', { method: 'POST', headers: { Authorization: 'Bearer '+env.CF_API_TOKEN, 'Content-Type': 'application/json' } });
        const d = await r.json() as any;
        return JSON.stringify(r.ok?{success:true,id:d.result?.id}:{error:'Deploy failed'});
      } catch(e: any) { return JSON.stringify({ error: e.message }); }
    }

    default:
      return '{}';
  }
}

async function callQwen(apiKey: string, messages: any[], tools?: any[], forceTool?: boolean): Promise<any> {
  const body: any = { model: 'qwen3.7-plus', messages, max_tokens: 4000, temperature: 0.1, enable_thinking: false };
  if (tools && tools.length > 0) { body.tools = tools; body.tool_choice = forceTool ? 'required' : 'auto'; }
  const resp = await fetch('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) { const err = await resp.text(); throw new Error(`Qwen API error: ${resp.status} ${err}`); }
  return resp.json();
}

async function callDeepSeek(apiKey: string, messages: any[], tools?: any[], forceTool?: boolean): Promise<any> {
  const body: any = { model: 'deepseek-chat', messages, max_tokens: 4000, temperature: 0.1 };
  if (tools && tools.length > 0) { body.tools = tools; body.tool_choice = forceTool ? 'required' : 'auto'; }
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) { const err = await resp.text(); throw new Error(`DeepSeek API error: ${resp.status} ${err}`); }
  return resp.json();
}

// Streaming version — returns a ReadableStream of SSE chunks for the final text response
async function callDeepSeekStream(apiKey: string, messages: any[]): Promise<ReadableStream> {
  const body = JSON.stringify({
    model: 'deepseek-v4-pro',
    messages,
    max_tokens: 4000,
    temperature: 0.1,
    stream: true,
  });

  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`DeepSeek API error: ${resp.status} ${err}`);
  }

  // Transform DeepSeek SSE → simple text SSE
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      const text = decoder.decode(value, { stream: true });
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') { controller.close(); return; }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) controller.enqueue(encoder.encode(content));
          } catch {}
        }
      }
    },
  });
}

// ── Chat Sessions ──

// List sessions
chat.get('/sessions', async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB.prepare(
    'SELECT id, title, created_at, updated_at FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50'
  ).bind(user.id).all();
  return c.json({ data: rows.results });
});

// Get session with messages
chat.get('/sessions/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const session = await c.env.DB.prepare(
    'SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!session) return c.json({ error: 'Session not found' }, 404);
  const msgs = await c.env.DB.prepare(
    'SELECT id, role, content, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC'
  ).bind(id).all();
  return c.json({ ...session, messages: msgs.results });
});

// Delete session
chat.delete('/sessions/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?)').bind(id, user.id).run();
  await c.env.DB.prepare('DELETE FROM chat_sessions WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  return c.json({ success: true });
});

// Delete a single message
chat.delete('/messages/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const msg = await c.env.DB.prepare('SELECT session_id FROM chat_messages WHERE id = ?').bind(id).first<{ session_id: string }>();
  if (!msg) return c.json({ error: 'Message not found' }, 404);
  // Verify session belongs to user
  const session = await c.env.DB.prepare('SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?').bind(msg.session_id, user.id).first();
  if (!session) return c.json({ error: 'Unauthorized' }, 403);
  await c.env.DB.prepare('DELETE FROM chat_messages WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// ── Chat (send message) ──

chat.post('/', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const { message, history, file, session_id, stream: doStream, lang: preferredLang } = body;

  if (!message && !file) return c.json({ reply: 'Message required' });

  const qwenKey = c.env.QWEN_API_KEY as string | undefined;
  const dsKey = c.env.DEEPSEEK_API_KEY;
  const apiKey = qwenKey || dsKey;
  if (!apiKey) return c.json({ reply: 'No LLM API key configured' });
  const useQwen = !!qwenKey;
  const callLLM = (msgs: any[], tools?: any[], force?: boolean) =>
    useQwen ? callQwen(apiKey, msgs, tools, force) : callDeepSeek(apiKey, msgs, tools, force);

  const db = c.env.DB;

  // Get or create session
  let sid = session_id || '';
  if (sid) {
    const existing = await db.prepare('SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?').bind(sid, user.id).first();
    if (!existing) sid = '';
  }
  if (!sid) {
    sid = `cs-${uuidv4().slice(0, 8)}`;
    await db.prepare('INSERT INTO chat_sessions (id, user_id, title) VALUES (?, ?, ?)').bind(sid, user.id, '').run();
  }

  // Pre-process file attachments into the message
  let userMessage = message || '';
  if (file && file.name) {
    const ext = (file.name as string).toLowerCase();
    const isCSV = ext.endsWith('.csv') || ext.endsWith('.txt');
    const isExcel = ext.endsWith('.xlsx') || ext.endsWith('.xls');
    const isPDF = ext.endsWith('.pdf');

    if (isCSV && file.data) {
      try {
        const text = atob(file.data);
        const lines = text.split('\n').slice(0, 30);
        userMessage = `[User uploaded CSV file: ${file.name}]\nContent preview (first ${lines.length} lines):\n${lines.join('\n')}\n\n${userMessage || 'Please analyze this data.'}`;
      } catch {
        userMessage = `[User uploaded file: ${file.name}]\n${userMessage || 'Please help with this file.'}`;
      }
    } else if (isExcel) {
      userMessage = `[User uploaded Excel file: ${file.name}]\nThis is an Excel file. Suggest the user to use the Import feature at /import to import this data into the CRM. ${userMessage || 'Please help with this file.'}`;
    } else if (isPDF) {
      userMessage = `[User uploaded PDF file: ${file.name}]\nThis is a PDF document. ${userMessage || 'Please help with this document.'}`;
    } else {
      userMessage = `[User uploaded file: ${file.name}]\n${userMessage || 'Please help with this file.'}`;
    }
  }

  if (!userMessage) return c.json({ reply: 'Message required' });

  // Detect the user's language (message text, with the UI language as hint)
  const lang = detectLang(userMessage, preferredLang);
  const t = UI_STRINGS[lang];

  // Save user message
  const userMsgId = `cm-${uuidv4().slice(0, 8)}`;
  await db.prepare('INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').bind(userMsgId, sid, 'user', userMessage).run();

  // Auto-title from first message
  const existingTitle = await db.prepare('SELECT title FROM chat_sessions WHERE id = ?').bind(sid).first<{ title: string }>();
  if (existingTitle && !existingTitle.title) {
    const title = userMessage.slice(0, 60).replace(/\n/g, ' ');
    await db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').bind(title, sid).run();
  }

  try {
    const today = new Date().toISOString().split('T')[0];

    // Resolve active client company context for scoping
    let companyContext = '';
    const activeClientId = c.get('client_user_id');
    if (activeClientId) {
      const client = await db.prepare(
        `SELECT fc.display_name, u.company_name, u.name
         FROM users u
         LEFT JOIN firm_clients fc ON fc.client_user_id = u.id AND fc.firm_id = ?
         WHERE u.id = ?`
      ).bind(user.firm_id || '', activeClientId).first<any>();
      const companyName = client?.display_name || client?.company_name || client?.name || activeClientId;
      companyContext = `\n\nCURRENT CLIENT COMPANY: ${companyName}\nYou are assisting with ${companyName}'s data. All tools are scoped to this client company. Report ONLY ${companyName}'s data unless the user explicitly asks about ALL their clients.`;
    } else if (user.firm_id) {
      companyContext = `\n\nCURRENT CLIENT COMPANY: none selected.\nYou are in the firm staff user's own context. For client company data, remind the user to select a client company first. Do not fabricate or guess client data.`;
    } else {
      companyContext = `\n\nCURRENT CLIENT COMPANY: your own company.\nAll tools are scoped to your own data. Report only your own company's data unless the user explicitly asks about ALL their companies/clients.`;
    }

    const systemPrompt = SYSTEM_PROMPT + `\n\nCurrent date: ${today}\n\nLANGUAGE: The user's latest message is written in ${t.langName}. ALWAYS reply in that language (English, 繁體中文, or 简体中文). If the user switches language, switch with them.` + companyContext;
    const messages: any[] = [{ role: 'system', content: systemPrompt }];
    if (Array.isArray(history)) {
      for (const msg of history.slice(-8)) {
        if (msg.role && msg.content) messages.push({ role: msg.role, content: msg.content });
      }
    }
    messages.push({ role: 'user', content: userMessage });

    const response1 = await callLLM(messages, TOOLS, true);
    const choice = response1.choices?.[0];
    const toolCalls = choice?.message?.tool_calls;

    let reply: string;

    if (toolCalls && toolCalls.length > 0) {
      messages.push(choice.message);
      const toolLog: string[] = [];
      for (const tc of toolCalls) {
        const fnName = tc.function?.name;
        let fnArgs: any = {};
        try { fnArgs = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        const startTime = Date.now();
        const result = fnName ? await executeTool(fnName, db, tenantId, fnArgs, c.env, user.id) : '{}';
        const elapsed = Date.now() - startTime;
        toolLog.push(`[${fnName}] ${elapsed}ms args=${JSON.stringify(fnArgs).slice(0, 200)} result=${String(result).slice(0, 100)}`);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }

      // Check if any result is a raw display (bypass LLM to prevent hallucination)
      const rawDisplay = messages.find((m: any) => {
        if (m.role !== 'tool') return false;
        try { const p = JSON.parse(m.content); return !!p.display; } catch { return false; }
      });

      if (rawDisplay) {
        const parsed = JSON.parse(rawDisplay.content);
        reply = parsed.display;
      } else {
        const response2 = await callLLM(messages);
        reply = response2.choices?.[0]?.message?.content || t.cannotProcess;
      }

      // Log tool operations to database
      try {
        const logId = `tl-${uuidv4().slice(0, 8)}`;
        await db.prepare('INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
          .bind(logId, sid, 'tool_log', toolLog.join('\n')).run();
      } catch {}
    } else {
      reply = choice?.message?.content || t.cannotProcess;

      // Handle DSML or XML-like tool calls in text (fallback for models without structured tool calling)
      // Broad match: any tag containing "DSML" or "tool_call" or "invoke"
      const tagPattern = /<[^>]*DSML[^>]*>|<[^>]*tool_call[^>]*>|<[^>]*invoke\s+name=/i;
      const hasToolTags = tagPattern.test(reply);

      if (hasToolTags) {
        const stripXml = (text: string) => text
          .replace(/<[^>]*DSML[^>]*>[\s\S]*?(<\/[^>]*DSML[^>]*>)?/gi, '')
          .replace(/<[^>]*tool_call[^>]*>[\s\S]*?(<\/[^>]*tool_call[^>]*>)?/gi, '')
          .replace(/<[^>]*invoke[^>]*>[\s\S]*?<\/[^>]*invoke>/gi, '')
          .replace(/<[^>]*parameter[^>]*>[\s\S]*?<\/[^>]*parameter>/gi, '')
          .trim();

        const cleanReply = stripXml(reply);

        // Map common DeepSeek-invented function names to actual function names
        const fnNameMap: Record<string, string> = {
          get_account_transactions: 'get_bookkeeping_transactions',
          get_journal_entries: 'get_bookkeeping_transactions',
          get_journal_entry: 'get_bookkeeping_transactions',
          get_transactions: 'get_bookkeeping_transactions',
          list_journal_entries: 'get_bookkeeping_transactions',
          modify_journal_entry: 'update_journal_entry',
          edit_journal_entry: 'update_journal_entry',
          create_transaction: 'create_bookkeeping_transaction',
          create_journal_entry: 'create_bookkeeping_transaction',
          remove_journal_entry: 'delete_journal_entry',
          get_bank_statement_transactions: 'get_bank_statement_raw',
          get_bank_transactions: 'get_bank_statement_raw',
          view_bank_statement: 'get_bank_statement_raw',
          show_bank_statement: 'get_bank_statement_raw',
          list_bank_transactions: 'list_bank_statements',
          get_expenses: 'list_expense_receipts',
          list_expenses: 'list_expense_receipts',
          get_receipts: 'list_expense_receipts',
          get_files: 'list_files',
          search_files: 'list_files',
          get_documents: 'list_documents',
          search_documents: 'list_documents',
          run_query: 'query_database',
          execute_query: 'query_database',
          sql_query: 'query_database',
          query: 'query_database',
          raw_query: 'query_database',
          list_firm: 'list_firms',
          get_firm: 'list_firms',
          add_staff: 'add_staff_member',
          create_staff: 'add_staff_member',
          list_employees: 'list_staff',
          staff_count: 'list_staff',
          get_staff: 'list_staff',
          search_data: 'query_database',
          find_data: 'query_database',
          get_data: 'query_database',
        };

        const paramMap: Record<string, Record<string, string>> = {
          get_bank_statement: { statement_id: 'id' },
          get_bank_statement_raw: { statement_id: 'id' },
          get_bank_statement_transactions: { statement_id: 'id' },
          get_bank_transactions: { statement_id: 'id' },
          get_bank_statement_summary: { statement_id: 'id' },
          get_bookkeeping_transactions: { year: '__skip__', month: '__skip__', start_date: 'start_date', end_date: 'end_date' },
          update_journal_entry: { entry_id: 'id', lines: 'entries', journal_id: 'id' },
          delete_journal_entry: { entry_id: 'id', journal_id: 'id' },
          create_bookkeeping_transaction: { lines: 'entries' },
        };

        // Parse and execute all invoke blocks
        const executeDsmlInvokes = async (text: string): Promise<{ results: string[]; errors: string[]; log: string[] }> => {
          const results: string[] = [];
          const errors: string[] = [];
          const log: string[] = [];
          const invokePattern = /<[^>]*invoke\s+name="(\w+)"[^>]*>([\s\S]*?)<\/[^>]*invoke>/gi;
          let im;
          while ((im = invokePattern.exec(text)) !== null) {
            const rawFnName = im[1];
            const fnName = fnNameMap[rawFnName] || rawFnName;
            log.push(`Function: ${rawFnName} → ${fnName}`);
            const paramPattern = /<[^>]*parameter\s+name="(\w+)"[^>]*>([\s\S]*?)<\/[^>]*parameter>/gi;
            const fnArgs: Record<string, any> = {};
            let pm;
            while ((pm = paramPattern.exec(im[2])) !== null) {
              const rawKey = pm[1];
              let val: any = pm[2].trim();
              if ((val.startsWith('[') && val.endsWith(']')) || (val.startsWith('{') && val.endsWith('}'))) {
                try { val = JSON.parse(val); } catch {}
              }
              const pMap = paramMap[fnName] || {};
              const mappedKey = pMap[rawKey];
              if (mappedKey === '__skip__') continue;
              fnArgs[mappedKey || rawKey] = val;
              log.push(`  Param: ${rawKey}${mappedKey && mappedKey !== rawKey ? ` → ${mappedKey}` : ''} = ${typeof val === 'object' ? JSON.stringify(val) : val}`);
            }
            if (fnArgs.year && fnArgs.month) {
              const y = fnArgs.year;
              const m = fnArgs.month.padStart(2, '0');
              fnArgs.start_date = `${y}-${m}-01`;
              fnArgs.end_date = `${y}-${m}-${new Date(parseInt(y), parseInt(m), 0).getDate()}`;
              delete fnArgs.year;
              delete fnArgs.month;
              log.push(`  Converted year+month → start_date=${fnArgs.start_date}, end_date=${fnArgs.end_date}`);
            }
            try {
              const result = await executeTool(fnName, db, tenantId, fnArgs, c.env, user.id);
              results.push(`${fnName}: ${result}`);
              log.push(`  Result: OK`);
            } catch (e: any) {
              const errMsg = e.message || 'unknown';
              errors.push(`${fnName}: Error - ${errMsg}`);
              log.push(`  Error: ${errMsg}`);
            }
          }
          return { results, errors, log };
        };

        // Phase 1: Initial execution attempt
        const phase1 = await executeDsmlInvokes(reply);
        let allResults = [...phase1.results];
        let allErrors = [...phase1.errors];
        const fullLog = [`=== DSML Auto-Repair Log ===`, `Phase 1 (initial):`, ...phase1.log];

        // If a raw display function was called, return its output directly (bypass LLM hallucination)
        let bypassLlm = false;
        const rawDisplayResult = allResults.find(r => r.startsWith('get_bank_statement_raw:'));
        if (rawDisplayResult) {
          try {
            const parsed = JSON.parse(rawDisplayResult.replace('get_bank_statement_raw: ', ''));
            if (parsed.display) {
              reply = (cleanReply || t.bankStatementHeader) + parsed.display;
              bypassLlm = true;
              fullLog.push('Bypass LLM: raw display returned directly');
            }
          } catch {}
        }

        if (!bypassLlm) {
          // Phase 2: If there were errors, re-prompt DeepSeek with available functions + error info
          if (allErrors.length > 0 || (allResults.length === 0 && allErrors.length === 0)) {
          const availableFns = TOOLS.map((t: any) => t.function?.name).filter(Boolean).join(', ');
          const retryPrompt = allErrors.length > 0
            ? `The previous tool calls had errors:\n${allErrors.join('\n')}\n\nAvailable functions: ${availableFns}\n\nPlease retry using ONLY the exact function names above with correct parameters. Execute the functions strictly through the structured tool-calling interface. Never print DSML tags or tool invocation code into your response text. Reply in ${t.langName}.`
            : `No tool calls were made in the previous response. The user's question was: "${userMessage}"\n\nAvailable functions: ${availableFns}\n\nExecute the appropriate function(s) strictly through the structured tool-calling interface. Never print DSML tags or tool invocation code into your response text. Reply in ${t.langName}.`;

          fullLog.push(`Phase 2 (retry prompt):`, `  Errors: ${allErrors.length}, Results: ${allResults.length}`, `  Re-prompting DeepSeek...`);

          try {
            const retryMessages = [...messages];
            retryMessages.push({ role: 'assistant', content: cleanReply || t.processing });
            retryMessages.push({ role: 'user', content: retryPrompt });
            const retryResp = await callLLM(retryMessages, TOOLS, true);
            const retryMsg = retryResp.choices?.[0]?.message;
            const retryToolCalls = retryMsg?.tool_calls;
            const retryText = retryMsg?.content || '';

            // Preferred: execute structured tool calls from the retry (strict tool interface)
            if (retryToolCalls && retryToolCalls.length > 0) {
              retryMessages.push(retryMsg);
              const phase2Results: string[] = [];
              for (const tc of retryToolCalls) {
                const fnName = tc.function?.name;
                let fnArgs: any = {};
                try { fnArgs = JSON.parse(tc.function?.arguments || '{}'); } catch {}
                const result = fnName ? await executeTool(fnName, db, tenantId, fnArgs, c.env, user.id) : '{}';
                phase2Results.push(`${fnName}: ${result}`);
                retryMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
                fullLog.push(`Phase 2 (structured tool call): ${fnName} executed`);
              }
              allResults.push(...phase2Results);

              // If a raw display function was called, return its output directly (bypass LLM hallucination)
              const retryRawDisplay = retryMessages.find((m: any) => {
                if (m.role !== 'tool') return false;
                try { const p = JSON.parse(m.content); return !!p.display; } catch { return false; }
              });
              if (retryRawDisplay) {
                reply = JSON.parse(retryRawDisplay.content).display;
                fullLog.push('Phase 2: raw display returned directly (bypass LLM)');
              } else {
                const finalResp = await callLLM(retryMessages);
                reply = finalResp.choices?.[0]?.message?.content || t.done;
                fullLog.push(`Phase 2: structured tool calls succeeded; final answer generated (${reply.length} chars)`);
              }
            }
            // Legacy fallback: model still emitted DSML/XML text despite the tool interface
            else if (/<[^>]*invoke\s+name=/i.test(retryText)) {
              const phase2 = await executeDsmlInvokes(retryText);
              fullLog.push(`Phase 2 (execution):`, ...phase2.log);
              allResults.push(...phase2.results);
              allErrors.push(...phase2.errors);

              // Phase 3: If retry also had DSML, get final text answer
              if (allResults.length > 0 || phase2.results.length > 0) {
                const combinedResults = [...allResults, ...phase2.results];
                messages.push({ role: 'assistant', content: stripXml(retryText) || t.processing });
                messages.push({ role: 'user', content: `[Tool results]\n${combinedResults.join('\n')}\n\nPresent this data EXACTLY as shown above. Copy the table verbatim into your response. Do NOT summarize, modify, or invent any data. Reply in ${t.langName}.` });
                const finalResp = await callLLM(messages);
                reply = finalResp.choices?.[0]?.message?.content || t.done;
                fullLog.push(`Phase 3: Final answer generated (${reply.length} chars)`);
              } else {
                // Retry tools also failed — ask for plain text answer
                messages.push({ role: 'assistant', content: 'Tool calls failed.' });
                messages.push({ role: 'user', content: `All tool call attempts failed. Please answer the question directly in plain text. Reply in ${t.langName}.` });
                const textResp = await callLLM(messages);
                reply = textResp.choices?.[0]?.message?.content || cleanReply || t.cannotProcess;
                fullLog.push(`Phase 3: Fallback to plain text answer`);
              }
            } else {
              // Retry gave plain text directly
              reply = retryText || cleanReply || t.done;
              fullLog.push(`Phase 2: DeepSeek responded in plain text (${reply.length} chars)`);
            }
          } catch (retryErr: any) {
            fullLog.push(`Phase 2 error: ${retryErr.message}`);
            reply = cleanReply || t.error;
          }
        } else {
          // Phase 1 succeeded — get final answer from DeepSeek
          messages.push({ role: 'assistant', content: cleanReply || t.processing });
          messages.push({ role: 'user', content: `[Tool results]\n${allResults.join('\n')}\n\nPresent this data EXACTLY as shown. Copy the formatted table verbatim. Do NOT summarize, modify, or invent anything. Reply in ${t.langName}.` });
          const resp2 = await callLLM(messages);
          reply = resp2.choices?.[0]?.message?.content || cleanReply || t.done;
          fullLog.push(`Phase 1 success: Final answer generated (${reply.length} chars)`);
        }

        } // end if (!bypassLlm)

        // Final safety: strip any remaining XML
        reply = stripXml(reply) || t.done;
        fullLog.push(`=== End Log ===`);

        // Save repair log to database
        try {
          const logId = `dl-${uuidv4().slice(0, 8)}`;
          await db.prepare(
            'INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)'
          ).bind(logId, sid, 'system', fullLog.join('\n')).run();
        } catch {}
      }
    }

    // 1. Match ANY tag structure, including Unicode symbols like ｜ or special tokens
    const RAW_TAG_REGEX = /<[^>\n]+>/g;
    // Paired tags: remove the block INCLUDING its content (e.g. <invoke>{"x":1}</invoke>)
    const RAW_TAG_PAIR_REGEX = /<[^>\n]+>[\s\S]*?<\/[^>\n]+>/g;

    // 2. Strip all tags (and paired tag content) before saving — fall back if text becomes empty
    if (RAW_TAG_REGEX.test(reply)) {
      reply = reply.replace(RAW_TAG_PAIR_REGEX, '').replace(RAW_TAG_REGEX, '').trim() || t.askAgain;
    }

    // Save assistant reply
    const asstMsgId = `cm-${uuidv4().slice(0, 8)}`;
    await db.prepare('INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').bind(asstMsgId, sid, 'assistant', reply).run();
    await db.prepare("UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?").bind(sid).run();

    // Return reply — stream if needed
    if (doStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(reply)); controller.close(); },
      });
      return new Response(stream, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Session-Id': sid },
      });
    }

    return c.json({ reply, session_id: sid });
  } catch (e: any) {
    console.error('Chat error:', e?.message, e?.stack);
    return c.json({ reply: `${t.error} (${e.message || 'unknown'})`, error_detail: e?.message || 'unknown' }, 500);
  }
});

export { chat as chatRoutes };
