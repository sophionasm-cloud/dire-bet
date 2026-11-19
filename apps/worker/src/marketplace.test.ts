import { describe, expect, it } from 'vitest';
import { calculateSettlement, DEFAULT_MARKETPLACE_SETTINGS, parseEntryChoice, parseLudoRoomOptions, validateMarketplaceSettings } from './marketplace';

describe('public room entry rules', () => {
  it.each([10, 20, 30, 50, 100, 200, 300, 400, 500, 700, 1000, 2000, 3000, 5000, 7000, 10000])('accepts standard entry %i ETB', (amount) => {
    expect(parseEntryChoice({ kind: 'standard', amount }, DEFAULT_MARKETPLACE_SETTINGS)).toBe(amount);
  });

  it('accepts a whole-credit custom amount above 100 within the configured cap', () => {
    expect(parseEntryChoice({ kind: 'custom', amount: 150 }, DEFAULT_MARKETPLACE_SETTINGS)).toBe(150);
  });

  it.each([0, -1, 10.5, 100, 1001, '150'])('rejects invalid custom amount %s', (amount) => {
    expect(parseEntryChoice({ kind: 'custom', amount }, DEFAULT_MARKETPLACE_SETTINGS)).toBeNull();
  });

  it('does not allow an unlisted amount to claim the standard category', () => {
    expect(parseEntryChoice({ kind: 'standard', amount: 150 }, DEFAULT_MARKETPLACE_SETTINGS)).toBeNull();
  });

  it('allows FREE without reserving wallet funds', () => {
    expect(parseEntryChoice({ kind: 'free' }, DEFAULT_MARKETPLACE_SETTINGS)).toBe(0);
  });

  it('uses a 30-second default and supports the full published stake list', () => {
    expect(DEFAULT_MARKETPLACE_SETTINGS.waitingSeconds).toBe(30);
    expect(DEFAULT_MARKETPLACE_SETTINGS.standardAmounts).toContain(10000);
  });

  it('accepts only the supported Ludo color and crown choices', () => {
    expect(parseLudoRoomOptions({})).toEqual({ player0Color: 'red', crownTarget: 4 });
    expect(parseLudoRoomOptions({ player0Color: 'green', crownTarget: 2 })).toEqual({ player0Color: 'green', crownTarget: 2 });
    expect(parseLudoRoomOptions({ player0Color: 'blue', crownTarget: 1 })).toEqual({ player0Color: 'red', crownTarget: 1 });
    expect(parseLudoRoomOptions({ player0Color: 'green', crownTarget: 3 })).toBeNull();
  });

  it('calculates real money in ETB tenths and santim conversion units', () => {
    expect(calculateSettlement(50, 2, 0)).toEqual({ poolTenths: 1000, feeTenths: 0, payoutTenths: 1000, perWinnerTenths: 500 });
    expect(calculateSettlement(50, 2, 1000).payoutTenths * 10).toBe(9_000);
  });

  it('calculates a commission only once from the complete pool', () => {
    expect(calculateSettlement(20, 4, 1000)).toEqual({ poolTenths: 800, feeTenths: 80, payoutTenths: 720, perWinnerTenths: 180 });
  });

  it('rejects malformed administrator settings', () => {
    expect(validateMarketplaceSettings({ ...DEFAULT_MARKETPLACE_SETTINGS, commissionBps: 10001 })).toBeNull();
    expect(validateMarketplaceSettings({ ...DEFAULT_MARKETPLACE_SETTINGS, standardAmounts: [10, 10] })).toBeNull();
  });
});
