import { Injectable } from '@nestjs/common';

export interface RenderedTemplate {
  title: string;
  body: string;
}

/**
 * Code-defined template registry. Templates carry only `{{param}}`
 * placeholders — payloads pass minimal params, never raw PII beyond what the
 * message needs (money is formatted from minor units at render time).
 */
const TEMPLATES: Record<string, { title: string; body: string }> = {
  welcome: {
    title: 'Welcome to peikonpurekkusu',
    body: 'Your account is ready. KYC status: {{kyc_status}}.',
  },
  payment_captured: {
    title: 'Payment successful',
    body: 'Your payment of {{amount}} {{currency}} to {{merchant}} was captured.',
  },
  payment_failed: {
    title: 'Payment failed',
    body: 'Your payment of {{amount}} {{currency}} could not be completed ({{reason}}).',
  },
  fraud_alert: {
    title: 'Security review on your account',
    body: 'A recent activity was flagged for review ({{action}}). No action may be needed.',
  },
};

@Injectable()
export class TemplateRegistry {
  has(templateId: string): boolean {
    return templateId in TEMPLATES;
  }

  render(templateId: string, params: Record<string, unknown>): RenderedTemplate {
    const tpl = TEMPLATES[templateId];
    if (!tpl) {
      return { title: 'Notification', body: JSON.stringify(params) };
    }
    return {
      title: interpolate(tpl.title, params),
      body: interpolate(tpl.body, params),
    };
  }
}

function interpolate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = params[key];
    return v === undefined || v === null ? `{{${key}}}` : String(v);
  });
}
