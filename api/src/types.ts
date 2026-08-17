import { Context, Next } from 'hono';

export type Bindings = {
  DB: D1Database;
  DB_HAYSON?: D1Database;
  DB_PAULTANG?: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT?: string;
  FILE_BUCKET: R2Bucket;
  AI: any;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  DEEPSEEK_API_KEY: string;
  GLM_API_KEY?: string;
  QWEN_API_KEY?: string;
};

export type Variables = {
  user: AuthUser;
  client_user_id?: string;
};

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  company_name?: string;
  scopes?: string;
  firm_id?: string;
  firm_role?: string;
}

export type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;
export type AppNext = Next;
