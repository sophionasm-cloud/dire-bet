type Props = {
  headline: string;
  quickLabel: string;
  onQuickPlay: () => void;
  active?: boolean;
};

const TAGLINE = 'Play Together, Win Together.';

export default function DireBetPoster({ headline, quickLabel, onQuickPlay, active = true }: Props) {
  const clean = headline.trim();
  const split = clean.lastIndexOf(' ');
  const lead = split > 0 ? clean.slice(0, split) : clean;
  const accent = split > 0 ? clean.slice(split + 1) : '';

  return <div className="dire-poster" role="group" aria-label={`${clean}. ${TAGLINE} DIRE BET Quick Play.`}>
    <span className="poster-glow" aria-hidden="true" />
    <span className="poster-grid" aria-hidden="true" />
    <div className="poster-games" aria-hidden="true">
      <span className="poster-game-tile ludo"><LudoGlyph/></span>
      <span className="poster-game-tile checkers"><CheckersGlyph/></span>
      <span className="poster-game-tile xo"><XoGlyph/></span>
    </div>
    <div className="poster-copy">
      <div className="poster-brand"><CrownGlyph/><span>DIRE <b>BET</b></span><i>✦</i></div>
      <h2 className="poster-headline"><span>{lead}</span>{accent && <em>{accent}</em>}</h2>
      <p className="poster-tagline">{TAGLINE}</p>
      <button type="button" className="poster-quick-play" onClick={onQuickPlay} tabIndex={active ? 0 : -1}>
        <span>{quickLabel}</span>
        <span className="poster-quick-arrow" aria-hidden="true">→</span>
      </button>
    </div>
  </div>;
}

function CrownGlyph() {
  return <svg viewBox="0 0 32 24" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="poster-crown-gold" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#fff3c4"/>
        <stop offset=".48" stopColor="#f0c766"/>
        <stop offset="1" stopColor="#b9842c"/>
      </linearGradient>
    </defs>
    <path d="M3.5 18.5 5.2 6.2l6 5.1L16 3l4.8 8.3 6-5.1 1.7 12.3Z" fill="url(#poster-crown-gold)" stroke="#ffe9a8" strokeWidth=".7" strokeLinejoin="round"/>
    <path d="M5 20.5h22" stroke="#e7bd63" strokeWidth="2.2" strokeLinecap="round"/>
    <circle cx="5.2" cy="4.8" r="1.5" fill="#ffe9a8"/>
    <circle cx="16" cy="2.4" r="1.5" fill="#fff3c4"/>
    <circle cx="26.8" cy="4.8" r="1.5" fill="#ffe9a8"/>
  </svg>;
}

function LudoGlyph() {
  return <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
    <rect x="1" y="1" width="38" height="38" rx="8" fill="#0a1a30" stroke="#d9b45f" strokeWidth="1.3"/>
    <rect x="4.5" y="4.5" width="14" height="14" rx="3.5" fill="#d94b4b"/>
    <rect x="21.5" y="4.5" width="14" height="14" rx="3.5" fill="#3dbb70"/>
    <rect x="4.5" y="21.5" width="14" height="14" rx="3.5" fill="#e8bf4e"/>
    <rect x="21.5" y="21.5" width="14" height="14" rx="3.5" fill="#438ee8"/>
    <path d="M16 16h8v8h-8z" fill="#f8f1df"/>
    <circle cx="9" cy="9" r="2" fill="#fff"/><circle cx="14" cy="9" r="2" fill="#fff"/>
    <circle cx="9" cy="14" r="2" fill="#fff"/><circle cx="14" cy="14" r="2" fill="#fff"/>
    <circle cx="26" cy="26" r="2" fill="#fff"/><circle cx="31" cy="26" r="2" fill="#fff"/>
    <circle cx="26" cy="31" r="2" fill="#fff"/><circle cx="31" cy="31" r="2" fill="#fff"/>
    <circle cx="9" cy="26" r="2" fill="#3a2a06"/><circle cx="14" cy="26" r="2" fill="#3a2a06"/>
    <circle cx="9" cy="31" r="2" fill="#3a2a06"/><circle cx="14" cy="31" r="2" fill="#3a2a06"/>
    <circle cx="26" cy="9" r="2" fill="#fff"/><circle cx="31" cy="9" r="2" fill="#fff"/>
    <circle cx="26" cy="14" r="2" fill="#fff"/><circle cx="31" cy="14" r="2" fill="#fff"/>
    <rect x="27" y="27" width="10" height="10" rx="2.2" fill="#f8f1df" stroke="#c9a34e" strokeWidth=".8"/>
    <circle cx="29.5" cy="29.5" r="1" fill="#7a3a2a"/><circle cx="34.5" cy="29.5" r="1" fill="#7a3a2a"/>
    <circle cx="32" cy="32" r="1" fill="#7a3a2a"/><circle cx="29.5" cy="34.5" r="1" fill="#7a3a2a"/>
    <circle cx="34.5" cy="34.5" r="1" fill="#7a3a2a"/>
  </svg>;
}

