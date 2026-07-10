import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionStore } from './session.store';

/**
 * Route guard: if there's no in-memory session, try one silent refresh
 * (the refresh cookie may still be valid after a page reload) before
 * redirecting to /auth.
 */
export const authGuard: CanActivateFn = async () => {
  const session = inject(SessionStore);
  const router = inject(Router);

  if (session.authenticated()) return true;
  if (await session.refresh()) {
    await session.loadProfile();
    return true;
  }
  return router.createUrlTree(['/auth']);
};
