import { TemplateRegistry } from './templates';

describe('TemplateRegistry', () => {
  const registry = new TemplateRegistry();

  it('interpolates params into a known template', () => {
    const r = registry.render('payment_captured', { amount: '12.50', currency: 'USD', merchant: 'Kissaten Koffie' });
    expect(r.title).toBe('Payment successful');
    expect(r.body).toBe('Your payment of 12.50 USD to Kissaten Koffie was captured.');
  });

  it('leaves unresolved placeholders visible rather than blanking them', () => {
    const r = registry.render('payment_failed', { amount: '9.99', currency: 'USD' });
    expect(r.body).toContain('{{reason}}');
  });

  it('falls back gracefully for an unknown template', () => {
    const r = registry.render('nope', { a: 1 });
    expect(r.title).toBe('Notification');
  });
});
