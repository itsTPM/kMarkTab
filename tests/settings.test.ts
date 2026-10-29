import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { SettingsInput } from "../entrypoints/newtab/core/settings";

// The module caches settings at the top level, so every test re-imports it.
async function freshSettings() {
  vi.resetModules();
  const settings = await import("../entrypoints/newtab/core/settings");
  await settings.loadSettings();
  return settings;
}

const values = (overrides: Partial<SettingsInput> = {}): SettingsInput => ({
  bgMode: "solid",
  solidColor: "#123456",
  bgDim: true,
  showTime: true,
  showDate: true,
  timeFormat: "24h",
  panelOpacity: 85,
  panelBlur: 24,
  faviconProvider: "google",
  searchCollapsed: true,
  unsplashSource: "curated",
  unsplashCollection: "",
  rotate: "hour",
  imageQuality: "qhd",
  bingMarket: "en-US",
  imageUrl: "",
  imageFileName: "",
  ...overrides,
});

beforeEach(() => {
  fakeBrowser.reset();
});

describe("normalization on save", () => {
  it("keeps valid values as is", async () => {
    const { saveSettings } = await freshSettings();
    const saved = await saveSettings(
      values({
        bgMode: "unsplash",
        faviconProvider: "duckduckgo",
        unsplashCollection: "col456",
        rotate: "tab",
        imageQuality: "fhd",
      }),
    );
    expect(saved).toMatchObject({
      bgMode: "unsplash",
      faviconProvider: "duckduckgo",
      unsplashCollection: "col456",
      rotate: "tab",
      imageQuality: "fhd",
    });
  });

  it("coerces unknown bgMode to unsplash", async () => {
    const { saveSettings } = await freshSettings();
    const saved = await saveSettings(values({ bgMode: "nonsense" }));
    expect(saved.bgMode).toBe("unsplash");
  });

  it.each(["google", "duckduckgo", "chrome"])("accepts favicon provider %s", async (provider) => {
    const { saveSettings } = await freshSettings();
    const saved = await saveSettings(values({ faviconProvider: provider }));
    expect(saved.faviconProvider).toBe(provider);
  });

  it("falls back to the default for unknown favicon provider", async () => {
    const { saveSettings } = await freshSettings();
    const saved = await saveSettings(values({ faviconProvider: "bing" }));
    expect(saved.faviconProvider).toBe("chrome");
  });

  it("falls back to every hour for an unknown rotation", async () => {
    const { saveSettings } = await freshSettings();
    const saved = await saveSettings(values({ rotate: "15" }));
    expect(saved.rotate).toBe("hour");
  });

  it("falls back to UHD for an unknown imageQuality", async () => {
    const { saveSettings } = await freshSettings();
    const saved = await saveSettings(values({ imageQuality: "8k" }));
    expect(saved.imageQuality).toBe("uhd");
  });

  it("keeps bgDim turned off", async () => {
    const { saveSettings } = await freshSettings();
    const saved = await saveSettings(values({ bgDim: false }));
    expect(saved.bgDim).toBe(false);
  });

  it("trims the collection", async () => {
    const { saveSettings } = await freshSettings();
    const saved = await saveSettings(values({ unsplashCollection: " col " }));
    expect(saved.unsplashCollection).toBe("col");
  });
});

describe("solid color", () => {
  it("falls back to the default for a value that isn't a color", async () => {
    const { saveSettings, DEFAULT_SETTINGS } = await freshSettings();
    expect((await saveSettings(values({ solidColor: "red" }))).solidColor).toBe(
      DEFAULT_SETTINGS.solidColor,
    );
  });
});

