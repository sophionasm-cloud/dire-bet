export type EntryChoice = { kind: 'free' } | { kind: 'standard' | 'custom'; amount: number };
export type LudoRoomOptions = { player0Color: 'red' | 'yellow' | 'green' | 'blue'; crownTarget: 1 | 2 | 4 };
export type PublicWalletKind = 'demo' | 'real' | 'free';

export const MATCHMAKING_WAITING_SECONDS = 90;

export function isCreatorCancellableRoom(status: string): boolean {
  return status === 'WAITING' || status === 'FULL' || status === 'STARTING';
}

export function isFundedWalletKind(walletKind: string): walletKind is 'real' | 'demo' {
  return walletKind === 'real' || walletKind === 'demo';
}

export function gameRoomWalletKind(walletKind: PublicWalletKind): 'free' | 'real' {
  return walletKind === 'real' ? 'real' : 'free';
}

export function isCancelledOrExpiredRoom(status: string): boolean {
  return status === 'CANCELLED' || status === 'EXPIRED';
}
export type MarketplaceSettings = {
  standardAmounts: number[];
  customEnabled: boolean;
  customMaximum: number;
  waitingSeconds: number;
  realMoneyEnabled: boolean;
};

export type Settlement = {
  poolTenths: number;
  payoutTenths: number;
  perWinnerTenths: number;
};

export const DEFAULT_MARKETPLACE_SETTINGS: MarketplaceSettings = {
  standardAmounts: [30, 50, 100, 200, 300, 500, 1000, 2000, 5000, 10000],
  customEnabled: true,
  customMaximum: 1000,
  waitingSeconds: 90,
  realMoneyEnabled: false,
};

export function parseEntryChoice(input: unknown, settings: MarketplaceSettings): number | null {
  if (!input || typeof input !== 'object') return null;
  const choice = input as { kind?: unknown; amount?: unknown };
  if (choice.kind === 'free') return 0;
  if ((choice.kind !== 'standard' && choice.kind !== 'custom') || !Number.isSafeInteger(choice.amount) || (choice.amount as number) <= 0) return null;
  const amount = choice.amount as number;
  if (choice.kind === 'standard' && settings.standardAmounts.includes(amount)) return amount;
  if (choice.kind === 'custom' && settings.customEnabled && amount > 100 && amount <= settings.customMaximum) return amount;
  return null;
}

export function parseLudoRoomOptions(input: unknown): LudoRoomOptions | null {
  if (!input || typeof input !== 'object') return { player0Color: 'red', crownTarget: 4 };
  const value = input as { player0Color?: unknown; crownTarget?: unknown };
  const selectedColor = value.player0Color ?? 'red';
  const player0Color = selectedColor === 'white' ? 'yellow' : selectedColor;
  if (player0Color !== 'red' && player0Color !== 'yellow' && player0Color !== 'green' && player0Color !== 'blue') return null;
  const crownTarget = value.crownTarget ?? 4;
  if (crownTarget !== 1 && crownTarget !== 2 && crownTarget !== 4) return null;
  return { player0Color, crownTarget };
}

export function calculateSettlement(entryAmount: number, playerCount: number): Settlement {
  if (!Number.isSafeInteger(entryAmount) || entryAmount < 0) throw new Error('Entry amount must be a non-negative whole number.');
  if (!Number.isSafeInteger(playerCount) || playerCount < 2 || playerCount > 9) throw new Error('Player count must be between two and nine.');
  const poolTenths = entryAmount * playerCount * 10;
  const feeTenths = Math.floor(poolTenths * 0.10);
  const payoutTenths = poolTenths - feeTenths;
  return { poolTenths, payoutTenths, perWinnerTenths: Math.floor(payoutTenths / playerCount) };
}

export function validateMarketplaceSettings(input: unknown): MarketplaceSettings | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Partial<MarketplaceSettings>;
  const amounts = value.standardAmounts;
  if (!Array.isArray(amounts) || amounts.length < 1 || amounts.length > 20 || amounts.some((item) => !Number.isSafeInteger(item) || item <= 0 || item > 10_000)) return null;
  if (new Set(amounts).size !== amounts.length) return null;
  if (typeof value.customEnabled !== 'boolean' || !Number.isSafeInteger(value.customMaximum) || (value.customMaximum as number) < 101 || (value.customMaximum as number) > 100_000) return null;
  if (!Number.isSafeInteger(value.waitingSeconds) || (value.waitingSeconds as number) < 15 || (value.waitingSeconds as number) > 180) return null;
  return {
    standardAmounts: [...amounts].sort((a, b) => a - b),
    customEnabled: value.customEnabled,
    customMaximum: value.customMaximum as number,
    waitingSeconds: MATCHMAKING_WAITING_SECONDS,
    realMoneyEnabled: false,
  };
}

export function isMarketplaceGame(gameId: unknown): gameId is 'xo' | 'ludo' | 'checkers' | 'poker' {
  return gameId === 'xo' || gameId === 'ludo' || gameId === 'checkers' || gameId === 'poker';
}
