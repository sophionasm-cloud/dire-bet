export type EntryChoice = { kind: 'free' } | { kind: 'standard' | 'custom'; amount: number };
export type MarketplaceSettings = {
  standardAmounts: number[];
  customEnabled: boolean;
  customMaximum: number;
  commissionBps: number;
  waitingSeconds: number;
  startingCredits: number;
};

export type DemoSettlement = {
  poolTenths: number;
  feeTenths: number;
  payoutTenths: number;
  perWinnerTenths: number;
};

export const DEFAULT_MARKETPLACE_SETTINGS: MarketplaceSettings = {
  standardAmounts: [10, 20, 50, 100],
  customEnabled: true,
  customMaximum: 1000,
  commissionBps: 1000,
  waitingSeconds: 60,
  startingCredits: 1000,
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

export function calculateDemoSettlement(entryCredits: number, playerCount: number, commissionBps: number): DemoSettlement {
  if (!Number.isSafeInteger(entryCredits) || entryCredits < 0) throw new Error('Entry credits must be a non-negative whole number.');
  if (!Number.isSafeInteger(playerCount) || playerCount < 2 || playerCount > 9) throw new Error('Player count must be between two and nine.');
  if (!Number.isSafeInteger(commissionBps) || commissionBps < 0 || commissionBps > 5000) throw new Error('Commission rate is outside the allowed range.');
  const poolTenths = entryCredits * playerCount * 10;
  const feeTenths = Math.floor((poolTenths * commissionBps) / 10_000);
  const payoutTenths = poolTenths - feeTenths;
  return { poolTenths, feeTenths, payoutTenths, perWinnerTenths: Math.floor(payoutTenths / playerCount) };
}

export function validateMarketplaceSettings(input: unknown): MarketplaceSettings | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Partial<MarketplaceSettings>;
  const amounts = value.standardAmounts;
  if (!Array.isArray(amounts) || amounts.length < 1 || amounts.length > 8 || amounts.some((item) => !Number.isSafeInteger(item) || item <= 0 || item > 1000)) return null;
  if (new Set(amounts).size !== amounts.length) return null;
  if (typeof value.customEnabled !== 'boolean' || !Number.isSafeInteger(value.customMaximum) || (value.customMaximum as number) < 101 || (value.customMaximum as number) > 100_000) return null;
  if (!Number.isSafeInteger(value.commissionBps) || (value.commissionBps as number) < 0 || (value.commissionBps as number) > 5000) return null;
  if (!Number.isSafeInteger(value.waitingSeconds) || (value.waitingSeconds as number) < 15 || (value.waitingSeconds as number) > 180) return null;
  if (!Number.isSafeInteger(value.startingCredits) || (value.startingCredits as number) < 100 || (value.startingCredits as number) > 100_000) return null;
  return {
    standardAmounts: [...amounts].sort((a, b) => a - b),
    customEnabled: value.customEnabled,
    customMaximum: value.customMaximum as number,
    commissionBps: value.commissionBps as number,
    waitingSeconds: value.waitingSeconds as number,
    startingCredits: value.startingCredits as number,
  };
}

export function isMarketplaceGame(gameId: unknown): gameId is 'xo' | 'ludo' | 'dominoes' | 'poker' {
  return gameId === 'xo' || gameId === 'ludo' || gameId === 'dominoes' || gameId === 'poker';
}
