import { InjectionToken } from '@angular/core';

/** Runtime config; overridable at deploy time. Base URL includes the dev port. */
export interface AppConfig {
  apiBaseUrl: string;
}

export const APP_CONFIG = new InjectionToken<AppConfig>('APP_CONFIG', {
  providedIn: 'root',
  factory: (): AppConfig => ({
    apiBaseUrl: (globalThis as { __PEIKON_API__?: string }).__PEIKON_API__ ?? 'http://api.localhost:9080',
  }),
});
