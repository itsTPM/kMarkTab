declare global {
  interface Window {
    renderClock: () => void;
    applyClockSettings: (showTime: boolean, showDate: boolean, timeFormat?: string) => void;
    applyAppearance: (panelOpacity: number, panelBlur: number) => void;
  }

  // Minimal declaration instead of @types/chrome: only the favicon API is used,
  // and the page has to type-check outside Chrome as well
  var chrome: { runtime?: { getURL?: (path: string) => string } } | undefined;
}

export {};
