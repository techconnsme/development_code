# OPCC 技術棧詳細說明文件

> **OPCC — One Person Company Club CRM**
> 最後更新：2026-05-07
> 版本：2.0.0

---

## 目錄

1. [專案概述](#1-專案概述)
2. [系統架構](#2-系統架構)
3. [後端技術棧](#3-後端技術棧)
4. [前端技術棧](#4-前端技術棧)
5. [資料庫設計](#5-資料庫設計)
6. [API 端點清單](#6-api-端點清單)
7. [認證與授權](#7-認證與授權)
8. [外部整合](#8-外部整合)
9. [部署架構](#9-部署架構)
10. [開發環境設定](#10-開發環境設定)
11. [WhatsApp 橋接架構](#11-whatsapp-橋接架構)
12. [AI 整合方案](#12-ai-整合方案)
13. [成本分析](#13-成本分析)
14. [未來規劃](#14-未來規劃)

---

## 1. 專案概述

### 什麼是 OPCC？

OPCC 是為香港一人公司（One Person Company）俱樂部會員設計的多用戶 CRM 系統，提供客戶管理、報價、發票、記帳等一站式業務管理功能。

### 核心設計原則

- **極低成本**：月費目標 $5 USD 以內
- **零維護**：全託管在 Cloudflare，無需管理伺服器
- **香港優先**：HKD 貨幣、中文介面、FPS 收款
- **AI 就緒**：預留 AI Agent 和 LLM 整合接口
- **WhatsApp 優先**：支援 WhatsApp 作為主要客戶通訊管道

### 技術指標

| 指標 | 數值 |
|---|---|
| 後端框架 | Hono v4.6 |
| 前端框架 | React 18 |
| 資料庫 | Cloudflare D1 (SQLite) |
| 部署平台 | Cloudflare Workers + Pages |
| 全球節點 | 300+ 邊緣節點 |
| 冷啟動時間 | < 5ms |
| API 回應延遲 | < 50ms（同區域） |
| 語言 | TypeScript（全端） |
| 月費 | $5 USD（Workers Paid） |

---

## 2. 系統架構

```
┌─────────────────────────────────────────────────────────────┐
│                        使用者端                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ WhatsApp  │  │ Telegram  │  │  瀏覽器   │  │ WorkBuddy│   │
│  └─────┬────┘  └─────┬────┘  └─────┬────┘  └─────┬────┘   │
└────────┼─────────────┼─────────────┼─────────────┼─────────┘
         │             │             │             │
         ▼             ▼             ▼             ▼
┌─────────────┐  ┌───────────┐  ┌──────────────────────────┐
│ QClaw       │  │ Webhook   │  │    Cloudflare Pages      │
│ (Tencent)   │  │ (直連)    │  │    (React SPA)           │
│ $0-25 一次性 │  │           │  │    免費                   │
└──────┬──────┘  └─────┬─────┘  └───────────┬──────────────┘
       │               │                     │
       │  HTTP Webhook  │                     │ fetch()
       ▼               ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│                  Cloudflare Workers (Hono)                   │
│                       $5 USD/月                              │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐          │
│  │ Auth    │ │ CRM     │ │ 記帳    │ │ PDF     │          │
│  │ JWT     │ │ CRUD    │ │ 雙式    │ │ 生成    │          │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘          │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐          │
│  │ WorkBuddy│ │ Audit  │ │ Import  │ │ WhatsApp│          │
│  │ API     │ │ Log     │ │ CSV     │ │ Webhook │          │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘          │
│                          │                                   │
│         ┌────────────────┼────────────────┐                 │
│         ▼                ▼                ▼                 │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐              │
│  │ D1 DB    │    │ KV Store │    │ R2 Store │              │
│  │ SQLite   │    │ 快取/會話│    │ 檔案儲存 │              │
│  └──────────┘    └──────────┘    └──────────┘              │
└─────────────────────────────────────────────────────────────┘
         │                │                │
         ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────┐
│                      外部 API 服務                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ DeepSeek │  │ Stripe HK│  │ Google   │  │ Resend   │   │
│  │ V4 API   │  │ 收款     │  │ Calendar │  │ Email    │   │
│  │ AI 對話  │  │ 訂閱     │  │ 日曆     │  │ 通知     │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 後端技術棧

### 3.1 核心框架

| 技術 | 版本 | 用途 |
|---|---|---|
| **Hono** | ^4.6.14 | Web 框架（路由、中介軟體、Context） |
| **Cloudflare Workers** | — | Serverless 運行環境 |
| **TypeScript** | ^5.7.3 | 型別安全的 JavaScript |

### 3.2 後端依賴

| 套件 | 版本 | 用途 |
|---|---|---|
| `hono` | ^4.6.14 | 輕量 Web 框架 |
| `@hono/zod-validator` | ^0.4.2 | 請求驗證（Zod 整合） |
| `zod` | ^3.24.1 | Schema 驗證 |
| `jsonwebtoken` | ^9.0.2 | JWT Token 簽發/驗證 |
| `bcryptjs` | ^2.4.3 | 密碼雜湊 |
| `uuid` | ^11.0.5 | UUID 生成 |

### 3.3 開發依賴

| 套件 | 版本 | 用途 |
|---|---|---|
| `@cloudflare/workers-types` | ^4.20250109.0 | Workers 型別定義 |
| `wrangler` | ^3.99.0 | Cloudflare CLI 部署工具 |

### 3.4 Wrangler 設定 (wrangler.toml)

```toml
name = "opcc-crm-api"
main = "src/index.ts"
compatibility_date = "2025-01-13"
compatibility_flags = ["nodejs_compat"]
account_id = "YOUR_CLOUDFLARE_ACCOUNT_ID"

[[d1_databases]]
binding = "DB"
database_name = "opcc-crm-db"
database_id = "218544bf-f765-40ae-b90d-2915033b1e67"

[[kv_namespaces]]
binding = "KV"
id = "6dfb8a74f3e64c23ad587c837f73bbb4"

[env.production]
vars = { ENVIRONMENT = "production" }
```

### 3.5 Cloudflare 綁定

| 綁定 | 類型 | 用途 |
|---|---|---|
| `DB` | D1 Database | 主要資料庫（SQLite） |
| `KV` | KV Namespace | 快取、會話、臨時資料 |
| — | R2 Bucket（規劃中） | 檔案儲存（發票附件、Logo） |

### 3.6 後端目錄結構

```
api/src/
├── index.ts                 # Hono App 入口（掛載所有路由）
├── types.ts                 # TypeScript 型別定義
├── middleware/
│   └── auth.ts              # JWT 認證中介軟體
├── db/
│   ├── schema.sql           # 資料庫 Schema（DDL）
│   └── seed.sql             # 初始資料（管理員帳號、預設會計科目）
└── routes/
    ├── auth.ts              # 認證（登入/註冊/当前用戶）
    ├── customers.ts         # 客戶 CRUD
    ├── suppliers.ts         # 供應商 CRUD
    ├── products.ts          # 產品/服務 CRUD
    ├── invoices.ts          # 發票管理
    ├── quotations.ts        # 報價單管理
    ├── bookkeeping.ts       # 記帳（複式簿記）
    ├── audit.ts             # 稽核日誌
    ├── company.ts           # 公司設定
    ├── pdf.ts               # PDF 生成
    ├── import.ts            # 資料匯入
    └── workbuddy.ts         # WorkBuddy API 整合
```

### 3.7 Hono 路由器選擇

預設使用 **SmartRouter**（Hono 預設），結合 RegExpRouter 提供最快的路由匹配。

---

## 4. 前端技術棧

### 4.1 核心框架

| 技術 | 版本 | 用途 |
|---|---|---|
| **React** | ^18.3.1 | UI 元件庫 |
| **Vite** | ^6.0.6 | 建置工具 + 開發伺服器 |
| **TypeScript** | ^5.7.3 | 型別安全 |

### 4.2 前端依賴

#### 路由與狀態

| 套件 | 版本 | 用途 |
|---|---|---|
| `react-router-dom` | ^6.28.0 | 客戶端路由 |
| `@tanstack/react-query` | ^5.62.7 | 伺服器狀態管理（API 快取） |

#### UI 元件

| 套件 | 版本 | 用途 |
|---|---|---|
| `@radix-ui/react-dialog` | ^1.1.4 | 對話框 |
| `@radix-ui/react-dropdown-menu` | ^2.1.4 | 下拉選單 |
| `@radix-ui/react-select` | ^2.1.4 | 選擇器 |
| `@radix-ui/react-tabs` | ^1.1.2 | 標籤頁 |
| `@radix-ui/react-toast` | ^1.2.4 | 提示通知 |
| `@radix-ui/react-label` | ^2.1.1 | 表單標籤 |
| `@radix-ui/react-slot` | ^1.1.1 | Slot 元件 |
| `lucide-react` | ^0.468.0 | 圖示庫 |
| `class-variance-authority` | ^0.7.1 | CSS 變體管理 |

#### 樣式與工具

| 套件 | 版本 | 用途 |
|---|---|---|
| `tailwindcss` | ^3.4.17 | Utility-first CSS |
| `tailwind-merge` | ^2.6.0 | Tailwind class 合併 |
| `clsx` | ^2.1.1 | 條件式 class |
| `recharts` | ^2.15.0 | 圖表視覺化 |
| `date-fns` | ^4.1.0 | 日期處理 |

### 4.3 前端目錄結構

```
frontend/src/
├── App.tsx                  # 路由定義
├── main.tsx                 # 應用入口
├── index.css                # 全域樣式 + Tailwind
├── components/
│   └── Layout.tsx           # 主佈局（側邊欄 + 導航）
├── contexts/
│   └── AuthContext.tsx       # 認證狀態管理（React Context）
├── lib/
│   ├── api.ts               # API 客戶端（fetch 封裝）
│   └── utils.ts             # 工具函式（cn, formatDate 等）
└── pages/
    ├── Login.tsx             # 登入
    ├── Register.tsx          # 註冊
    ├── Dashboard.tsx         # 儀表板（統計圖表）
    ├── Customers.tsx         # 客戶管理
    ├── Suppliers.tsx         # 供應商管理
    ├── Products.tsx          # 產品管理
    ├── Invoices.tsx          # 發票管理
    ├── Quotations.tsx        # 報價管理
    ├── Bookkeeping.tsx       # 記帳模組
    ├── ImportData.tsx        # 資料匯入
    └── Settings.tsx          # 系統設定
```

### 4.4 Vite 設定

```typescript
// vite.config.ts
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': '/src' }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787'  // 代理到 Workers 本地開發
    }
  }
})
```

### 4.5 Tailwind 設定

- 自訂色彩系統（CSS Variables）
- 擴展圓角主題
- 內容掃描路徑：`src/**/*.{js,ts,jsx,tsx}`

---

## 5. 資料庫設計

### 5.1 資料庫引擎

- **Cloudflare D1** — 基於 SQLite 的無伺服器資料庫
- 跑在 Cloudflare 邊緣節點，自動複製
- 支援 SQL 完整語法（SQLite 相容）

### 5.2 資料表概覽

| 資料表 | 用途 | 主要欄位 |
|---|---|---|
| `users` | 使用者帳號 | id, email, name, role, password_hash |
| `customers` | 客戶資料 | id, name, phone, email, address, tax_id |
| `suppliers` | 供應商資料 | id, name, phone, email, payment_terms |
| `products` | 產品/服務 | id, name, sku, type, price, unit |
| `invoices` | 發票 | id, number, customer_id, status, total, due_date |
| `invoice_items` | 發票明細 | id, invoice_id, product_id, qty, unit_price |
| `quotations` | 報價單 | id, number, customer_id, status, valid_until |
| `quotation_items` | 報價明細 | id, quotation_id, product_id, qty, unit_price |
| `journal_entries` | 日記帳分錄 | id, date, description, entries |
| `accounts` | 會計科目 | id, code, name, type, category |
| `audit_logs` | 稽核日誌 | id, user_id, action, entity, changes, timestamp |
| `api_tokens` | API Token | id, user_id, token, name, permissions |
| `company_settings` | 公司設定 | id, name, address, logo, tax_id |

### 5.3 發票狀態流

```
draft → sent → paid
  ↓       ↓
cancelled  overdue
```

### 5.4 報價單狀態流

```
draft → sent → accepted → converted (→ invoice)
  ↓       ↓
expired  cancelled
```

### 5.5 會計科目類型

| 類型 | 範例 |
|---|---|
| 資產（Asset） | 現金、應收帳款、銀行存款 |
| 負債（Liability） | 應付帳款、稅務負債 |
| 權益（Equity） | 股本、保留盈餘 |
| 收入（Revenue） | 銷售收入、服務收入 |
| 支出（Expense） | 辦公費用、租金、薪金 |

---

## 6. API 端點清單

### Base URL

- 開發：`http://localhost:8787/api`
- 生產：`https://opcc-crm.techforliving.net/api`

### 6.1 認證 (`/api/auth`)

| 方法 | 路徑 | 說明 | 認證 |
|---|---|---|---|
| `POST` | `/auth/register` | 註冊新用戶 | 否 |
| `POST` | `/auth/login` | 登入（回傳 JWT） | 否 |
| `GET` | `/auth/me` | 取得當前用戶資料 | 是 |

### 6.2 客戶 (`/api/customers`)

| 方法 | 路徑 | 說明 | 認證 |
|---|---|---|---|
| `GET` | `/customers` | 列表（搜尋/分頁） | 是 |
| `POST` | `/customers` | 新增客戶 | 是 |
| `GET` | `/customers/:id` | 客戶詳情 | 是 |
| `PUT` | `/customers/:id` | 更新客戶 | 是 |
| `DELETE` | `/customers/:id` | 停用客戶 | 是（Admin） |

### 6.3 供應商 (`/api/suppliers`)

| 方法 | 路徑 | 說明 | 認證 |
|---|---|---|---|
| `GET` | `/suppliers` | 列表 | 是 |
| `POST` | `/suppliers` | 新增 | 是 |
| `GET` | `/suppliers/:id` | 詳情 | 是 |
| `PUT` | `/suppliers/:id` | 更新 | 是 |
| `DELETE` | `/suppliers/:id` | 停用 | 是（Admin） |

### 6.4 產品/服務 (`/api/products`)

| 方法 | 路徑 | 說明 | 認證 |
|---|---|---|---|
| `GET` | `/products` | 列表 | 是 |
| `POST` | `/products` | 新增 | 是 |
| `GET` | `/products/:id` | 詳情 | 是 |
| `PUT` | `/products/:id` | 更新 | 是 |
| `DELETE` | `/products/:id` | 停用 | 是（Admin） |

### 6.5 發票 (`/api/invoices`)

| 方法 | 路徑 | 說明 | 認證 |
|---|---|---|---|
| `GET` | `/invoices` | 列表 | 是 |
| `POST` | `/invoices` | 新增 | 是 |
| `GET` | `/invoices/:id` | 詳情（含明細） | 是 |
| `PUT` | `/invoices/:id` | 更新 | 是 |
| `DELETE` | `/invoices/:id` | 取消 | 是 |

### 6.6 報價單 (`/api/quotations`)

| 方法 | 路徑 | 說明 | 認證 |
|---|---|---|---|
| `GET` | `/quotations` | 列表 | 是 |
| `POST` | `/quotations` | 新增 | 是 |
| `GET` | `/quotations/:id` | 詳情 | 是 |
| `PUT` | `/quotations/:id` | 更新 | 是 |
| `POST` | `/quotations/:id/convert` | 轉為發票 | 是 |
| `DELETE` | `/quotations/:id` | 取消 | 是 |

### 6.7 記帳 (`/api/bookkeeping`)

| 方法 | 路徑 | 說明 | 認證 |
|---|---|---|---|
| `GET` | `/bookkeeping/trial-balance` | 試算表 | 是 |
| `GET` | `/bookkeeping/income-statement` | 損益表 | 是 |
| `GET` | `/bookkeeping/export` | 匯出記帳資料 | 是 |

### 6.8 系統管理

| 方法 | 路徑 | 說明 | 認證 |
|---|---|---|---|
| `GET` | `/audit` | 稽核日誌 | 是（Admin） |
| `GET` | `/company` | 公司設定 | 是 |
| `PUT` | `/company` | 更新公司設定 | 是（Admin） |

### 6.9 WorkBuddy API (`/api/workbuddy`)

| 方法 | 路徑 | 說明 | 認證 |
|---|---|---|---|
| `GET` | `/workbuddy/manifest` | API 技能清單 | Token |
| `GET` | `/workbuddy/tokens` | 列出 API Token | 是 |
| `POST` | `/workbuddy/tokens` | 建立 API Token | 是 |
| `DELETE` | `/workbuddy/tokens/:id` | 刪除 Token | 是 |

### 6.10 PDF 生成

| 方法 | 路徑 | 說明 | 認證 |
|---|---|---|---|
| `GET` | `/pdf/invoice/:id` | 產生發票 PDF | 是 |
| `GET` | `/pdf/quotation/:id` | 產生報價單 PDF | 是 |

### 6.11 資料匯入

| 方法 | 路徑 | 說明 | 認證 |
|---|---|---|---|
| `POST` | `/import/upload` | 上傳 CSV/Excel | 是 |

---

## 7. 認證與授權

### 7.1 認證流程

```
使用者 → POST /api/auth/login（email + password）
      ← 回傳 JWT Token（24 小時有效）
      → 後續請求帶 Authorization: Bearer <token>
```

### 7.2 JWT 設定

| 項目 | 值 |
|---|---|
| 演算法 | HS256 |
| 有效期 | 24 小時 |
| 載荷（Payload） | `{ userId, email, role }` |
| 儲存位置 | LocalStorage（前端） |
| 密鑰 | `JWT_SECRET`（環境變數） |

### 7.3 角色權限

| 角色 | 客戶 | 供應商 | 產品 | 發票 | 報價 | 記帳 | 系統 | 用戶管理 |
|---|---|---|---|---|---|---|---|---|
| **admin** | CRUD | CRUD | CRUD | CRUD | CRUD | 讀 | 讀寫 | 是 |
| **user** | CRUD | CRUD | CRUD | CRUD | CRUD | 讀 | — | — |
| **auditor** | 讀 | 讀 | 讀 | 讀 | 讀 | 讀 | 讀 | — |

### 7.4 密碼安全

- 使用 `bcryptjs` 雜湊（salt rounds: 10）
- 不儲存明文密碼
- Worker CPU 限制下 bcrypt 可正常運作（~5ms）

---

## 8. 外部整合

### 8.1 WorkBuddy API

WorkBuddy 是一個語音/AI 助手整合系統，透過 REST API 存取 CRM 資料。

#### 認證

- 獨立 API Token（不同於使用者 JWT）
- 在 Settings 頁面建立/管理

#### 技能清單（Skills Manifest）

```json
{
  "skills": [
    { "name": "list_customers", "method": "GET", "path": "/api/customers" },
    { "name": "create_customer", "method": "POST", "path": "/api/customers" },
    { "name": "list_suppliers", "method": "GET", "path": "/api/suppliers" },
    { "name": "create_supplier", "method": "POST", "path": "/api/suppliers" },
    { "name": "list_products", "method": "GET", "path": "/api/products" },
    { "name": "create_product", "method": "POST", "path": "/api/products" },
    { "name": "list_invoices", "method": "GET", "path": "/api/invoices" },
    { "name": "create_invoice", "method": "POST", "path": "/api/invoices" },
    { "name": "create_quotation", "method": "POST", "path": "/api/quotations" },
    { "name": "convert_quotation", "method": "POST", "path": "/api/quotations/:id/convert" },
    { "name": "generate_pdf", "method": "GET", "path": "/api/pdf/:type/:id" }
  ]
}
```

### 8.2 WhatsApp（QClaw 橋接）

#### QClaw 簡介

**QClaw** 是騰訊（Tencent PC Manager 團隊）開發的本地 AI Agent，內建 WhatsApp / Telegram / WeChat / QQ 整合，一鍵安裝，無需 Docker 或 Linux 技術。

| 項目 | 說明 |
|---|---|
| 開發者 | 騰訊 Tencent |
| 支援平台 | Windows、macOS |
| 通訊整合 | WhatsApp、Telegram、WeChat、QQ |
| 安裝方式 | 一鍵安裝器 |
| 費用 | 免費 |
| 網站 | https://qclawsg.qq.com/ |

#### 架構

```
WhatsApp 用戶
    ↕ (持久 WebSocket)
QClaw — 跑在 Mac / Windows / QNAP（不關機）
    ↕ (HTTP Webhook → Cloudflare Worker)
OPCC CRM API
    ↕
D1 Database
```

#### 為什麼選 QClaw 而非 WuzAPI

| 對比 | QClaw | WuzAPI |
|---|---|---|
| 安裝難度 | 一鍵安裝 | 需要 Docker/Linux 知識 |
| 維護 | 騰訊自動更新 | 需手動更新 |
| 多平台 | WhatsApp + Telegram + WeChat + QQ | 只有 WhatsApp |
| AI 能力 | 內建 AI Agent | 需另外串接 |
| 適合 OPC | 非常適合（零技術門檻） | 適合技術用戶 |

#### 訊息流程

```
1. 客戶在 WhatsApp 發訊息
2. QClaw 收到 → POST 到 OPCC Webhook
3. Worker 處理：
   a. 識別客戶（用電話號碼比對 customers 表）
   b. 解析意圖（透過 DeepSeek V4 API）
   c. 執行動作（查詢、建立訂單等）
   d. 回覆客戶（透過 QClaw send API）
```

#### QClaw 運行環境（不關機方案）

| 硬體 | 價格 | 功耗 | 推薦度 |
|---|---|---|---|
| Mac Mini（已有） | $0 | 5-10W | 最佳（免費、省電） |
| QNAP NAS + QClaw Docker | 已有 | 15-25W | 推薦（24/7 原本就不關機） |
| 舊 Windows PC | $0 | 50-100W | 可用（電費較高） |
| 舊 Mac/筆電 | $0 | 10-30W | 可用 |

### 8.3 AI 整合（規劃中）

#### LLM 選擇

| 模型 | 輸入/1M tokens | 輸出/1M tokens | 用途 |
|---|---|---|---|
| **DeepSeek V4-Flash** | $0.07 | $0.28 | 日常對話、意圖識別 |
| **DeepSeek V4** | $0.27 | $1.10 | 重要任務、內容生成 |
| Claude Haiku 4.5 | $0.80 | $4.00 | 高品質寫作 |
| GPT-4o mini | $0.15 | $0.60 | 備用 |

#### AI 使用場景

| 場景 | 模型 | 預估月費 |
|---|---|---|
| WhatsApp 客服 Bot | DeepSeek V4-Flash | ~$1 |
| 報價單智能建議 | DeepSeek V4 | ~$0.5 |
| 客戶郵件草稿 | DeepSeek V4 | ~$0.3 |
| 數據分析摘要 | DeepSeek V4 | ~$0.2 |
| **合計** | | **~$2/月** |

---

## 9. 部署架構

### 9.1 Cloudflare 服務分配

| 服務 | 用途 | 費用 |
|---|---|---|
| **Workers** | API 後端（Hono） | $5/月（Paid） |
| **Pages** | 前端（React SPA） | 免費 |
| **D1** | 資料庫 | 含在 $5 內 |
| **KV** | 快取/會話 | 含在 $5 內 |
| **R2** | 檔案儲存（規劃中） | 10GB 免費 |
| **Email Routing** | 信箱路由 | 免費 |

### 9.2 域名與 SSL

| 項目 | 值 |
|---|---|
| 域名 | `opcc-crm.techforliving.net` |
| DNS | Cloudflare DNS |
| SSL | Cloudflare 自動 SSL（免費） |
| CDN | Cloudflare CDN（免費） |

### 9.3 環境

| 環境 | API URL | 前端 URL |
|---|---|---|
| 開發 | `http://localhost:8787` | `http://localhost:5173` |
| 生產 | `https://opcc-crm.techforliving.net/api` | `https://opcc-crm.techforliving.net` |

---

## 10. 開發環境設定

### 10.1 前置需求

- Node.js >= 18
- npm 或 pnpm
- Cloudflare 帳號
- Wrangler CLI（`npm install -g wrangler`）

### 10.2 安裝步驟

```bash
# 1. 克隆專案
git clone <repo-url> opcc-crm
cd opcc-crm

# 2. 安裝根依賴
npm install

# 3. 安裝 API 依賴
cd api && npm install && cd ..

# 4. 安裝前端依賴
cd frontend && npm install && cd ..

# 5. 登入 Cloudflare
npx wrangler login

# 6. 初始化資料庫
npm run db:init

# 7. 種子資料
npm run db:seed

# 8. 啟動開發環境
npm run dev
```

### 10.3 預設管理員帳號

| 項目 | 值 |
|---|---|
| Email | `admin@example.com` |
| Password | `your_password` |
| Role | admin |

### 10.4 部署

```bash
# 部署 API
npm run deploy:api

# 部署前端
npm run deploy:frontend
```

---

## 11. WhatsApp 橋接架構

### 11.1 整體流程

```
                        ┌─────────────────┐
                        │   WhatsApp 雲端  │
                        └────────┬────────┘
                                 │ WebSocket
                        ┌────────┴────────┐
                        │     QClaw       │
                        │  (Tencent)      │
                        │  Mac/PC 不關機  │
                        │  免費           │
                        └────────┬────────┘
                                 │ HTTP POST (Webhook)
                                 ▼
┌────────────────────────────────────────────────────┐
│            Cloudflare Worker (Hono)                │
│  POST /api/whatsapp/webhook                        │
│  ┌──────────────────────────────────────────┐      │
│  │ 1. 驗證 Webhook 簽名                    │      │
│  │ 2. 解析訊息類型（文字/圖片/文件）       │      │
│  │ 3. 用電話號碼匹配客戶                   │      │
│  │ 4. 呼叫 LLM 解析意圖                    │      │
│  │ 5. 執行業務邏輯                         │      │
│  │ 6. 透過 QClaw API 回覆                  │      │
│  └──────────────────────────────────────────┘      │
└────────────────────────────────────────────────────┘
```

### 11.2 QClaw 安全部署

#### 安裝步驟（Mac/Windows）

```
1. 下載 QClaw：https://qclawsg.qq.com/
2. 一鍵安裝
3. 開啟 QClaw → 選擇 WhatsApp → 掃 QR Code
4. 設定 Webhook URL：https://opcc-crm.techforliving.net/api/whatsapp/webhook
5. 完成
```

#### 確保 24/7 運行

| 平台 | 設定方法 |
|---|---|
| **macOS** | 系統偏好設定 → 省電 → 防止自動休眠 + 設定 QClaw 為登入項目 |
| **Windows** | 工作管理員 → 啟動 → 啟用 QClaw + 設定電源為「永遠不休眠」 |
| **QNAP** | Container Station → QClaw Docker → restart policy: always |

### 11.3 Webhook 安全

- QClaw 支援 Webhook 簽名驗證
- Worker 端驗證簽名標頭
- 防止偽造 Webhook 請求

---

## 12. AI 整合方案

### 12.1 DeepSeek V4 API 整合

```typescript
// lib/deepseek.ts（規劃中）
const DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

async function chat(messages: ChatMessage[], model = 'deepseek-v4-flash') {
  const response = await fetch(DEEPSEEK_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({ model, messages })
  })
  return response.json()
}
```

### 12.2 AI 功能規劃

| 功能 | 優先級 | 說明 |
|---|---|---|
| WhatsApp 客服 Bot | P0 | 自動回覆常見問題、查詢訂單 |
| 智能報價 | P1 | 根據歷史數據建議定價 |
| 郵件草稿 | P1 | 根據上下文生成商業郵件 |
| 發票摘要 | P2 | 自動生成月度財務摘要 |
| 客戶洞察 | P2 | 分析客戶行為模式 |

---

## 13. 成本分析

### 13.1 固定月費

| 項目 | 月費（HKD） | 年費（HKD） |
|---|---|---|
| Cloudflare Workers Paid | ~$39 | ~$468 |
| 域名 | — | ~$80 |
| 公司合規（秘書+地址+審計） | — | ~$8,000 |
| **小計** | **~$39/月** | **~$8,548/年** |

### 13.2 按量費用（視使用量）

| 項目 | 單價 | 預估月費 |
|---|---|---|
| DeepSeek V4-Flash API | $0.28/1M tokens | ~$8 |
| Stripe HK（網上收款） | 2.9% + $2.35 | 視交易量 |
| QClaw 電費（Mac Mini 24/7） | — | ~$30 |
| SMS 通知（規劃中） | ~$0.5/條 | ~$15 |

### 13.3 免費額度（不需付費）

| 服務 | 免費額度 |
|---|---|
| Cloudflare Workers | 10 萬請求/天（Free tier） |
| Cloudflare Pages | 無限靜態部署 |
| Cloudflare CDN | 無限頻寬 |
| Cloudflare SSL | 免費 |
| Cloudflare Email Routing | 免費 |
| WhatsApp Business | 免費 |
| FPS 轉數快 | 免費 |
| Wave 會計 | 免費 |
| Canva Free | 免費 |
| Notion Free | 免費 |
| Google Search Console | 免費 |

### 13.4 不同階段的成本

| 階段 | 月費（HKD） | 說明 |
|---|---|---|
| **MVP 測試** | $0 | 全用免費方案 |
| **正式營運** | ~$50 | Workers + AI API |
| **成長期** | ~$100 | + Google Workspace + 進階 AI |
| **擴展期** | ~$200 | + Stripe + 更多 AI 用量 |

---

## 14. 未來規劃

### Phase 1 — 穩定基礎（當前）
- [x] CRM 核心功能（客戶、供應商、產品）
- [x] 發票與報價管理
- [x] 複式簿記
- [x] PDF 生成
- [x] 稽核日誌
- [x] WorkBuddy API
- [x] 多用戶支援

### Phase 2 — WhatsApp 整合
- [ ] QClaw Webhook 接收端
- [ ] 客戶電話號碼匹配
- [ ] WhatsApp 收發訊息
- [ ] AI 意圖識別
- [ ] 自動回覆常見問題

### Phase 3 — AI 功能
- [ ] DeepSeek V4 API 整合
- [ ] WhatsApp 客服 Bot
- [ ] 智能報價建議
- [ ] 自動郵件草稿
- [ ] 月度財務摘要

### Phase 4 — 支付與通知
- [ ] Stripe HK 整合
- [ ] 線上支付連結
- [ ] FPS QR Code 生成
- [ ] 發票到期提醒（WhatsApp/Email）

### Phase 5 — 多平台
- [ ] Telegram Bot
- [ ] LINE 整合（如需拓展到台灣/泰國）
- [ ] 手機 App（PWA 或 React Native）

---

## 附錄 A：技術棧一覽表

```
OPCC 技術棧 v1.0
├── 後端
│   ├── 運行環境    Cloudflare Workers (V8 Isolate)
│   ├── 框架        Hono v4.6
│   ├── 語言        TypeScript 5.7
│   ├── 驗證        Zod + @hono/zod-validator
│   ├── 認證        JWT (jsonwebtoken)
│   ├── 密碼        bcryptjs
│   └── 部署        Wrangler 3.99
│
├── 前端
│   ├── 框架        React 18
│   ├── 建置        Vite 6
│   ├── 路由        React Router DOM 6
│   ├── 狀態        TanStack React Query 5
│   ├── UI 元件     Radix UI
│   ├── 圖示        Lucide React
│   ├── 樣式        Tailwind CSS 3
│   ├── 圖表        Recharts
│   ├── 日期        date-fns
│   └── 部署        Cloudflare Pages
│
├── 資料
│   ├── 資料庫      Cloudflare D1 (SQLite)
│   ├── 快取        Cloudflare KV
│   └── 檔案        Cloudflare R2（規劃中）
│
├── 外部服務
│   ├── WhatsApp    QClaw (Tencent) — Mac/PC 不關機
│   ├── AI          DeepSeek V4 API
│   ├── 支付        Stripe HK（規劃中）
│   ├── Email       Cloudflare Email Routing
│   └── PDF         HTML → PDF（Worker 內生成）
│
├── 開發工具
│   ├── 版控        Git
│   ├── 語言        TypeScript（全端）
│   ├── 測試        —（規劃中）
│   └── CI/CD       —（手動 wrangler deploy）
│
└── 基礎設施
    ├── CDN         Cloudflare（300+ 節點）
    ├── SSL         Cloudflare（免費）
    ├── DNS         Cloudflare
    └── Domain      opcc-crm.techforliving.net
```

---

## 附錄 B：香港 OPC 合規要求

| 要求 | 頻率 | 費用/年 |
|---|---|---|
| 商業登記證續期 | 每年 | $2,200 |
| 周年申報表（NAR1） | 每年 | $105（政府） |
| 審計報告 | 每年 | $3,000-8,000 |
| 利得稅申報 | 每年 | 視利潤 |
| 強積金（自僱） | 每月 | $1,500（可選） |
| 公司秘書 | 每年 | $1,500-5,000 |

---

*文件維護者：OPCC 團隊*
*技術支援：hello@opcc-crm.techforliving.net*
