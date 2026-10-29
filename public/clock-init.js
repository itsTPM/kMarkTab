// A classic synchronous script included right after the clock markup: it fills
// the clock in during parsing, before the first paint; a module script would run
// after it, leaving a frame with an empty gap. The ticking lives in
// features/clock.ts and reuses window.renderClock and window.applyClockSettings.
let hour12 = false;

window.renderClock = () => {
  const now = new Date();
  const hours = now.getHours();
  const mm = String(now.getMinutes()).padStart(2, "0");
  const time = document.querySelector("#time");
  if (hour12) {
    // 12:05 AM at midnight, 12:05 PM at noon
    const period = document.createElement("span");
    period.className = "time-period";
    period.textContent = hours < 12 ? "AM" : "PM";
    time.replaceChildren(`${hours % 12 || 12}:${mm}`, period);
  } else {
    time.textContent = `${String(hours).padStart(2, "0")}:${mm}`;
  }
  document.querySelector("#date").textContent = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
};

// Doesn't render: the caller does, so a format change shows without waiting for a tick
window.applyClockSettings = (showTime, showDate, timeFormat) => {
  hour12 = timeFormat === "12h";
  document.querySelector("#time").hidden = !showTime;
  document.querySelector("#date").hidden = !showDate;
  document.querySelector("#clock").hidden = !showTime && !showDate;
};

// Settings live in async browser.storage; core/settings.ts mirrors the clock
// settings into localStorage so they can be applied here before the first paint.
// Missing or broken value → the defaults: everything shown, and the time format of
// the browser's language (as defaultTimeFormat() in core/settings.ts).
let clock = {};
try {
  clock = JSON.parse(localStorage.getItem("clock")) ?? {};
} catch {}
let timeFormat = clock.timeFormat;
if (timeFormat === undefined) {
  try {
    const options = new Intl.DateTimeFormat([...navigator.languages], {
      hour: "numeric",
    }).resolvedOptions();
    timeFormat = options.hour12 ? "12h" : "24h";
  } catch {}
}
window.applyClockSettings(clock.showTime !== false, clock.showDate !== false, timeFormat);
window.renderClock();
