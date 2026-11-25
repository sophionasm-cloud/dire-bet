import { useEffect, useRef, useState, type ReactNode } from 'react';

export function useLudoTurnClock(resetKey: string, turnDeadline: number | null = null, serverTime: number | null = null, active = true): number {
  const [seconds, setSeconds] = useState(30);
  useEffect(() => {
    if (!active) return;
    const remaining = turnDeadline && serverTime ? Math.max(0, turnDeadline - serverTime) : 30_000;
    const end = Date.now() + remaining;
    const tick = () => setSeconds(Math.max(0, Math.ceil((end - Date.now()) / 1000)));
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [resetKey, turnDeadline, serverTime, active]);
  return seconds;
}

const PIPS: Record<number, number[]> = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8], 6: [0, 3, 6, 2, 5, 8],
};

function DieFace({ value, side }: { value: number; side: string }) {
  return <span className={`ludo-die-face ${side}`} aria-hidden="true"><i className="ludo-die-pips">{Array.from({ length: 9 }, (_, index) => <i key={index} className={PIPS[value].includes(index) ? 'pip' : ''}/>)}</i></span>;
}

export function LudoDie({ value, rollVersion, color, canRoll, onRoll, rollLabel, statusLabel, rightSlot, reducedMotion = false }: {
  value: number | null;
  rollVersion: number;
  color: 'red' | 'yellow' | 'green' | 'blue';
  canRoll: boolean;
  onRoll: () => void;
  rollLabel: string;
  statusLabel?: string;
  rightSlot?: ReactNode;
  reducedMotion?: boolean;
}) {
  const [rolling, setRolling] = useState(false);
  const previousRoll = useRef(rollVersion);
  const localRollAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  const startRolling = () => {
    window.clearTimeout(timer.current);
    setRolling(true);
    timer.current = window.setTimeout(() => setRolling(false), reducedMotion ? 80 : 920);
  };

  useEffect(() => {
    if (rollVersion === previousRoll.current) return;
    previousRoll.current = rollVersion;
    if (Date.now() - localRollAt.current < 450) return;
    startRolling();
  }, [rollVersion]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const handleRollClick = () => {
    if (!canRoll || rolling) return;
    localRollAt.current = Date.now();
    startRolling();
    onRoll();
  };

  return (
    <div className="ludo-bottom-bar">
      <div className="ludo-bottom-brand" aria-hidden="true">
        <span className="ludo-brand-crown">♛</span>
        <strong>DIRE <b>BET</b></strong>
      </div>

      <div
        className={`ludo-dice-stage ${color} ${canRoll ? 'interactive' : ''} ${rolling ? 'rolling' : ''} ${reducedMotion ? 'reduced' : ''}`}
        role="button"
        tabIndex={canRoll ? 0 : -1}
        aria-label={value === null ? 'Dice ready to roll' : `Dice showing ${value}`}
        onClick={handleRollClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleRollClick();
          }
        }}
      >
        <div className="ludo-die-scene">
          <div className="ludo-die-cube" data-value={value ?? 1}>
            <DieFace value={1} side="front" />
            <DieFace value={6} side="back" />
            <DieFace value={3} side="right" />
            <DieFace value={4} side="left" />
            <DieFace value={2} side="top" />
            <DieFace value={5} side="bottom" />
          </div>
        </div>
        <div className="ludo-dice-glow-ring" aria-hidden="true" />
      </div>

      <div className="ludo-bottom-action">
        {canRoll ? (
          <button className="ludo-roll-button" disabled={rolling} onClick={handleRollClick}>
            <span>⚄</span>
            {rolling ? '…' : rollLabel}
          </button>
        ) : rightSlot ? (
          rightSlot
        ) : (
          <div className="ludo-status-pill" role="status">
            {rolling ? 'Rolling...' : statusLabel || (value !== null ? `Rolled ${value}` : 'Waiting...')}
          </div>
        )}
      </div>
    </div>
  );
}
