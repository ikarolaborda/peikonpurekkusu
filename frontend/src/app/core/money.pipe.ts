import { Pipe, PipeTransform } from '@angular/core';

/** ISO-4217 currencies with a non-2 minor-unit exponent. */
const EXPONENT: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
};

/**
 * Formats integer minor units as a human amount, honoring the currency's
 * exponent — so 1250 USD → "12.50" but 1250 JPY → "1,250" (never /100 a
 * zero-decimal currency, the classic payments bug).
 */
@Pipe({ name: 'money' })
export class MoneyPipe implements PipeTransform {
  transform(minorUnits: number | null | undefined, currency = 'USD'): string {
    if (minorUnits === null || minorUnits === undefined) return '—';
    const exp = EXPONENT[currency] ?? 2;
    const major = minorUnits / 10 ** exp;
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: exp,
      maximumFractionDigits: exp,
    }).format(major);
  }
}
