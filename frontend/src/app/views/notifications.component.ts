import { Component, inject, OnDestroy, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DatePipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG } from '../core/api';
import type { AppNotification } from '../core/models';

/**
 * Inbox + live SSE feed. New notifications arrive over
 * /notifications/stream (cookie-authenticated EventSource) and are prepended.
 */
@Component({
  selector: 'peikon-notifications',
  imports: [DatePipe],
  template: `
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-xl font-bold">Notifications</h1>
      <span class="badge" [style.color]="live() ? 'var(--color-success-500)' : 'var(--color-text-dim)'"
            [style.border-color]="live() ? 'var(--color-success-600)' : 'var(--color-border)'">
        {{ live() ? '● live' : '○ offline' }}
      </span>
    </div>

    @if (loading()) {
      <div class="card p-8 text-center" style="color: var(--color-text-muted)">Loading…</div>
    } @else if (items().length === 0) {
      <div class="card p-8 text-center" style="color: var(--color-text-muted)">
        Nothing yet — payments and security events show up here.
      </div>
    } @else {
      <div class="space-y-2">
        @for (n of items(); track n.id) {
          <button class="card p-4 w-full text-left flex items-start gap-3"
                  [style.opacity]="n.read_at ? '0.6' : '1'"
                  (click)="markRead(n)">
            <span class="w-2 h-2 mt-1.5 shrink-0"
                  [style.background]="n.read_at ? 'var(--color-border-strong)' : 'var(--color-accent-500)'"></span>
            <span class="flex-1">
              <span class="block font-medium">{{ n.title }}</span>
              <span class="block text-sm mt-0.5" style="color: var(--color-text-muted)">{{ n.body }}</span>
            </span>
            <span class="tabular text-xs shrink-0" style="color: var(--color-text-dim)">
              {{ n.created_at | date: 'short' }}
            </span>
          </button>
        }
      </div>
    }
  `,
})
export class NotificationsComponent implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly base = inject(APP_CONFIG).apiBaseUrl;

  readonly items = signal<AppNotification[]>([]);
  readonly loading = signal(true);
  readonly live = signal(false);
  private es: EventSource | null = null;

  constructor() {
    void this.load();
    this.subscribe();
  }

  ngOnDestroy(): void {
    this.es?.close();
  }

  private async load(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ notifications: AppNotification[] }>(`${this.base}/notifications`),
      );
      this.items.set(res.notifications);
    } finally {
      this.loading.set(false);
    }
  }

  private subscribe(): void {
    this.es = new EventSource(`${this.base}/notifications/stream`, { withCredentials: true });
    this.es.onopen = () => this.live.set(true);
    this.es.onerror = () => this.live.set(false);
    this.es.onmessage = (ev) => {
      try {
        const n = JSON.parse(ev.data) as AppNotification & { userId?: string };
        if (!n.id || !n.title) return; // heartbeat frames
        this.items.update((list) => [{ ...n, created_at: n.created_at ?? new Date().toISOString() }, ...list]);
      } catch {
        /* heartbeat / non-JSON frames */
      }
    };
  }

  async markRead(n: AppNotification): Promise<void> {
    if (n.read_at) return;
    await firstValueFrom(this.http.post(`${this.base}/notifications/${n.id}/read`, {})).catch(() => undefined);
    this.items.update((list) =>
      list.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)),
    );
  }
}
