import { config } from '../../config';
import { judge0Driver } from './judge0';
import { localDriver } from './local';
import type { Driver } from './types';

export const driver: Driver = config.runner === 'judge0' ? judge0Driver : localDriver;

let healthCache: { at: number; value: { ok: boolean; detail: string } } | null = null;
export async function runnerHealth(force = false) {
  if (!force && healthCache && Date.now() - healthCache.at < 30_000) return healthCache.value;
  const value = await driver.health();
  healthCache = { at: Date.now(), value };
  return value;
}

export * from './types';
