import { z } from 'zod';

export const LanguageSchema = z.enum(['en', 'am', 'so', 'om']);
export type Language = z.infer<typeof LanguageSchema>;

export const GameIdSchema = z.enum(['xo', 'ludo', 'dominoes', 'poker']);
export type GameId = z.infer<typeof GameIdSchema>;

export const PUBLIC_GAMES = [
  { id: 'ludo', title: 'Ludo', category: 'board', availability: 'playable' },
  { id: 'dominoes', title: 'Dominoes', category: 'board', availability: 'playable' },
  { id: 'poker', title: 'Texas Hold’em', category: 'cards', availability: 'playable' },
  { id: 'xo', title: 'XO', category: 'quick', availability: 'playable' },
  { id: 'ethiopian-41', title: 'Ethiopian 41', category: 'cards', availability: 'unavailable' },
] as const;

export const TelegramAuthRequestSchema = z.object({
  initData: z.string().min(1).max(10_000),
}).strict();

export const ApiErrorSchema = z.object({ error: z.string() });

export type ApiError = z.infer<typeof ApiErrorSchema>;
