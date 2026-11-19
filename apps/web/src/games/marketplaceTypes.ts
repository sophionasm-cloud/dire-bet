import type { GameId } from '@dire-bet/shared';

export type PublicRoomStatus = 'WAITING' | 'FULL' | 'STARTING' | 'IN_PROGRESS' | 'SETTLING' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
export type MarketplaceRoom = {
  id: string;
  code: string;
  gameId: GameId;
  creatorName: string;
  creatorAvatar: string;
  players: { name: string; avatar: string; seat: number }[];
  playerCount: number;
  capacity: number;
  entryCredits: number;
  poolCredits: number;
  feeCredits: number;
  payoutCredits: number;
  commissionBps: number;
  mode: string;
  options: Record<string, unknown>;
  status: PublicRoomStatus;
  createdAt: number;
  expiresAt: number;
  matchId: string | null;
  winner: number | null;
  walletKind: 'demo' | 'real' | 'free';
  viewerSeat?: number;
  viewerIsCreator?: boolean;
};

export type MarketplaceSettings = {
  standardAmounts: number[];
  customEnabled: boolean;
  customMaximum: number;
  commissionBps: number;
  waitingSeconds: number;
  realMoneyEnabled?: boolean;
};

export type RoomConfig = { code: string; ticket: string; gameId: GameId; publicRoom?: MarketplaceRoom };
