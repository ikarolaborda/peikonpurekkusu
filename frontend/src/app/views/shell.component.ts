import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { SessionStore } from '../core/session.store';

@Component({
  selector: 'peikon-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="min-h-screen flex flex-col">
      <header class="border-b" style="border-color: var(--color-border)">
        <div class="max-w-6xl mx-auto px-4 flex items-center gap-6 h-14">
          <a routerLink="/dashboard" class="font-bold tracking-tight text-lg">
            peikon<span style="color: var(--color-accent-500)">purekkusu</span>
          </a>
          <nav class="flex items-center gap-1 text-sm flex-1">
            @for (item of nav; track item.path) {
              <a
                [routerLink]="item.path"
                routerLinkActive="active-nav"
                class="px-3 py-1.5 border border-transparent"
                style="color: var(--color-text-muted)"
              >{{ item.label }}</a>
            }
          </nav>
          <button class="btn text-xs" (click)="toggleTheme()" [attr.aria-label]="'Toggle theme'">
            {{ theme() === 'dark' ? '☾ dark' : '☀ light' }}
          </button>
          <div class="text-xs tabular" style="color: var(--color-text-dim)">
            {{ session.profile()?.email }}
          </div>
          <button class="btn text-xs" (click)="logout()">logout</button>
        </div>
      </header>

      <main class="flex-1 max-w-6xl w-full mx-auto px-4 py-8">
        <router-outlet />
      </main>

      <footer class="border-t text-xs px-4 py-3 text-center" style="border-color: var(--color-border); color: var(--color-text-dim)">
        peikonpurekkusu — reference payments platform · mock processors · not PCI-certified
      </footer>
    </div>

    <style>
      .active-nav {
        color: var(--color-text) !important;
        border-color: var(--color-border-strong) !important;
        background: var(--color-overlay);
      }
    </style>
  `,
})
export class ShellComponent {
  readonly session = inject(SessionStore);
  private readonly router = inject(Router);

  readonly nav = [
    { path: '/dashboard', label: 'Dashboard' },
    { path: '/pay', label: 'Send Payment' },
    { path: '/transactions', label: 'Transactions' },
    { path: '/notifications', label: 'Notifications' },
    { path: '/security', label: 'Security' },
  ];

  readonly theme = signal<'dark' | 'light'>(
    (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') ?? 'dark',
  );

  toggleTheme(): void {
    const next = this.theme() === 'dark' ? 'light' : 'dark';
    this.theme.set(next);
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('peikon-theme', next);
  }

  async logout(): Promise<void> {
    await this.session.logout();
    await this.router.navigate(['/auth']);
  }
}