describe("panel appearance", () => {
  it("keeps values within range", async () => {
    const { saveSettings } = await freshSettings();
    const saved = await saveSettings(values({ panelOpacity: "60", panelBlur: 0 }));
    expect(saved).toMatchObject({ panelOpacity: 60, panelBlur: 0 });
  });

  it("clamps and rounds out-of-range values", async () => {
    const { saveSettings } = await freshSettings();
    const saved = await saveSettings(values({ panelOpacity: 150, panelBlur: -3 }));
    expect(saved).toMatchObject({ panelOpacity: 100, panelBlur: 0 });
    const rounded = await saveSettings(values({ panelOpacity: 42.6, panelBlur: 7.2 }));
    expect(rounded).toMatchObject({ panelOpacity: 43, panelBlur: 7 });
  });

  it("falls back to the defaults for non-numeric values", async () => {
    const { saveSettings, DEFAULT_SETTINGS } = await freshSettings();
    const saved = await saveSettings(values({ panelOpacity: "", panelBlur: "abc" }));
    expect(saved).toMatchObject({
      panelOpacity: DEFAULT_SETTINGS.panelOpacity,
      panelBlur: DEFAULT_SETTINGS.panelBlur,
    });
  });
});

describe("Bing settings", () => {
  it("accepts the bing mode", async () => {
    const { saveSettings } = await freshSettings();
    const saved = await saveSettings(values({ bgMode: "bing" }));
    expect(saved.bgMode).toBe("bing");
  });

  it("keeps a known market", async () => {
    const { saveSettings } = await freshSettings();
    const saved = await saveSettings(values({ bingMarket: "ja-JP" }));
    expect(saved.bingMarket).toBe("ja-JP");
  });

  it("falls back to the default for an unknown market", async () => {
    const { saveSettings, DEFAULT_SETTINGS } = await freshSettings();
    const saved = await saveSettings(values({ bingMarket: "xx-XX" }));
    expect(saved.bingMarket).toBe(DEFAULT_SETTINGS.bingMarket);
  });
});

describe("image URL settings", () => {
  it("accepts the url mode and trims the URL", async () => {
    const { saveSettings } = await freshSettings();
    const saved = await saveSettings(
      values({ bgMode: "url", imageUrl: "  https://images.test/a.jpg  " }),
    );
    expect(saved.bgMode).toBe("url");
    expect(saved.imageUrl).toBe("https://images.test/a.jpg");
  });
});

describe("defaultBingMarket", () => {
  it.each([
    [["de-DE"], "de-DE"],
    // matched by region, whatever the language
    [["fr-CA"], "en-CA"],
    [["en-DE"], "de-DE"],
    // a bare language is expanded to its likely region
    [["ja"], "ja-JP"],
    [["pt"], "pt-BR"],
    // the first language whose region has a market wins
    [["de-AT", "it-IT"], "it-IT"],
    [["en-NZ"], "en-US"],
    [["not a tag", "es-ES"], "es-ES"],
    [[], "en-US"],
  ])("%j → %s", async (languages, market) => {
    const { defaultBingMarket } = await freshSettings();
    expect(defaultBingMarket(languages)).toBe(market);
  });
});

describe("clock settings", () => {
  it("keeps a known time format", async () => {
    const { saveSettings } = await freshSettings();
    const saved = await saveSettings(values({ timeFormat: "12h" }));
    expect(saved.timeFormat).toBe("12h");
  });

  it("falls back to the default for an unknown time format", async () => {
    const { saveSettings, DEFAULT_SETTINGS } = await freshSettings();
    const saved = await saveSettings(values({ timeFormat: "13h" }));
    expect(saved.timeFormat).toBe(DEFAULT_SETTINGS.timeFormat);
  });
});

describe("defaultTimeFormat", () => {
  it.each([
    [["en-US"], "12h"],
    [["de-DE"], "24h"],
    [["ru"], "24h"],
    // the first language decides
    [["en-GB", "en-US"], "24h"],
  ])("%j → %s", async (languages, format) => {
    const { defaultTimeFormat } = await freshSettings();
    expect(defaultTimeFormat(languages)).toBe(format);
  });

  it("falls back to 24h for a malformed language tag", async () => {
    const { defaultTimeFormat } = await freshSettings();
    expect(defaultTimeFormat(["not a tag"])).toBe("24h");
  });
});

