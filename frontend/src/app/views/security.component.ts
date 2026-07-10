import { Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DatePipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG } from '../core/api';
import type { SessionInfo } from '../core/models';

/**
 * Security center — surfaces the token-theft protections and lets the user
 * exercise the family-wide kill switch.
 */
@Component({
  selector: 'peikon-security',
  imports: [DatePipe],
  template: `
    <h1 class="text-xl font-bold mb-6">Security</h1>

    <div class="grid gap-4 lg:grid-cols-2">
      <div class="card p-5">
        <div class="flex items-center justify-between mb-4">
          <h2 class="font-bold">Active sessions</h2>
          <button class="btn text-xs" [disabled]="busy() || sessions().length < 2" (click)="revokeOthers()">
            Revoke all others
          </button>
        </div>
        @if (loading()) {
          <p class="text-sm" style="color: var(--color-text-muted)">Loading…</p>
        } @else {
          <div class="space-y-2">
            @for (s of sessions(); track s.session_id) {
              <div class="flex items-center justify-between border px-3 py-2 text-sm" style="border-color: var(--color-border)">
                <div>
                  <span class="tabular text-xs" style="color: var(--color-text-dim)">{{ s.session_id.slice(0, 12) }}…</span>
                  @if (s.current) { <span class="badge ml-2" style="color: var(--color-success-500); border-color: var(--color-success-600)">this device</span> }
                </div>
                <div class="tabular text-xs" style="color: var(--color-text-muted)">
                  {{ s.ip || '—' }} · {{ s.created_at | date: 'short' }}
                </div>
              </div>
            }
          </div>
        }
        @if (revoked() > 0) {
          <p class="text-sm mt-3" style="color: var(--color-success-500)">✓ {{ revoked() }} session(s) revoked — their tokens are dead everywhere.</p>
        }
      </div>

      <div class="card p-5">
        <h2 class="font-bold mb-4">How your session is protected</h2>
        <ul class="space-y-3 text-sm" style="color: var(--color-text-muted)">
          <li class="flex gap-2"><span style="color: var(--color-accent-500)">▪</span>
            Tokens live in httpOnly cookies — page scripts (and XSS) can never read them.</li>
          <li class="flex gap-2"><span style="color: var(--color-accent-500)">▪</span>
            Access tokens expire after 10 minutes; sessions continue via single-use rotating refresh tokens.</li>
          <li class="flex gap-2"><span style="color: var(--color-accent-500)">▪</span>
            If a stolen refresh token is ever replayed, the whole token family is revoked instantly and you're re-authenticated.</li>
          <li class="flex gap-2"><span style="color: var(--color-accent-500)">▪</span>
            Every request is checked against a server-side revocation list — logout means logged out, everywhere.</li>
          <li class="flex gap-2"><span style="color: var(--color-accent-500)">▪</span>
            Sessions are bound to your device fingerprint; refreshing from a different context forces re-authentication.</li>
        </ul>
      </div>
    </div>
  `,
})
export class SecurityComponent {
  private readonly http = inject(HttpClient);
  private readonly base = inject(APP_CONFIG).apiBaseUrl;

  readonly sessions = signal<SessionInfo[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly revoked = signal(0);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const res = await firstValueFrom(
        this.http.get<{ sessions: SessionInfo[] }>(`${this.base}/auth/sessions`),
      );
      this.sessions.set(res.sessions);
    } finally {
      this.loading.set(false);
    }
  }

  async revokeOthers(): Promise<void> {
    this.busy.set(true);
    const before = this.sessions().length;
    try {
      await firstValueFrom(this.http.delete(`${this.base}/auth/sessions`));
      await this.load();
      this.revoked.set(Math.max(0, before - this.sessions().length));
    } finally {
      this.busy.set(false);
    }
  }
}
