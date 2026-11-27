import { useEffect, useState } from 'react';

/**
 * Renders a Telegram profile photo with an optional secondary photo URL and
 * gracefully falls back to the player's letter initial only if no photo loads.
 */
export function PlayerAvatar({
  src,
  fallbackSrc,
  fallback,
  alt = '',
}: {
  src?: string | null;
  fallbackSrc?: string | null;
  fallback: string;
  alt?: string;
}) {
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  useEffect(() => {
    setFailedUrls([]);
  }, [src, fallbackSrc]);

  const primary = src?.trim() || '';
  const secondary = fallbackSrc?.trim() || '';
  const activeSrc =
    primary && !failedUrls.includes(primary)
      ? primary
      : secondary && !failedUrls.includes(secondary)
        ? secondary
        : '';

  if (activeSrc) {
    return (
      <img
        className="avatar-photo"
        src={activeSrc}
        alt={alt}
        referrerPolicy="no-referrer"
        onError={() => setFailedUrls((prev) => (prev.includes(activeSrc) ? prev : [...prev, activeSrc]))}
      />
    );
  }

  return <span>{fallback}</span>;
}
