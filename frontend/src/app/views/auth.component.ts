import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { SessionStore } from '../core/session.store';

/**
 * Login + register. On success the session store holds only the CSRF token;
 * tokens are httpOnly cookies. A stable device fingerprint is sent so the
 * backend can bind the session (refresh from a new device forces re-auth).
 */
@Component({
  selector: 'peikon-auth',
  imports: [FormsModule],
  template: `
    <div class="min-h-screen flex items-center justify-center px-4">
      <div class="w-full max-w-sm">
        <div class="mb-8 text-center">
          <div class="font-bold text-2xl tracking-tight">
            peikon<span style="color: var(--color-accent-500)">purekkusu</span>
          </div>
          <p class="text-sm mt-1" style="color: var(--color-text-muted)">
            {{ mode() === 'login' ? 'Sign in to your account' : 'Create your account' }}
          </p>
        </div>

        <div class="card p-6 space-y-4">
          @if (mode() === 'register') {
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="label" for="fn">First name</label>
                <input id="fn" class="input" [(ngModel)]="firstName" autocomplete="given-name" />
              </div>
              <div>
                <label class="label" for="ln">Last name</label>
                <input id="ln" class="input" [(ngModel)]="lastName" autocomplete="family-name" />
              </div>
            </div>
          }
          <div>
            <label class="label" for="email">Email</label>
            <input id="email" class="input" type="email" [(ngModel)]="email" autocomplete="email" />
          </div>
          <div>
            <label class="label" for="pw">Password</label>
            <input id="pw" class="input" type="password" [(ngModel)]="password" autocomplete="current-password" />
          </div>

          @if (error()) {
            <div class="text-sm px-3 py-2 border" style="color: var(--color-danger-500); border-color: var(--color-danger-600)">
              {{ error() }}
            </div>
          }

          <button class="btn btn-accent w-full" [disabled]="busy()" (click)="submit()">
            {{ busy() ? '…' : mode() === 'login' ? 'Sign in' : 'Create account' }}
          </button>

          <button class="btn w-full text-sm" (click)="toggleMode()">
            {{ mode() === 'login' ? 'Need an account? Register' : 'Have an account? Sign in' }}
          </button>
        </div>

        <p class="text-xs text-center mt-4" style="color: var(--color-text-dim)">
          Tokens never touch the browser — httpOnly cookies + CSRF only.
        </p>
      </div>
    </div>
  `,
})
export class AuthComponent {
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);

  readonly mode = signal<'login' | 'register'>('login');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  email = '';
  password = '';
  firstName = '';
  lastName = '';

  toggleMode(): void {
    this.mode.set(this.mode() === 'login' ? 'register' : 'login');
    this.error.set(null);
  }

  private fingerprint(): string {
    const key = 'peikon-fp';
    let fp = localStorage.getItem(key);
    if (!fp) {
      fp = `${navigator.userAgent}|${screen.width}x${screen.height}|${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
      localStorage.setItem(key, fp);
    }
    return fp;
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      if (this.mode() === 'register') {
        await this.session.register({
          email: this.email,
          password: this.password,
          first_name: this.firstName,
          last_name: this.lastName,
        });
      }
      await this.session.login(this.email, this.password, this.fingerprint());
      await this.router.navigate(['/dashboard']);
    } catch (e: unknown) {
      const status = (e as { status?: number }).status;
      this.error.set(
        status === 401
          ? 'Invalid email or password.'
          : status === 409
            ? 'That email is already registered.'
            : this.mode() === 'register'
              ? 'Registration failed. Password must be at least 12 characters.'
              : 'Sign in failed. Please try again.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}
