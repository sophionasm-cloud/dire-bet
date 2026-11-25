import { describe, expect, it } from 'vitest';
import {
  calculateSettlement,
  DEFAULT_MARKETPLACE_SETTINGS,
  gameRoomWalletKind,
  isCancelledOrExpiredRoom,
  isCreatorCancellableRoom,
  isFundedWalletKind,
  MATCHMAKING_WAITING_SECONDS,
  parseEntryChoice,
  parseLudoRoomOptions,
  validateMarketplaceSettings,
} from './marketplace';

describe('public room entry rules', () => {
  it.each([10, 30, 50, 100, 200, 300, 500])('accepts standard entry %i ETB', (amount) => {
    expect(parseEntryChoice({ kind: 'standard', amount }, DEFAULT_MARKETPLACE_SETTINGS)).toBe(amount);
  });

  it.each([20, 400, 700, 1000, 2000, 3000, 5000, 7000, 10000])('rejects removed standard entry %i ETB', (amount) => {
    expect(parseEntryChoice({ kind: 'standard', amount }, DEFAULT_MARKETPLACE_SETTINGS)).toBeNull();
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

  it('uses a 30-second default and supports the published stake list', () => {
    expect(DEFAULT_MARKETPLACE_SETTINGS.waitingSeconds).toBe(30);
    expect(DEFAULT_MARKETPLACE_SETTINGS.standardAmounts).toEqual([10, 30, 50, 100, 200, 300, 500]);
  });

  it('accepts only the supported Ludo color and crown choices', () => {
    expect(parseLudoRoomOptions({})).toEqual({ player0Color: 'red', crownTarget: 4 });
    expect(parseLudoRoomOptions({ player0Color: 'green', crownTarget: 2 })).toEqual({ player0Color: 'green', crownTarget: 2 });
    expect(parseLudoRoomOptions({ player0Color: 'blue', crownTarget: 1 })).toEqual({ player0Color: 'red', crownTarget: 1 });
    expect(parseLudoRoomOptions({ player0Color: 'green', crownTarget: 3 })).toBeNull();
  });

  it('calculates real money in ETB tenths and santim conversion units', () => {
    expect(calculateSettlement(50, 2)).toEqual({ poolTenths: 1000, payoutTenths: 900, perWinnerTenths: 450 });
    expect(calculateSettlement(100, 2)).toEqual({ poolTenths: 2000, payoutTenths: 1800, perWinnerTenths: 900 });
  });

  it('ignores historical commission settings', () => {
    expect(validateMarketplaceSettings({ ...DEFAULT_MARKETPLACE_SETTINGS, commissionBps: 100 })).toEqual(DEFAULT_MARKETPLACE_SETTINGS);
    expect(validateMarketplaceSettings({ ...DEFAULT_MARKETPLACE_SETTINGS, standardAmounts: [10, 10] })).toBeNull();
  });

  it('always normalizes the matchmaking wait to exactly 30 seconds', () => {
    expect(MATCHMAKING_WAITING_SECONDS).toBe(30);
    expect(validateMarketplaceSettings({ ...DEFAULT_MARKETPLACE_SETTINGS, waitingSeconds: 120 })?.waitingSeconds).toBe(30);
  });

  it('lets creators cancel only before a match starts', () => {
    expect(isCreatorCancellableRoom('WAITING')).toBe(true);
    expect(isCreatorCancellableRoom('FULL')).toBe(true);
    expect(isCreatorCancellableRoom('STARTING')).toBe(true);
    expect(isCreatorCancellableRoom('IN_PROGRESS')).toBe(false);
    expect(isCreatorCancellableRoom('SETTLING')).toBe(false);
    expect(isCreatorCancellableRoom('COMPLETED')).toBe(false);
  });

  it('maps demo rooms to free game_rooms rows while preserving real stakes', () => {
    expect(gameRoomWalletKind('demo')).toBe('free');
    expect(gameRoomWalletKind('free')).toBe('free');
    expect(gameRoomWalletKind('real')).toBe('real');
  });

  it('treats both demo and real rooms as wallet-funded', () => {
    expect(isFundedWalletKind('demo')).toBe(true);
    expect(isFundedWalletKind('real')).toBe(true);
    expect(isFundedWalletKind('free')).toBe(false);
  });

  it('only resets idempotency entries for cancelled or expired rooms', () => {
    expect(isCancelledOrExpiredRoom('CANCELLED')).toBe(true);
    expect(isCancelledOrExpiredRoom('EXPIRED')).toBe(true);
    expect(isCancelledOrExpiredRoom('WAITING')).toBe(false);
    expect(isCancelledOrExpiredRoom('IN_PROGRESS')).toBe(false);
  });
});
