import { MoneyPipe } from './money.pipe';

describe('MoneyPipe', () => {
  const pipe = new MoneyPipe();

  it('formats 2-decimal currencies from minor units', () => {
    expect(pipe.transform(1250, 'USD')).toBe('12.50');
    expect(pipe.transform(100000, 'EUR')).toBe('1,000.00');
  });

  it('never divides a zero-decimal currency (the JPY bug)', () => {
    expect(pipe.transform(1250, 'JPY')).toBe('1,250');
    expect(pipe.transform(50000, 'JPY')).toBe('50,000');
  });

  it('handles 3-decimal currencies', () => {
    expect(pipe.transform(1250, 'BHD')).toBe('1.250');
  });

  it('renders a dash for missing amounts', () => {
    expect(pipe.transform(null)).toBe('—');
    expect(pipe.transform(undefined)).toBe('—');
  });
});
