/**
 * Конвертация валют по курсу ЦБ РФ (RUB <-> USD).
 * Курс кешируется на 1 день.
 */
import { CBR_URL } from './config.ts';

interface CbrResponse {
  Date: string;
  Valute: {
    USD: { Nominal: number; Value: number };
  };
}

let cachedRate: number | null = null; // RUB за 1 USD
let cachedAt = 0;
const DAY_MS = 24 * 60 * 60 * 1000;

async function fetchUsdRubRate(): Promise<number> {
  const now = Date.now();
  if (cachedRate !== null && now - cachedAt < DAY_MS) return cachedRate;

  const res = await fetch(CBR_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`CBR HTTP ${res.status}`);
  const data = (await res.json()) as CbrResponse;
  const usd = data.Valute?.USD;
  if (!usd || !usd.Value) throw new Error('CBR: нет курса USD');

  cachedRate = usd.Value / usd.Nominal; // RUB за 1 USD
  cachedAt = now;
  return cachedRate;
}

export type Currency = 'USD' | 'RUB';

/** Распознать сумму вида "1000", "1000₽", "1000 руб", "10$", "10 USD", "-500". Без суффикса — RUB. */
export function parseAmount(raw: string): { amount: number; currency: Currency } | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  let currency: Currency = 'RUB';
  let numPart = s;
  if (s.includes('$') || s.includes('usd')) {
    currency = 'USD';
    numPart = s.replace(/[$]/g, '').replace(/usd/g, '');
  } else if (s.includes('₽') || s.includes('руб') || s.includes('rub')) {
    currency = 'RUB';
    numPart = s.replace(/₽/g, '').replace(/руб/g, '').replace(/rub/g, '');
  }

  const amount = parseFloat(numPart.replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(amount)) return null;
  return { amount, currency };
}

/** Сконвертировать сумму в USD. */
export async function convertToUsd(amount: number, currency: Currency): Promise<number> {
  if (currency === 'USD') return amount;
  const rate = await fetchUsdRubRate();
  return amount / rate;
}

/** Для отображения: текущий курс RUB/USD. */
export async function getUsdRubRate(): Promise<number> {
  return fetchUsdRubRate();
}
