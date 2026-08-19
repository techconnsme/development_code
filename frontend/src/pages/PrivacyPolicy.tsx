import React from 'react';

export default function PrivacyPolicy() {
  return (
    <div className="max-w-3xl mx-auto space-y-6 py-8">
      <h1 className="text-3xl font-bold">Privacy Policy</h1>
      <p className="text-muted-foreground">Last updated: 2026-05-20</p>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">1. Data We Collect</h2>
        <p className="text-muted-foreground">
          OPCC CRM collects only the data necessary to provide accounting and compliance services:
          email address, name, company name, and accounting data (transactions, invoices, financial records)
          that you or your accountant enter into the system.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">2. How We Use Your Data</h2>
        <p className="text-muted-foreground">
          Your data is used exclusively to provide the OPCC CRM service — managing your accounting
          records, generating financial reports, and tracking compliance deadlines. We do not sell,
          share, or use your data for advertising, profiling, or any purpose unrelated to the service.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">3. Data Storage & Security</h2>
        <ul className="list-disc pl-5 text-muted-foreground space-y-1">
          <li>All data is stored on Cloudflare infrastructure (D1, R2, KV) with encryption at rest and in transit (TLS 1.3).</li>
          <li>Passwords are hashed with bcrypt (cost factor 12) and never stored in plaintext.</li>
          <li>Authentication uses JWT tokens stored in httpOnly cookies, inaccessible to JavaScript.</li>
          <li>API tokens are SHA-256 hashed before storage.</li>
          <li>All database queries use parameterized statements to prevent SQL injection.</li>
          <li>Multi-tenant data isolation ensures each client's data is accessible only to authorized users.</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">4. Cookies</h2>
        <p className="text-muted-foreground">
          OPCC CRM uses a single essential cookie: an authentication token (httpOnly, Secure, SameSite=Lax)
          required for you to remain logged in. This is a strictly necessary cookie for the service to function.
          We do not use tracking cookies, analytics cookies, or third-party cookies.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">5. Third-Party Services</h2>
        <p className="text-muted-foreground">
          The AI chat feature may send your prompts to AI API providers (Qwen, DeepSeek, OpenRouter) for processing.
          No accounting data is sent to these providers unless you explicitly include it in your prompt.
          File OCR processing uses Cloudflare Workers AI and does not leave the Cloudflare network.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">6. Your Rights</h2>
        <ul className="list-disc pl-5 text-muted-foreground space-y-1">
          <li><strong>Access:</strong> You can export all your data in JSON format from your account settings.</li>
          <li><strong>Deletion:</strong> You can delete your account and all associated data from your account settings. This action is irreversible.</li>
          <li><strong>Correction:</strong> You can update your accounting data at any time through the application.</li>
          <li><strong>Portability:</strong> Use the data export feature to receive your data in a machine-readable JSON format.</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">7. Data Retention</h2>
        <p className="text-muted-foreground">
          Data is retained for the duration of your account's active subscription plus any period required
          by Hong Kong law (typically 7 years for accounting records under the Inland Revenue Ordinance).
          Upon account deletion, all personal data is permanently removed.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">8. Contact</h2>
        <p className="text-muted-foreground">
          For privacy-related inquiries, please contact your account administrator or the service provider
          through the contact information provided when you registered.
        </p>
      </section>
    </div>
  );
}
