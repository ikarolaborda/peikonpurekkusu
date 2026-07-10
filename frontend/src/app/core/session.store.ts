import { computed, inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG } from './api';
import type { UserProfile } from './models';

/**
 * Session state. The CSRF token is the ONLY auth material JS ever holds — it
 * lives in memory (a signal), never localStorage. Access/refresh tokens are
 * httpOnly cookies the browser attaches automatically (withCredentials); the
 * SPA can neither read nor set them.
 */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly http = inject(HttpClient);
  private readonly base = inject(APP_CONFIG).apiBaseUrl;

  private readonly _csrf = signal<string | null>(null);
  private readonly _profile = signal<UserProfile | null>(null);
  private readonly _mfaRequired = signal(false);

  readonly csrf = this._csrf.asReadonly();
  readonly profile = this._profile.asReadonly();
  readonly mfaRequired = this._mfaRequired.asReadonly();
  readonly authenticated = computed(() => this._csrf() !== null);

  setCsrf(token: string | null): void {
    this._csrf.set(token);
  }

  async login(email: string, password: string, fingerprint: string): Promise<void> {
    const res = await firstValueFrom(
      this.http.post<{ csrf_token: string; mfa_required: boolean }>(
        `${this.base}/auth/login`,
        { email, password, device_fingerprint: fingerprint },
        { withCredentials: true },
      ),
    );
    this._csrf.set(res.csrf_token);
    this._mfaRequired.set(res.mfa_required);
    await this.loadProfile();
  }

  async register(input: { email: string; password: string; first_name: string; last_name: string }): Promise<void> {
    await firstValueFrom(this.http.post(`${this.base}/auth/register`, input, { withCredentials: true }));
  }

  async loadProfile(): Promise<void> {
    try {
      const profile = await firstValueFrom(
        this.http.get<UserProfile>(`${this.base}/users/me`, { withCredentials: true }),
      );
      this._profile.set(profile);
    } catch {
      this._profile.set(null);
    }
  }

  async logout(): Promise<void> {
    const csrf = this._csrf();
    try {
      await firstValueFrom(
        this.http.post(`${this.base}/auth/logout`, {}, {
          withCredentials: true,
          headers: csrf ? { 'X-CSRF-Token': csrf } : {},
        }),
      );
    } finally {
      this._csrf.set(null);
      this._profile.set(null);
    }
  }

  /** Attempt a silent refresh (rotates the cookie pair, returns new CSRF). */
  async refresh(): Promise<boolean> {
    try {
      const res = await firstValueFrom(
        this.http.post<{ csrf_token: string }>(`${this.base}/auth/refresh`, {}, { withCredentials: true }),
      );
      this._csrf.set(res.csrf_token);
      return true;
    } catch {
      this._csrf.set(null);
      return false;
    }
  }
}
