import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { APP_CONFIG } from '../core/api';
import { MoneyPipe } from '../core/money.pipe';
import { PaymentsService } from '../core/payments.service';
import { SessionStore } from '../core/session.store';
import type { Account, Instrument, Merchant, Payment, PaymentStatus } from '../core/models';

type Step = 'amount' | 'instrument' | 'review' | 'processing' | 'done';

@Component({
  selector: 'peikon-pay',
  imports: [FormsModule, MoneyPipe, RouterLink],
  template: `
    <div class="max-w-lg mx-auto">
      <h1 class="text-xl font-bold mb-1">Send a payment</h1>
      <p class="text-sm mb-6" style="color: var(--color-text-muted)">
        Fraud-screened, funds held, then captured — watch it live.
      </p>

      <!-- step rail -->
      <div class="flex items-center gap-2 mb-6 text-xs">
        @for (s of steps; track s.key; let i = $index) {
          <div class="flex items-center gap-2">
            <span class="badge" [style.border-color]="stepIndex() >= i ? 'var(--color-accent-500)' : 'var(--color-border)'"
                  [style.color]="stepIndex() >= i ? 'var(--color-accent-500)' : 'var(--color-text-dim)'">
              {{ s.label }}
            </span>
            @if (i < steps.length - 1) { <span style="color: var(--color-text-dim)">→</span> }
          </div>
        }
      </div>

      <div class="card p-6">
        @switch (step()) {
          @case ('amount') {
            <div class="space-y-4">
              <div>
                <label class="label" for="acc">From account</label>
                <select id="acc" class="input" [(ngModel)]="accountId">
                  @for (a of accounts(); track a.account_id) {
                    <option [value]="a.account_id">{{ a.currency_code }} · {{ a.available_minor_units | money: a.currency_code }} available</option>
                  }
                </select>
              </div>
              <div>
                <label class="label" for="merchant">Pay to</label>
                <select id="merchant" class="input" [(ngModel)]="merchantId">
                  @for (m of merchants(); track m.merchant_id) {
                    <option [value]="m.merchant_id">{{ m.display_name }}</option>
                  }
                </select>
              </div>
              <div>
                <label class="label" for="amt">Amount ({{ selectedCurrency() }})</label>
                <input id="amt" class="input tabular" type="number" min="0.01" step="0.01" [(ngModel)]="amountMajor" placeholder="0.00" />
                <p class="text-xs mt-1" style="color: var(--color-text-dim)">
                  Try an amount ending in .42 to see a decline, or pay with the wallet for the async flow.
                </p>
              </div>
              <button class="btn btn-accent w-full" [disabled]="!canProceedAmount()" (click)="step.set('instrument')">Continue</button>
            </div>
          }

          @case ('instrument') {
            <div class="space-y-3">
              <label class="label">Payment method</label>
              @for (inst of instruments(); track inst.instrument_id) {
                <button
                  class="btn w-full justify-between"
                  [style.border-color]="instrumentId === inst.instrument_id ? 'var(--color-accent-500)' : 'var(--color-border-strong)'"
                  (click)="instrumentId = inst.instrument_id"
                >
                  <span>{{ inst.method === 'card' ? 'Card' : 'Wallet' }}
                    @if (inst.last4) { <span class="tabular" style="color: var(--color-text-muted)">•••• {{ inst.last4 }}</span> }
                  </span>
                  <span style="color: var(--color-text-dim)">{{ inst.brand ?? inst.method }}</span>
                </button>
              }
              <div class="flex gap-2 pt-2">
                <button class="btn flex-1" (click)="step.set('amount')">Back</button>
                <button class="btn btn-accent flex-1" [disabled]="!instrumentId" (click)="step.set('review')">Review</button>
              </div>
            </div>
          }

          @case ('review') {
            <div class="space-y-4">
              <div class="flex justify-between py-2 border-b" style="border-color: var(--color-border)">
                <span style="color: var(--color-text-muted)">Amount</span>
                <span class="tabular font-bold">{{ amountMinor() | money: selectedCurrency() }} {{ selectedCurrency() }}</span>
              </div>
              <div class="flex justify-between py-2 border-b" style="border-color: var(--color-border)">
                <span style="color: var(--color-text-muted)">To</span>
                <span>{{ merchantName() }}</span>
              </div>
              <div class="flex justify-between py-2 border-b" style="border-color: var(--color-border)">
                <span style="color: var(--color-text-muted)">Method</span>
                <span>{{ instrumentLabel() }}</span>
              </div>
              @if (error()) {
                <div class="text-sm px-3 py-2 border" style="color: var(--color-danger-500); border-color: var(--color-danger-600)">{{ error() }}</div>
              }
              <div class="flex gap-2">
                <button class="btn flex-1" [disabled]="busy()" (click)="step.set('instrument')">Back</button>
                <button class="btn btn-accent flex-1" [disabled]="busy()" (click)="submit()">
                  {{ busy() ? 'Submitting…' : 'Pay ' + (amountMinor() | money: selectedCurrency()) }}
                </button>
              </div>
            </div>
          }

          @case ('processing') {
            <div class="text-center py-8">
              <div class="text-sm uppercase tracking-widest mb-4" style="color: var(--color-text-muted)">{{ statusLabel() }}</div>
              <div class="flex items-center justify-center gap-1.5 mb-6">
                @for (dot of [0,1,2]; track dot) {
                  <span class="w-2 h-2" style="background: var(--color-accent-500)" [style.opacity]="pulse() === dot ? '1' : '0.3'"></span>
                }
              </div>
              <p class="text-sm" style="color: var(--color-text-dim)">
                {{ currentStep() || 'contacting the payment service…' }}
              </p>
            </div>
          }

          @case ('done') {
            <div class="text-center py-6">
              @if (result()?.status === 'succeeded') {
                <div class="text-5xl mb-3" style="color: var(--color-success-500)">✓</div>
                <div class="font-bold text-lg">Payment successful</div>
              } @else {
                <div class="text-5xl mb-3" style="color: var(--color-danger-500)">✗</div>
                <div class="font-bold text-lg">Payment {{ result()?.status }}</div>
                @if (result()?.failure_code) {
                  <div class="text-sm mt-1" style="color: var(--color-text-muted)">{{ result()?.failure_code }}</div>
                }
              }
              <div class="card p-4 mt-5 text-left text-sm space-y-2" style="background: var(--color-surface)">
                <div class="flex justify-between"><span style="color: var(--color-text-dim)">Amount</span>
                  <span class="tabular">{{ result()?.amount?.amount_minor_units | money: (result()?.amount?.currency_code ?? 'USD') }} {{ result()?.amount?.currency_code }}</span></div>
                <div class="flex justify-between"><span style="color: var(--color-text-dim)">Payment ID</span>
                  <span class="tabular text-xs">{{ result()?.id }}</span></div>
                @if (result()?.psp_reference) {
                  <div class="flex justify-between"><span style="color: var(--color-text-dim)">Processor ref</span>
                    <span class="tabular text-xs">{{ result()?.psp_reference }}</span></div>
                }
              </div>
              <div class="flex gap-2 mt-5">
                <a routerLink="/transactions" class="btn flex-1">View transactions</a>
                <button class="btn btn-accent flex-1" (click)="reset()">New payment</button>
              </div>
            </div>
          }
        }
      </div>
    </div>
  `,
})
export class PayComponent {
  private readonly payments = inject(PaymentsService);
  private readonly session = inject(SessionStore);
  private readonly base = inject(APP_CONFIG).apiBaseUrl;

