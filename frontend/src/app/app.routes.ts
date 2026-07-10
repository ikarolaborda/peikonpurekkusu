import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  {
    path: 'auth',
    loadComponent: () => import('./views/auth.component').then((m) => m.AuthComponent),
  },
  {
    path: '',
    loadComponent: () => import('./views/shell.component').then((m) => m.ShellComponent),
    canActivate: [authGuard],
    children: [
      { path: 'dashboard', loadComponent: () => import('./views/dashboard.component').then((m) => m.DashboardComponent) },
      { path: 'pay', loadComponent: () => import('./views/pay.component').then((m) => m.PayComponent) },
      { path: 'transactions', loadComponent: () => import('./views/transactions.component').then((m) => m.TransactionsComponent) },
      { path: 'notifications', loadComponent: () => import('./views/notifications.component').then((m) => m.NotificationsComponent) },
      { path: 'security', loadComponent: () => import('./views/security.component').then((m) => m.SecurityComponent) },
    ],
  },
  { path: '**', redirectTo: 'dashboard' },
];
