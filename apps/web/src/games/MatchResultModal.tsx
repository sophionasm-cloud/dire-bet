import type { TranslationKey } from '../i18n';

type Translator = (key: TranslationKey) => string;

export type MatchResultModalProps = {
  isOpen: boolean;
  isWinner: boolean;
  isDraw: boolean;
  playerName: string;
  entryCredits: number;
  payoutCredits?: number;
  onExit: () => void;
  t: Translator;
};

export function MatchResultModal({
  isOpen,
  isWinner,
  isDraw,
  playerName,
  entryCredits,
  payoutCredits,
  onExit,
  t,
}: MatchResultModalProps) {
  if (!isOpen) return null;

  const winAmount = payoutCredits || (entryCredits > 0 ? Math.round(entryCredits * 2 * 0.9) : 0);
  const currency = t('etb');

  const headline = isWinner
    ? t('matchWonMessage')
        .replace('{name}', playerName)
        .replace('{amount}', String(winAmount))
        .replace('{currency}', currency)
    : isDraw
    ? t('matchDrawMessage')
    : entryCredits > 0
    ? t('matchLostMessage')
        .replace('{name}', playerName)
        .replace('{amount}', String(entryCredits))
        .replace('{currency}', currency)
    : t('matchLostNoStakeMessage').replace('{name}', playerName);

  const subtext = isWinner
    ? (winAmount > 0 ? t('matchWinningsCredited') : t('matchBetterLuck'))
    : isDraw
    ? (entryCredits > 0
        ? t('matchEntryRefunded').replace('{amount}', String(entryCredits)).replace('{currency}', currency)
        : t('matchDrawMessage'))
    : t('matchBetterLuck');

  return (
    <div className="match-result-overlay" role="dialog" aria-modal="true" aria-labelledby="match-result-title">
      <div className={`match-result-card ${isWinner ? 'winner-card' : isDraw ? 'draw-card' : 'loser-card'}`}>
        <div className="result-animation-badge">
          {isWinner ? (
            <div className="victory-icon-wrap" aria-hidden="true">
              <span className="trophy-bounce">🏆</span>
            </div>
          ) : isDraw ? (
            <div className="draw-icon-wrap" aria-hidden="true">
              <span>🤝</span>
            </div>
          ) : (
            <div className="defeat-icon-wrap" aria-hidden="true">
              <span className="defeat-mark">✕</span>
            </div>
          )}
        </div>

        <div className="result-content-body">
          <span className={`result-status-tag ${isWinner ? 'tag-win' : isDraw ? 'tag-draw' : 'tag-loss'}`}>
            {isWinner ? t('matchResultVictory') : isDraw ? t('matchResultDraw') : t('matchResultDefeat')}
          </span>

          <h2 id="match-result-title" className="result-headline">
            {headline}
          </h2>

          <p className="result-subtext">
            {subtext}
          </p>
        </div>

        <div className="result-actions">
          <button type="button" className="primary-button wide result-leave-btn" onClick={onExit}>
            {t('home')} ↗
          </button>
        </div>
      </div>
    </div>
  );
}
