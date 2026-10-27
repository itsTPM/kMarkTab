import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import clockInit from "../public/clock-init.js?raw";

// clock-init.js is a classic script, not a module, so it can't be imported: its source is
// run instead. Each run gets its own function scope, so its top-level `let`s don't collide
// between tests, and it sees only globals (window, document, localStorage), as on the page.
function runClockInit() {
  new Function(clockInit)();
}

const time = () => document.querySelector("#time");

beforeEach(() => {
  document.body.innerHTML = `
    <div id="clock"><div id="time"></div><div id="date"></div></div>
  `;
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("clock-init.js", () => {
  it.each([
    ["2026-10-13T00:05:00", "00:05"],
    ["2026-10-13T09:30:00", "09:30"],
    ["2026-10-13T14:30:00", "14:30"],
  ])("renders %s as %s in 24h", (now, text) => {
    vi.setSystemTime(new Date(now));
    localStorage.setItem("clock", JSON.stringify({ timeFormat: "24h" }));
    runClockInit();
    expect(time()?.textContent).toBe(text);
  });

  it.each([
    ["2026-10-13T00:05:00", "12:05", "AM"],
    ["2026-10-13T09:30:00", "9:30", "AM"],
    ["2026-10-13T12:00:00", "12:00", "PM"],
    ["2026-10-13T14:30:00", "2:30", "PM"],
  ])("renders %s as %s %s in 12h", (now, text, period) => {
    vi.setSystemTime(new Date(now));
    localStorage.setItem("clock", JSON.stringify({ timeFormat: "12h" }));
    runClockInit();
    expect(time()?.firstChild?.textContent).toBe(text);
    expect(time()?.querySelector(".time-period")?.textContent).toBe(period);
  });

  it("switches the format on the next render", () => {
    vi.setSystemTime(new Date("2026-10-13T14:30:00"));
    localStorage.setItem("clock", JSON.stringify({ timeFormat: "12h" }));
    runClockInit();
    window.applyClockSettings(true, true, "24h");
    window.renderClock();
    expect(time()?.textContent).toBe("14:30");
  });

  it("applies the mirrored visibility", () => {
    localStorage.setItem("clock", JSON.stringify({ showTime: false, showDate: true }));
    runClockInit();
    expect((time() as HTMLElement).hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#clock")?.hidden).toBe(false);
  });
});
