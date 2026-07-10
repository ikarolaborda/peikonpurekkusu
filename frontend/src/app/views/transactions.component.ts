import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MoneyPipe } from '../core/money.pipe';
import { PaymentsService } from '../core/payments.service';
import type { Transaction } from '../core/models';

@Component({
  selector: 'peikon-transactions',
  imports: [MoneyPipe, DatePipe],
  template: `
    <h1 class="text-xl font-bold mb-6">Transactions</h1>
    @if (loading()) {
      <div class="card p-8 text-center" style="color: var(--color-text-muted)">Loading…</div>
    } @else if (rows().length === 0) {
      <div class="card p-8 text-center" style="color: var(--color-text-muted)">
        No transactions yet. Completed payments appear here once recorded.
      </div>
    } @else {
      <div class="card overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left" style="color: var(--color-text-dim); border-bottom: 1px solid var(--color-border)">
              <th class="px-4 py-3 font-medium">Type</th>
              <th class="px-4 py-3 font-medium">Merchant</th>
              <th class="px-4 py-3 font-medium text-right">Amount</th>
              <th class="px-4 py-3 font-medium">Recorded</th>
            </tr>
          </thead>
          <tbody>
            @for (t of rows(); track t.transaction_id) {
              <tr style="border-bottom: 1px solid var(--color-border)">
                <td class="px-4 py-3"><span class="badge">{{ t.transaction_type }}</span></td>
                <td class="px-4 py-3" style="color: var(--color-text-muted)">{{ t.merchant_id ?? '—' }}</td>
                <td class="px-4 py-3 text-right tabular"
                    [style.color]="t.transaction_type === 'refund' ? 'var(--color-warning-500)' : 'var(--color-text)'">
                  {{ t.amount_minor_units | money: t.currency_code }} {{ t.currency_code }}
                </td>
                <td class="px-4 py-3 tabular text-xs" style="color: var(--color-text-dim)">
                  {{ t.recorded_at | date: 'short' }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class TransactionsComponent {
  private readonly payments = inject(PaymentsService);
  readonly rows = signal<Transaction[]>([]);
  readonly loading = signal(true);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await this.payments.transactions();
      this.rows.set(res.transactions);
    } finally {
      this.loading.set(false);
    }
  }
}
