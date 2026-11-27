export function DireBetLoading({ label }: { label: string }) {
  return (
    <div className="dire-bet-loading" role="status" aria-live="polite">
      <div className="loader" aria-hidden="true">
        <svg viewBox="0 0 100 100" className="spinner">
          <circle cx="50" cy="50" r="45" stroke="var(--accent)" strokeWidth="8" strokeDasharray="220 100" strokeLinecap="round" fill="none" />
        </svg>
      </div>
      <p className="loading-text">{label}</p>
      <span className="dire-bet-loading-brand" aria-hidden="true">DIRE BET</span>
    </div>
  );
}
