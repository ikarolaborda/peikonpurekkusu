import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG } from './api';
import type {
  Account,
  Balance,
  FxQuote,
  Instrument,
  Merchant,
  Money,
  Payment,
  Transaction,
} from './models';

@Injectable({ providedIn: 'root' })
export class PaymentsService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(APP_CONFIG).apiBaseUrl;

  accounts(): Promise<{ accounts: Account[] }> {
    return firstValueFrom(this.http.get<{ accounts: Account[] }>(`${this.base}/accounts`));
  }

  balance(accountId: string): Promise<Balance> {
    return firstValueFrom(this.http.get<Balance>(`${this.base}/accounts/${accountId}/balance`));
  }

  merchants(): Promise<{ merchants: Merchant[] }> {
    return firstValueFrom(this.http.get<{ merchants: Merchant[] }>(`${this.base}/payments/merchants`));
  }

  async instruments(): Promise<Instrument[]> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ instruments: Instrument[] }>(`${this.base}/payments/instruments`),
      );
      return res.instruments;
    } catch {
      // Fallback demo instruments if the endpoint is unavailable.
      return [
        { instrument_id: '00000000-0000-0000-0000-0000000ca4d1', method: 'card', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
        { instrument_id: '00000000-0000-0000-0000-0000000a11e7', method: 'wallet' },
      ];
    }
  }

  fxQuote(amount: Money, targetCurrency: string): Promise<FxQuote> {
    return firstValueFrom(
      this.http.post<FxQuote>(`${this.base}/payments/fx-quote`, { amount, target_currency: targetCurrency }),
    );
  }

  createPayment(
    body: { account_id: string; merchant_id: string; instrument_id: string; amount: Money; fx_quote_id?: string },
    idempotencyKey: string,
  ): Promise<Payment> {
    return firstValueFrom(
      this.http.post<Payment>(`${this.base}/payments`, body, {
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    );
  }

  payment(id: string): Promise<Payment> {
    return firstValueFrom(this.http.get<Payment>(`${this.base}/payments/${id}`));
  }

  transactions(accountId?: string): Promise<{ transactions: Transaction[]; next_cursor?: string }> {
    const q = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
    return firstValueFrom(
      this.http.get<{ transactions: Transaction[]; next_cursor?: string }>(`${this.base}/transactions${q}`),
    );
  }
}
