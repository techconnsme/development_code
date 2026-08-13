# Onboarding Guide — Creating User Accounts via Claude Code

This guide is for a developer who has been invited as a **Cloudflare member** to create user accounts for the Tech Connect SME (OPCC CRM) web app.

---

## 1. Prerequisites

### 1.1 Cloudflare Account Access
You'll receive an email invitation to join the Cloudflare account. Accept it. Once accepted, you'll be a **member** of:

| Field | Value |
|-------|-------|
| **Account ID** | `8c00cc4647a9cf5d8deb5d6a354001e0` |
| **Account Owner** | Ammar (Ruhan) |

### 1.2 Install Wrangler CLI
```bash
npm install -g wrangler
```

### 1.3 Login to Cloudflare
```bash
npx wrangler login
```
This opens a browser — log in with the email that was invited.

Verify you're in the right account:
```bash
npx wrangler whoami
```

---

## 2. Project Context

| What | URL / Value |
|------|-------------|
| **Frontend (production)** | `https://sme.techforliving.net` |
| **Frontend (testing)** | `https://opcc-crm-testing.pages.dev` |
| **API Worker** | `https://opcc-crm-api.ruhan-farhan.workers.dev` |
| **D1 Database** | `opcc-crm-db` (ID: `218544bf-f765-40ae-b90d-2915033b1e67`) |
| **GitHub Repo** | `https://github.com/techconnsme/development_code` |

---

## 3. How to Create a User Account

There are **two methods**. Method A (API) is recommended — it handles password hashing, firm creation, COA seeding, and audit logging automatically.

### Method A: Via the API (Recommended)

The admin endpoint is:
```
POST https://opcc-crm-api.ruhan-farhan.workers.dev/api/admin/create-account
```

**Step 1 — Get an admin JWT token:**

First, log in as the admin to obtain a token:
```bash
curl -X POST https://opcc-crm-api.ruhan-farhan.workers.dev/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "memonruhan731@gmail.com", "password": "Hamdan123"}'
```

The response includes a `token` field. Copy it.

**Step 2 — Create the account:**

```bash
curl -X POST https://opcc-crm-api.ruhan-farhan.workers.dev/api/admin/create-account \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d '{
    "email": "newuser@example.com",
    "password": "TheirPassword123",
    "name": "Their Full Name",
    "role": "supervisor",
    "company_name": "Their Company Ltd"
  }'
```

**Request body fields:**

| Field | Required | Notes |
|-------|----------|-------|
| `email` | ✅ | Must be unique |
| `password` | ✅ | Min 6 characters |
| `name` | ✅ | Full name |
| `role` | ✅ | One of: `supervisor`, `accountant`, `staff`, `viewer`, `auditor`, `admin` |
| `company_name` | No | Defaults to `name` if omitted |
| `permission_tier` | No | `higher` (default for supervisor/accountant/admin) or `normal` |
| `link_to_firm_id` | No | Link to an existing firm instead of auto-creating one |

**Role guide:**
- **`supervisor`** — Company owner. Has full access to their own data + can create staff accounts. This is the typical role for a new client company.
- **`accountant`** — Like supervisor but with some restrictions.
- **`staff`** — Standard user under a supervisor.
- **`viewer`** — Read-only access.
- **`auditor`** — Read-only + compliance review.
- **`admin`** — Platform super-admin. Use sparingly.

**Response (201):**
```json
{
  "id": "u-abc12345",
  "email": "newuser@example.com",
  "name": "Their Full Name",
  "role": "supervisor",
  "company_name": "Their Company Ltd",
  "permission_tier": "higher",
  "firm_client_id": null,
  "password": "TheirPassword123"
}
```

The API also auto-creates:
- A personal **firm** for the user
- **Company settings** record
- **Chart of Accounts** (seeded from template)
- **Compliance templates**
- **Audit log** entry

---

### Method B: Via D1 Database (Direct SQL)

⚠️ **Not recommended** — you must hash the password yourself, and you skip firm creation, COA seeding, and audit logging. Only use this for quick test accounts.

```bash
cd api

# First, generate a bcrypt hash of the password.
# In Node.js: require('bcryptjs').hashSync('password123', 12)
# Or use an online bcrypt tool.

CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 \
npx wrangler d1 execute opcc-crm-db --remote --command="
INSERT INTO users (id, email, password_hash, name, company_name, role, status, permission_tier)
VALUES ('u-$(uuidgen | cut -c1-8)', 'user@example.com', '<BCRYPT_HASH>', 'Name', 'Company', 'supervisor', 'active', 'higher');
"
```

---

## 4. Claude Code Prompt Template

Once you have the prerequisites set up, you can simply ask Claude Code:

> *"Create a new user account for [Company Name]. Email: [email], Name: [name], Role: supervisor. Use the admin API at https://opcc-crm-api.ruhan-farhan.workers.dev. Login as admin first, then call /api/admin/create-account. Show me the credentials when done."*

Claude Code will:
1. Login as admin to get a JWT token
2. Call the create-account endpoint
3. Return the new user's ID and credentials

**Batch creation example prompt:**

> *"Create supervisor accounts for these companies using the admin API:*
> 1. ABC Ltd — alice@abc.com / Alice Wong
> 2. XYZ Corp — bob@xyz.com / Bob Chan
> *For each, generate a secure temporary password and report all credentials in a table."*

---

## 5. Useful Commands Reference

### Check who is logged in
```bash
npx wrangler whoami
```

### List all users (via D1)
```bash
CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 \
npx wrangler d1 execute opcc-crm-db --remote \
  --command="SELECT id, email, name, role, company_name, created_at FROM users ORDER BY created_at DESC LIMIT 20;"
```

### List pending applications
```bash
CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 \
npx wrangler d1 execute opcc-crm-db --remote \
  --command="SELECT * FROM applications WHERE status = 'pending' ORDER BY created_at DESC;"
```

### Approve an application (via API)
```bash
curl -X POST https://opcc-crm-api.ruhan-farhan.workers.dev/api/admin/applications/<APP_ID>/approve \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

### Check a user exists
```bash
CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 \
npx wrangler d1 execute opcc-crm-db --remote \
  --command="SELECT * FROM users WHERE email = 'user@example.com';"
```

### Deploy API (if you make changes)
```bash
cd api
CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 npx wrangler deploy
```

---

## 6. Troubleshooting

| Problem | Solution |
|---------|----------|
| `wrangler whoami` shows wrong account | Run `npx wrangler logout` then `npx wrangler login` |
| `401 Unauthorized` on API | Admin token expired (24h TTL). Re-login to get a fresh one. |
| `409 This email is already registered` | Email already exists. Check with the D1 query above. |
| `403 Admin only` | The account used for the token is not an `admin` role. Use `memonruhan731@gmail.com`. |
| `wrangler deploy` fails with permission error | You may not have deploy permissions. Only account admins can deploy. Check with Ammar. |
| Invitation email not received | Ask Ammar (`memonruhan731@gmail.com`) to resend the Cloudflare member invite. |

---

## 7. Contacts

| Person | Role | Contact |
|--------|------|---------|
| Ammar Inamullah | Backend dev / Cloudflare account owner | `memonruhan731@gmail.com` |
| Ruhan | Frontend dev | `muhammadruhan.farhan25@gmail.com` |
| Casey @ Pastel | Project owner | WhatsApp |
| Joseph Lin | Product lead (PnR) | `joseph.lin@pnr.hk` |

---

*Last updated: 2026-08-11*
