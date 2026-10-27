import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { Settings } from "../entrypoints/newtab/core/settings";

// Both the settings cache and the tick timer live at module scope, so every test
// re-imports the modules fresh.
async function setup(overrides: Partial<Settings> = {}) {
  vi.resetModules();
  const settings = await import("../entrypoints/newtab/core/settings");
  await settings.saveSettings({ ...settings.DEFAULT_SETTINGS, ...overrides });
  const clock = await import("../entrypoints/newtab/features/clock");
  return { ...settings, ...clock };
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.useFakeTimers();
  // normally defined by public/clock-init.js
  window.renderClock = vi.fn();
  window.applyClockSettings = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("clock tick", () => {
  it("ticks while the clock is visible", async () => {
    const { startClock } = await setup();
    startClock();
    vi.advanceTimersByTime(3000);
    expect(window.renderClock).toHaveBeenCalledTimes(4);
  });

  it("keeps ticking when only the date is hidden", async () => {
    const { startClock } = await setup({ showDate: false });
    startClock();
    vi.advanceTimersByTime(3000);
    expect(window.renderClock).toHaveBeenCalledTimes(4);
  });

  it("does not tick when both time and date are hidden", async () => {
    const { startClock } = await setup({ showTime: false, showDate: false, timeFormat: "24h" });
    startClock();
    vi.advanceTimersByTime(3000);
    expect(window.renderClock).not.toHaveBeenCalled();
    expect(window.applyClockSettings).toHaveBeenCalledWith(false, false, "24h");
  });

  it("stops ticking once everything is hidden", async () => {
    const { startClock, applyClockSettings, saveSettings, DEFAULT_SETTINGS } = await setup();
    startClock();
    await saveSettings({
      ...DEFAULT_SETTINGS,
      showTime: false,
      showDate: false,
    });
    applyClockSettings();
    vi.mocked(window.renderClock).mockClear();
    vi.advanceTimersByTime(3000);
    expect(window.renderClock).not.toHaveBeenCalled();
  });

  it("renders immediately and resumes ticking when shown again", async () => {
    const { startClock, applyClockSettings, saveSettings, DEFAULT_SETTINGS } = await setup({
      showTime: false,
      showDate: false,
    });
    startClock();
    await saveSettings({ ...DEFAULT_SETTINGS, showTime: true });
    applyClockSettings();
    expect(window.renderClock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(window.renderClock).toHaveBeenCalledTimes(3);
  });

  it("renders right away with the new format, without a second timer", async () => {
    const { startClock, applyClockSettings, saveSettings, DEFAULT_SETTINGS } = await setup({
      timeFormat: "24h",
    });
    startClock();
    await saveSettings({ ...DEFAULT_SETTINGS, timeFormat: "12h" });
    applyClockSettings();
    expect(window.applyClockSettings).toHaveBeenLastCalledWith(true, true, "12h");
    expect(window.renderClock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    expect(window.renderClock).toHaveBeenCalledTimes(4);
  });
});