  readonly steps = [
    { key: 'amount', label: 'Amount' },
    { key: 'instrument', label: 'Method' },
    { key: 'review', label: 'Review' },
    { key: 'processing', label: 'Pay' },
  ];

  readonly step = signal<Step>('amount');
  readonly accounts = signal<Account[]>([]);
  readonly merchants = signal<Merchant[]>([]);
  readonly instruments = signal<Instrument[]>([]);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<Payment | null>(null);
  readonly statusLabel = signal('Processing');
  readonly currentStep = signal('');
  readonly pulse = signal(0);

  accountId = '';
  merchantId = '';
  instrumentId = '';
  amountMajor: number | null = null;

  readonly stepIndex = computed(() => this.steps.findIndex((s) => s.key === this.step()) === -1
    ? this.steps.length - 1
    : this.steps.findIndex((s) => s.key === this.step()));

  readonly selectedCurrency = computed(
    () => this.accounts().find((a) => a.account_id === this.accountId)?.currency_code ?? 'USD',
  );
  readonly amountMinor = computed(() => Math.round((this.amountMajor ?? 0) * 100));
  readonly merchantName = computed(
    () => this.merchants().find((m) => m.merchant_id === this.merchantId)?.display_name ?? this.merchantId,
  );
  readonly instrumentLabel = computed(() => {
    const i = this.instruments().find((x) => x.instrument_id === this.instrumentId);
    return i ? (i.method === 'card' ? `Card •••• ${i.last4}` : 'Wallet') : '';
  });

