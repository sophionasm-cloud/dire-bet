interface Window {
  Telegram?: {
    WebApp?: {
      initData: string;
      initDataUnsafe?: { user?: { first_name?: string; last_name?: string; username?: string; language_code?: string; photo_url?: string } };
      ready(): void;
      expand(): void;
      setHeaderColor(color: string): void;
      setBackgroundColor(color: string): void;
      disableVerticalSwipes?(): void;
      enableClosingConfirmation?(): void;
      requestContact?(callback?: (shared: boolean) => void): void;
      HapticFeedback?: { impactOccurred(style: 'light'|'medium'|'heavy'): void; notificationOccurred(type: 'success'|'warning'|'error'): void };
      BackButton?: { show(): void; hide(): void; onClick(callback: () => void): void; offClick(callback: () => void): void };
    };
  };
}
