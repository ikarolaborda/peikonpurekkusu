export interface Money {
  amount_minor_units: number;
  currency_code: string;
}

export interface Account {
  account_id: string;
  currency_code: string;
  type: string;
  status: string;
  available_minor_units: number;
  held_minor_units: number;
}

export interface Balance {
  account_id: string;
  available_minor_units: number;
  held_minor_units: number;
  currency_code: string;
  as_of: string;
  source: 'ledger' | 'cache';
}

export type PaymentStatus =
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'refunded';

export interface Payment {
  id: string;
  status: PaymentStatus;
  step?: string;
  amount: Money;
  merchant_id: string;
  merchant_name?: string;
  instrument_id?: string;
  failure_code?: string | null;
  failure_detail?: string | null;
  psp_reference?: string | null;
  created_at?: string;
}

export interface Instrument {
  instrument_id: string;
  method: 'card' | 'wallet';
  brand?: string | null;
  last4?: string | null;
  exp_month?: number | null;
  exp_year?: number | null;
}

export interface Merchant {
  merchant_id: string;
  display_name: string;
  category: string;
}

export interface FxQuote {
  quote_id: string;
  base: string;
  quote: string;
  rate: string;
  expires_at: string;
}

export interface Transaction {
  transaction_id: string;
  payment_id: string;
  account_id: string;
  merchant_id?: string;
  transaction_type: string;
  amount_minor_units: number;
  currency_code: string;
  occurred_at?: string;
  recorded_at: string;
}

export interface AppNotification {
  id: string;
  template_id: string;
  title: string;
  body: string;
  read_at?: string | null;
  created_at: string;
}

export interface SessionInfo {
  session_id: string;
  current: boolean;
  created_at: string;
  ip: string;
}

export interface UserProfile {
  user_id: string;
  email: string;
  first_name: string;
  last_name: string;
  kyc_status: string;
  mfa_enrolled: boolean;
}