describe("persistence", () => {
  it("saved settings survive a module reload", async () => {
    const first = await freshSettings();
    await first.saveSettings(values({ faviconProvider: "chrome", imageQuality: "original" }));

    const second = await freshSettings();
    expect(second.getSettings()).toMatchObject({
      faviconProvider: "chrome",
      imageQuality: "original",
    });
  });

  it("returns defaults when nothing is saved", async () => {
    const { getSettings, DEFAULT_SETTINGS } = await freshSettings();
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("mirrors clock visibility into localStorage on save", async () => {
    const { saveSettings } = await freshSettings();
    await saveSettings(values({ showTime: false, showDate: true, timeFormat: "12h" }));
    expect(JSON.parse(localStorage.getItem("clock") ?? "")).toEqual({
      showTime: false,
      showDate: true,
      timeFormat: "12h",
    });
  });

  it("mirrors clock visibility into localStorage on load", async () => {
    await fakeBrowser.storage.local.set({ settings: { showDate: false, timeFormat: "24h" } });
    localStorage.clear();
    await freshSettings();
    expect(JSON.parse(localStorage.getItem("clock") ?? "")).toEqual({
      showTime: true,
      showDate: false,
      timeFormat: "24h",
    });
  });

  it("mirrors the panel appearance into localStorage on save and on load", async () => {
    const { saveSettings } = await freshSettings();
    await saveSettings(values({ panelOpacity: 100, panelBlur: 8 }));
    expect(JSON.parse(localStorage.getItem("appearance") ?? "")).toEqual({
      panelOpacity: 100,
      panelBlur: 8,
    });

    await fakeBrowser.storage.local.set({ settings: { panelBlur: 0 } });
    localStorage.clear();
    await freshSettings();
    expect(JSON.parse(localStorage.getItem("appearance") ?? "")).toEqual({
      panelOpacity: 85,
      panelBlur: 0,
    });
  });

  it("fills missing fields of stored settings with defaults", async () => {
    await fakeBrowser.storage.local.set({ settings: { bgMode: "unsplash" } });
    const { getSettings } = await freshSettings();
    expect(getSettings().bgMode).toBe("unsplash");
    expect(getSettings().faviconProvider).toBe("chrome");
  });
});

describe("settings files", () => {
  it("round-trips every setting but the image file name", async () => {
    const { saveSettings, settingsToJson, settingsFromJson } = await freshSettings();
    const saved = await saveSettings(
      values({ bgMode: "file", imageFileName: "photo.jpg", rotate: "day", bgDim: false }),
    );
    const json = settingsToJson(saved);
    expect(json).not.toContain("photo.jpg");
    const { imageFileName: _, ...portable } = saved;
    expect(settingsFromJson(json)).toEqual(portable);
  });

  it("rejects anything but a settings file", async () => {
    const { settingsFromJson } = await freshSettings();
    expect(settingsFromJson("not json")).toBeUndefined();
    expect(settingsFromJson("[]")).toBeUndefined();
    expect(settingsFromJson('{"bgMode":"solid"}')).toBeUndefined();
    expect(
      settingsFromJson('{"format":"kMarkTab-settings","version":2,"settings":{}}'),
    ).toBeUndefined();
    expect(settingsFromJson('{"format":"kMarkTab-settings","version":1}')).toBeUndefined();
  });

  it("takes the defaults for missing values and values of the wrong type", async () => {
    const { settingsFromJson, DEFAULT_SETTINGS } = await freshSettings();
    const imported = settingsFromJson(
      JSON.stringify({
        format: "kMarkTab-settings",
        version: 1,
        settings: { bgMode: "bing", showTime: "no", rotate: 15, extra: 1 },
      }),
    );
    const { imageFileName: _, ...defaults } = DEFAULT_SETTINGS;
    expect(imported).toEqual({ ...defaults, bgMode: "bing" });
  });
});
