import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MoneyPipe } from '../core/money.pipe';
import { PaymentsService } from '../core/payments.service';
import { SessionStore } from '../core/session.store';
import type { Account } from '../core/models';

@Component({
  selector: 'peikon-dashboard',
  imports: [RouterLink, MoneyPipe],
  template: `
    <div class="flex items-baseline justify-between mb-6">
      <div>
        <h1 class="text-xl font-bold">Accounts</h1>
        <p class="text-sm" style="color: var(--color-text-muted)">
          KYC: <span class="badge">{{ session.profile()?.kyc_status ?? '—' }}</span>
        </p>
      </div>
      <a routerLink="/pay" class="btn btn-accent">Send a payment →</a>
    </div>

    @if (loading()) {
      <div class="card p-8 text-center" style="color: var(--color-text-muted)">Loading accounts…</div>
    } @else if (accounts().length === 0) {
      <div class="card p-8 text-center" style="color: var(--color-text-muted)">
        No accounts yet. Your account is provisioned moments after registration —
        <button class="underline" (click)="load()">refresh</button>.
      </div>
    } @else {
      <div class="grid gap-4 sm:grid-cols-2">
        @for (acc of accounts(); track acc.account_id) {
          <div class="card p-5">
            <div class="flex items-center justify-between mb-4">
              <span class="badge">{{ acc.currency_code }}</span>
              <span class="text-xs" style="color: var(--color-text-dim)">{{ acc.type }}</span>
            </div>
            <div class="tabular text-3xl font-bold">
              {{ acc.available_minor_units | money: acc.currency_code }}
            </div>
            <div class="text-xs mt-1" style="color: var(--color-text-muted)">available</div>
            @if (acc.held_minor_units > 0) {
              <div class="tabular text-sm mt-3" style="color: var(--color-warning-500)">
                {{ acc.held_minor_units | money: acc.currency_code }} held
              </div>
            }
            <div class="text-xs mt-4 truncate" style="color: var(--color-text-dim)">
              {{ acc.account_id }}
            </div>
          </div>
        }
      </div>
    }
  `,
})
export class DashboardComponent {
  readonly session = inject(SessionStore);
  private readonly payments = inject(PaymentsService);

  readonly accounts = signal<Account[]>([]);
  readonly loading = signal(true);

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const res = await this.payments.accounts();
      this.accounts.set(res.accounts);
    } finally {
      this.loading.set(false);
    }
  }
}