  canProceedAmount(): boolean {
    return !!this.accountId && !!this.merchantId && this.amountMinor() > 0;
  }

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    const [acc, merch, inst] = await Promise.all([
      this.payments.accounts(),
      this.payments.merchants().catch(() => ({ merchants: [] as Merchant[] })),
      this.payments.instruments(),
    ]);
    this.accounts.set(acc.accounts);
    this.merchants.set(merch.merchants);
    this.instruments.set(inst);
    if (acc.accounts[0]) this.accountId = acc.accounts[0].account_id;
    if (merch.merchants[0]) this.merchantId = merch.merchants[0].merchant_id;
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      const payment = await this.payments.createPayment(
        {
          account_id: this.accountId,
          merchant_id: this.merchantId,
          instrument_id: this.instrumentId,
          amount: { amount_minor_units: this.amountMinor(), currency_code: this.selectedCurrency() },
        },
        idempotencyKey,
      );
      this.step.set('processing');
      this.animate();
      this.watch(payment.id);
    } catch (e: unknown) {
      const status = (e as { status?: number }).status;
      this.error.set(
        status === 402 ? 'Insufficient funds.' :
        status === 403 ? 'Blocked by fraud screening.' :
        status === 422 ? 'Duplicate request.' :
        'Could not start the payment. Please try again.',
      );
    } finally {
      this.busy.set(false);
    }
  }

  private animate(): void {
    const timer = setInterval(() => {
      this.pulse.set((this.pulse() + 1) % 3);
      if (this.step() !== 'processing') clearInterval(timer);
    }, 400);
  }

  /** Watch the PaymentIntent-style lifecycle via SSE, with a polling fallback. */
  private watch(paymentId: string): void {
    const labels: Record<string, string> = {
      requested: 'submitting payment…',
      fraud_screened: 'fraud check passed…',
      funds_held: 'funds held…',
      submitted_to_gateway: 'contacting the processor…',
      captured: 'capturing funds…',
      recorded: 'recording transaction…',
    };

    let settled = false;
    const finish = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      const final = await this.payments.payment(paymentId).catch(() => null);
      if (final) this.result.set(final);
      this.step.set('done');
    };

    const es = new EventSource(`${this.base}/payments/${paymentId}/events`, { withCredentials: true });
    es.addEventListener('status', (ev: MessageEvent) => {
      try {
        const u = JSON.parse(ev.data) as { status: PaymentStatus; step: string };
        this.currentStep.set(labels[u.step] ?? u.step);
        this.statusLabel.set(u.status);
        if (u.status !== 'processing') {
          es.close();
          void finish();
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    es.onerror = () => {
      es.close();
      // Fallback: poll until terminal.
      const poll = setInterval(async () => {
        const p = await this.payments.payment(paymentId).catch(() => null);
        if (p && p.status !== 'processing') {
          clearInterval(poll);
          this.result.set(p);
          this.step.set('done');
        }
      }, 1500);
    };
  }

  reset(): void {
    this.result.set(null);
    this.amountMajor = null;
    this.step.set('amount');
    void this.load();
  }
}