function CheckersGlyph() {
  return <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
    <defs>
      <pattern id="poster-checkers-board" width="8" height="8" patternUnits="userSpaceOnUse">
        <rect width="8" height="8" fill="#102a46"/>
        <rect width="4" height="4" fill="#1f4268"/>
        <rect x="4" y="4" width="4" height="4" fill="#1f4268"/>
      </pattern>
      <radialGradient id="poster-checker-red" cx="35%" cy="30%" r="75%">
        <stop offset="0" stopColor="#ff8a7d"/>
        <stop offset=".45" stopColor="#d94b4b"/>
        <stop offset="1" stopColor="#8f2323"/>
      </radialGradient>
      <radialGradient id="poster-checker-gold" cx="35%" cy="30%" r="75%">
        <stop offset="0" stopColor="#fff0b8"/>
        <stop offset=".5" stopColor="#e8bf4e"/>
        <stop offset="1" stopColor="#9c6c1d"/>
      </radialGradient>
    </defs>
    <rect x="2" y="2" width="36" height="36" rx="6" fill="#08182c" stroke="#d9b45f" strokeWidth="1.2"/>
    <rect x="4.5" y="4.5" width="31" height="31" rx="2.5" fill="url(#poster-checkers-board)"/>
    <circle cx="12" cy="12" r="5" fill="url(#poster-checker-red)" stroke="#ffb0a0" strokeWidth=".7"/>
    <circle cx="20" cy="12" r="5" fill="url(#poster-checker-red)" stroke="#ffb0a0" strokeWidth=".7"/>
    <circle cx="28" cy="20" r="5" fill="url(#poster-checker-gold)" stroke="#fff0b8" strokeWidth=".7"/>
    <circle cx="12" cy="28" r="5" fill="url(#poster-checker-gold)" stroke="#fff0b8" strokeWidth=".7"/>
    <circle cx="20" cy="28" r="5" fill="url(#poster-checker-red)" stroke="#ffb0a0" strokeWidth=".7"/>
    <circle cx="28" cy="12" r="5" fill="url(#poster-checker-gold)" stroke="#fff0b8" strokeWidth=".7"/>
  </svg>;
}

function XoGlyph() {
  return <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
    <rect x="2" y="2" width="36" height="36" rx="7" fill="#08182c" stroke="#d9b45f" strokeWidth="1.2"/>
    <path d="M14.7 4v32M25.3 4v32M4 14.7h32M4 25.3h32" stroke="#2b5d92" strokeWidth="1"/>
    <path d="m8 8 6 6m0-6-6 6" stroke="#f0c766" strokeWidth="2.5" strokeLinecap="round"/>
    <circle cx="27.5" cy="11" r="3.4" fill="none" stroke="#54b8ff" strokeWidth="2.2"/>
    <path d="m22 22 6 6m0-6-6 6" stroke="#f0c766" strokeWidth="2.5" strokeLinecap="round"/>
    <circle cx="10.5" cy="29.5" r="3.4" fill="none" stroke="#54b8ff" strokeWidth="2.2"/>
  </svg>;
}
