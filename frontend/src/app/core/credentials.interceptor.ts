import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { SessionStore } from './session.store';

/**
 * Attaches credentials to every API call: cookies via withCredentials, and the
 * in-memory CSRF token on mutating methods (double-submit). The SPA never
 * handles access/refresh tokens directly.
 */
export const credentialsInterceptor: HttpInterceptorFn = (req, next) => {
  const session = inject(SessionStore);
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const csrf = session.csrf();

  const headers = mutating && csrf ? req.headers.set('X-CSRF-Token', csrf) : req.headers;
  return next(req.clone({ withCredentials: true, headers }));
};
