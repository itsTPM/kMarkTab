// The first paint and the formatting live in public/clock-init.js (a synchronous
// script that runs before the page is first painted). Only the ticking is here.
import { getSettings } from "../core/settings";

const CLOCK_TICK_MS = 1000;

let tickTimer: ReturnType<typeof setInterval> | undefined;

// Applies the clock settings. The elements stay in the DOM and are only hidden; the
// tick stops while there is nothing visible to update. When only one of the two is
// hidden it keeps ticking — renderClock writes both anyway.
export function applyClockSettings() {
  const { showTime, showDate, timeFormat } = getSettings();
  window.applyClockSettings(showTime, showDate, timeFormat);
  if (!showTime && !showDate) {
    clearInterval(tickTimer);
    tickTimer = undefined;
    return;
  }
  // render right away: the format may have changed, and a clock shown again would
  // keep the time it was hidden at until the first tick
  window.renderClock();
  tickTimer ??= setInterval(window.renderClock, CLOCK_TICK_MS);
}

export function startClock() {
  // clock-init.js has already applied the localStorage mirror; this catches the
  // case where the mirror is missing or stale, and starts the tick
  applyClockSettings();
}
