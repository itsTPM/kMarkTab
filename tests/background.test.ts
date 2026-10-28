import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { Settings } from "../entrypoints/newtab/core/settings";

const BACKEND = "https://backend.test";

// A deck of the backend: photos p<from>…, at https://images.test/photo<n>
const deck = (count = 30, from = 1) => ({
  photos: Array.from({ length: count }, (_, i) => ({
    id: `p${from + i}`,
    url: `https://images.test/photo${from + i}`,
    width: 6000,
    height: 4000,
    link: `https://unsplash.com/photos/p${from + i}`,
    author: { name: "Ann Author", link: "https://unsplash.com/@ann" },
  })),
});
const backendError = (status: number, error: string, retryAfter?: number) =>
  ({
    ok: false,
    status,
    headers: new Headers(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
    json: async () => ({ error, message: error }),
  }) as Response;

// The image that started at 07:00 UTC on 2026-07-06 (midnight in the en-US market)
const bingStart = Date.UTC(2026, 6, 6, 7, 0);
const bingFeed = (fullstartdate = "202607060700") => ({
  images: [
    {
      fullstartdate,
      urlbase: "/th?id=OHR.Cormorants_EN-US123",
      copyright: "Cormorants over Monterey Bay (© Hiroya Minakuchi/Minden Pictures)",
      copyrightlink: "https://www.bing.com/search?q=cormorants",
    },
  ],
});
const respondWith = (body: unknown) =>
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => body } as Response);
const fetchedUrl = (call = 0) => String(vi.mocked(fetch).mock.calls[call]?.[0]);
const fetchedHeaders = (call = 0) =>
  (vi.mocked(fetch).mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;

// Fires `load` synchronously so applyImageBackground completes without a
// real image request.
class InstantImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    this.onload?.();
  }
}

class FailingImage extends InstantImage {
  override set src(_value: string) {
    this.onerror?.();
  }
}

// Never settles, so the loading state can be observed
class PendingImage extends InstantImage {
  override set src(_value: string) {}
}

// The module queries #bg-credit at the top level and getSettings() reads the
// module-level cache, so every test re-imports both modules fresh.
async function setup(settingsOverrides?: Partial<Settings>) {
  document.body.innerHTML =
    '<div id="bg-credit" hidden>' +
    '<span id="bg-credit-unsplash">Photo by <a id="bg-credit-author"></a></span>' +
    '<a id="bg-credit-bing"></a>' +
    "</div>" +
    '<div id="bg-status" role="status"><span id="bg-status-text"></span></div>';
  document.body.className = "";
  document.documentElement.removeAttribute("style");
  vi.resetModules();
  const { DEFAULT_SETTINGS, saveSettings } = await import("../entrypoints/newtab/core/settings");
  await saveSettings({
    ...DEFAULT_SETTINGS,
    bgMode: "unsplash",
    ...settingsOverrides,
  });
  return import("../entrypoints/newtab/features/background");
}

const localTime = (hours: number, minutes: number) =>
  new Date(2026, 6, 6, hours, minutes).getTime();

const seedCache = (at: number) =>
  fakeBrowser.storage.local.set({
    background: { source: "unsplash", url: "https://images.test/cached", at },
  });

// permissions.onAdded listeners, so that a test can grant access
let accessListeners: (() => void)[] = [];
const grantAccess = (granted: boolean) =>
  vi.spyOn(fakeBrowser.permissions, "contains").mockResolvedValue(granted as never);

const bgImage = () => document.documentElement.style.getPropertyValue("--bg-image");

// microtask flush without touching the pending rotation timer
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  fakeBrowser.reset();
  vi.useFakeTimers();
  vi.stubGlobal("Image", InstantImage);
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubEnv("WXT_BACKEND_URL", BACKEND);
  // not implemented by fakeBrowser
  grantAccess(true);
  accessListeners = [];
  vi.spyOn(fakeBrowser.permissions.onAdded, "addListener").mockImplementation((listener) => {
    accessListeners.push(listener as () => void);
  });
  vi.spyOn(fakeBrowser.permissions.onRemoved, "addListener").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => deck() })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("rotation periods", () => {
  it("reuses the cached image within the same wall-clock period", async () => {
    vi.setSystemTime(localTime(10, 5));
    await seedCache(localTime(10, 5));
    const { refreshBackground } = await setup();
    vi.setSystemTime(localTime(10, 59));
    refreshBackground();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(bgImage()).toContain("https://images.test/cached?");
  });

  it("fetches a new image once the period boundary is crossed", async () => {
    await seedCache(localTime(9, 59));
    vi.setSystemTime(localTime(10, 1));
    const { refreshBackground } = await setup();
    refreshBackground();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bgImage()).toContain("https://images.test/photo");
  });

  it("rotates at the next boundary while the tab stays open", async () => {
    vi.setSystemTime(localTime(10, 5));
    await seedCache(localTime(10, 5));
    const { startBackground } = await setup();
    startBackground();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    // 55 minutes left until 11:00; the timer is armed for the boundary + 1s
    await vi.advanceTimersByTimeAsync(55 * 60 * 1000 + 1000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rotates daily at local midnight", async () => {
    await seedCache(localTime(0, 1));
    vi.setSystemTime(localTime(23, 59));
    const { startBackground } = await setup({ rotate: "day" });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    startBackground();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    // 1 minute until midnight, + 1s
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 60 * 1000 + 1000);
    await vi.advanceTimersByTimeAsync(60 * 1000 + 1000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("waits for the boundary in the repeated hour when clocks go back", async () => {
    vi.stubEnv("TZ", "Europe/Berlin");
    // 2026-10-25 02:10 CET — the second pass through 02:00–03:00
    const now = Date.UTC(2026, 9, 25, 1, 10);
    // guards against the TZ stub silently not applying — in UTC the delay would match too
    expect(new Date(now).getHours()).toBe(2);
    vi.setSystemTime(now);
    await seedCache(now);
    const { startBackground } = await setup();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    startBackground();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    // 50 minutes until 03:00, + 1s
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 50 * 60 * 1000 + 1000);
  });

  it("shows a new image in every tab, but keeps it in the same one", async () => {
    vi.setSystemTime(localTime(10, 5));
    await seedCache(localTime(10, 5));
    vi.setSystemTime(localTime(10, 6));
    const { startBackground, refreshBackground } = await setup({ rotate: "tab" });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    startBackground();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bgImage()).toContain("https://images.test/photo1?");
    // another setting changed: the same tab keeps its image
    refreshBackground();
    await flush();
    expect(bgImage()).toContain("https://images.test/photo1?");
    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), expect.any(Number));
  });
});

describe("attribution", () => {
  const credit = () => document.querySelector<HTMLElement>("#bg-credit");
  const author = () => document.querySelector<HTMLAnchorElement>("#bg-credit-author");

  it("shows the photographer credit after a fetch", async () => {
    const { refreshBackground } = await setup();
    refreshBackground();
    await flush();
    expect(credit()?.hidden).toBe(false);
    expect(author()?.textContent).toBe("Ann Author");
    expect(author()?.getAttribute("href")).toBe(
      "https://unsplash.com/@ann?utm_source=kMarkTab&utm_medium=referral",
    );
  });

  it("stays hidden for a cached image without credit data", async () => {
    vi.setSystemTime(localTime(10, 5));
    await seedCache(localTime(10, 5));
    const { refreshBackground } = await setup();
    refreshBackground();
    await flush();
    expect(credit()?.hidden).toBe(true);
  });

  it("hides the credit in solid mode", async () => {
    const { refreshBackground } = await setup();
    refreshBackground();
    await flush();
    const solid = await setup({ bgMode: "solid" });
    solid.refreshBackground();
    await flush();
    expect(credit()?.hidden).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("image quality", () => {
  const imageUrl = () => new URL(/url\("(.*)"\)/.exec(bgImage())?.[1] ?? "");

  it("requests the Unsplash photo at the quality's width", async () => {
    const { refreshBackground } = await setup({ imageQuality: "fhd" });
    refreshBackground();
    await flush();
    expect(imageUrl().searchParams.get("w")).toBe("1920");
    expect(imageUrl().searchParams.get("fm")).toBe("avif");
  });

  it("requests the original Unsplash photo without a width", async () => {
    const { refreshBackground } = await setup({ imageQuality: "original" });
    refreshBackground();
    await flush();
    expect(imageUrl().searchParams.has("w")).toBe(false);
  });

  it("shows the cached image in another quality without a new request", async () => {
    vi.setSystemTime(localTime(10, 5));
    await seedCache(localTime(10, 5));
    const { refreshBackground } = await setup({ imageQuality: "qhd" });
    refreshBackground();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(imageUrl().origin + imageUrl().pathname).toBe("https://images.test/cached");
    expect(imageUrl().searchParams.get("w")).toBe("2560");
  });

  it("takes Bing's UHD as is for the original", async () => {
    respondWith(bingFeed());
    const { refreshBackground } = await setup({ bgMode: "bing", imageQuality: "original" });
    refreshBackground();
    await flush();
    expect(imageUrl().toString()).toBe(
      "https://www.bing.com/th?id=OHR.Cormorants_EN-US123_UHD.jpg&qlt=90",
    );
  });
});

describe("loading status", () => {
  const state = () => document.querySelector<HTMLElement>("#bg-status")?.dataset.state;
  const text = () => document.querySelector("#bg-status-text")?.textContent;

  it("shows the loader until the image loads, then nothing", async () => {
    vi.stubGlobal("Image", PendingImage);
    vi.setSystemTime(localTime(10, 1));
    const { refreshBackground } = await setup();
    refreshBackground();
    await flush();
    expect(state()).toBe("loading");
    expect(text()).toBe("");

    vi.stubGlobal("Image", InstantImage);
    vi.setSystemTime(localTime(11, 1));
    refreshBackground();
    await flush();
    expect(state()).toBe("idle");
    expect(text()).toBe("");
  });

  it.each([
    [404, "collectionNotFound", "Unsplash: no such public collection"],
    [429, "tooManyRequests", "Unsplash: too many requests, try again later"],
    [503, "budgetExhausted", "Unsplash is unavailable for now, try again later"],
    [500, "internal", "Unsplash error 500"],
  ])("reports a failed deck request (%i %s)", async (status, error, message) => {
    vi.mocked(fetch).mockResolvedValue(backendError(status, error));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { refreshBackground } = await setup({
      unsplashSource: "collection",
      unsplashCollection: "abc",
    });
    refreshBackground();
    await flush();
    expect(state()).toBe("error");
    expect(text()).toBe(message);
  });

  it("reports a network error", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { refreshBackground } = await setup();
    refreshBackground();
    await flush();
    expect(state()).toBe("error");
    expect(text()).toBe("Couldn't reach Unsplash");
  });

  it("stays silent when a failed fetch falls back to the cached image", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await seedCache(localTime(8, 0));
    vi.setSystemTime(localTime(10, 1));
    const { refreshBackground } = await setup();
    refreshBackground();
    await flush();
    expect(bgImage()).toContain("https://images.test/cached?");
    expect(state()).toBe("idle");
  });

  it("reports an image that fails to load", async () => {
    vi.stubGlobal("Image", FailingImage);
    const { refreshBackground } = await setup();
    refreshBackground();
    await flush();
    expect(state()).toBe("error");
    expect(text()).toBe("Couldn't load the background image");
  });

  it("ignores an image load that finishes after switching to solid mode", async () => {
    let finishLoad = () => {};
    vi.stubGlobal(
      "Image",
      class extends InstantImage {
        override set src(_value: string) {
          finishLoad = () => this.onload?.();
        }
      },
    );
    const { refreshBackground } = await setup();
    refreshBackground();
    await flush();
    const { saveSettings, getSettings } = await import("../entrypoints/newtab/core/settings");
    await saveSettings({ ...getSettings(), bgMode: "solid" });
    refreshBackground();
    finishLoad();
    expect(bgImage()).toBe("none");
    expect(state()).toBe("idle");
  });
});

describe("dimming", () => {
  const dimmed = () => document.body.classList.contains("bg-dim");

  it("dims the background by default", async () => {
    const { refreshBackground } = await setup();
    refreshBackground();
    expect(dimmed()).toBe(true);
  });

  it("removes the dimming when bgDim is off", async () => {
    const { refreshBackground } = await setup({ bgDim: false });
    refreshBackground();
    expect(dimmed()).toBe(false);
  });
});

describe("Bing image of the day", () => {
  const bingSettings = { bgMode: "bing", bingMarket: "de-DE" } as const;
  const credit = () => document.querySelector<HTMLElement>("#bg-credit");

  beforeEach(() => {
    respondWith(bingFeed());
  });

  it("requests the selected market and builds the image URL", async () => {
    const { refreshBackground } = await setup({ ...bingSettings, imageQuality: "qhd" });
    refreshBackground();
    await flush();
    const endpoint = new URL(fetchedUrl());
    expect(endpoint.origin + endpoint.pathname).toBe("https://www.bing.com/HPImageArchive.aspx");
    expect(endpoint.searchParams.get("mkt")).toBe("de-DE");
    expect(bgImage()).toBe(
      'url("https://www.bing.com/th?id=OHR.Cormorants_EN-US123_UHD.jpg&w=2560&qlt=90")',
    );
  });

  it("credits the image with its description", async () => {
    const { refreshBackground } = await setup(bingSettings);
    refreshBackground();
    await flush();
    const bing = document.querySelector<HTMLAnchorElement>("#bg-credit-bing");
    expect(credit()?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#bg-credit-unsplash")?.hidden).toBe(true);
    expect(bing?.hidden).toBe(false);
    expect(bing?.textContent).toContain("© Hiroya Minakuchi");
    expect(bing?.getAttribute("href")).toBe("https://www.bing.com/search?q=cormorants");
  });

  it("ignores the rotation and reuses the cache until the next image is due", async () => {
    vi.setSystemTime(bingStart + 60 * 60 * 1000);
    const { refreshBackground } = await setup({ ...bingSettings, rotate: "tab" });
    refreshBackground();
    await flush();
    vi.setSystemTime(bingStart + 23 * 60 * 60 * 1000);
    refreshBackground();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fetches the next image a day after the current one started", async () => {
    vi.setSystemTime(bingStart + 60 * 60 * 1000);
    const { startBackground } = await setup(bingSettings);
    startBackground();
    await flush();
    respondWith(bingFeed("202607070700"));
    // 23 hours left until the next image, + 1s
    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000 + 1000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // fullstartdate is "YYYYMMDDHHmm" in UTC; every field is checked through the exact
  // delay until the next image
  it.each([
    ["202607061830", Date.UTC(2026, 6, 6, 18, 30)],
    // month and year boundaries
    ["202612312300", Date.UTC(2026, 11, 31, 23, 0)],
    ["202602280700", Date.UTC(2026, 1, 28, 7, 0)],
  ])("schedules the next image a day after %s UTC", async (fullstartdate, start) => {
    respondWith(bingFeed(fullstartdate));
    vi.setSystemTime(start + 5 * 60 * 1000);
    const { startBackground } = await setup(bingSettings);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    startBackground();
    await flush();
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(
      expect.any(Function),
      24 * 60 * 60 * 1000 - 5 * 60 * 1000 + 1000,
    );
  });

  it("retries when the start time can't be parsed", async () => {
    respondWith(bingFeed("garbage"));
    const { startBackground } = await setup(bingSettings);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    startBackground();
    await flush();
    expect(bgImage()).toContain("OHR.Cormorants");
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 15 * 60 * 1000 + 1000);
  });

  it("retries when Bing still serves the previous image", async () => {
    // a day later, but the feed hasn't switched yet
    vi.setSystemTime(bingStart + 24 * 60 * 60 * 1000 + 1000);
    const { startBackground } = await setup(bingSettings);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    startBackground();
    await flush();
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 15 * 60 * 1000 + 1000);
  });

  it("retries after a failed request", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { startBackground } = await setup(bingSettings);
    startBackground();
    await flush();
    expect(document.querySelector("#bg-status-text")?.textContent).toBe("Couldn't reach Bing");
    respondWith(bingFeed());
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bgImage()).toContain("OHR.Cormorants");
  });

  it("asks for nothing without access to bing.com, and says where to allow it", async () => {
    grantAccess(false);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { refreshBackground } = await setup(bingSettings);
    refreshBackground();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(document.querySelector("#bg-status-text")?.textContent).toBe(
      "Bing needs access to bing.com: allow it under Background",
    );
  });

  it("shows the image as soon as access is granted", async () => {
    grantAccess(false);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { startBackground } = await setup(bingSettings);
    startBackground();
    await flush();
    grantAccess(true);
    accessListeners.forEach((listener) => listener());
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bgImage()).toContain("OHR.Cormorants");
  });

  it("does not refresh another mode when access changes", async () => {
    vi.setSystemTime(localTime(10, 5));
    const { startBackground } = await setup();
    startBackground();
    await flush();
    accessListeners.forEach((listener) => listener());
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // the cached image is still current by Unsplash's rotation period
  it("fetches Bing instead of showing a current Unsplash cache", async () => {
    vi.setSystemTime(localTime(10, 5));
    await seedCache(localTime(10, 5));
    const { refreshBackground } = await setup(bingSettings);
    refreshBackground();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bgImage()).toContain("OHR.Cormorants");
  });

  it("does not fall back to a cached Unsplash image when Bing fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await seedCache(localTime(8, 0));
    const { refreshBackground } = await setup(bingSettings);
    refreshBackground();
    await flush();
    expect(bgImage()).not.toContain("https://images.test/cached");
    expect(document.querySelector("#bg-status-text")?.textContent).toBe("Couldn't reach Bing");
  });

  it("does not use a cached Bing image in Unsplash mode", async () => {
    const bing = await setup(bingSettings);
    bing.refreshBackground();
    await flush();
    respondWith(deck());
    const unsplash = await setup();
    unsplash.refreshBackground();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bgImage()).toContain("https://images.test/photo");
  });
});

describe("Unsplash decks", () => {
  const state = () => document.querySelector<HTMLElement>("#bg-status")?.dataset.state;
  const storedDeck = async () =>
    (await fakeBrowser.storage.local.get("unsplashDeck")).unsplashDeck as {
      collection: string;
      photos: { id: string }[];
    };

  it("takes the curated collection when no collection is set", async () => {
    const { refreshBackground } = await setup();
    refreshBackground();
    await flush();
    expect(fetchedUrl()).toBe(`${BACKEND}/v1/curated`);
    expect(fetchedHeaders()).not.toHaveProperty("X-Install-Id");
    expect(bgImage()).toContain("https://images.test/photo1?");
  });

  it("takes the curated collection for the curated source, whatever the collection ID", async () => {
    const { refreshBackground } = await setup({ unsplashCollection: "abc" });
    refreshBackground();
    await flush();
    expect(fetchedUrl()).toBe(`${BACKEND}/v1/curated`);
  });

  it("takes the curated collection for the collection source without an ID", async () => {
    const { refreshBackground } = await setup({ unsplashSource: "collection" });
    refreshBackground();
    await flush();
    expect(fetchedUrl()).toBe(`${BACKEND}/v1/curated`);
  });

  it("asks for the collection with the same install id every time", async () => {
    // a deck of one photo: the next one is asked for right away
    respondWith(deck(1));
    const { refreshBackground } = await setup({
      unsplashSource: "collection",
      unsplashCollection: "a b",
    });
    refreshBackground();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetchedUrl()).toBe(`${BACKEND}/v1/collections/a%20b`);
    const installId = fetchedHeaders(0)["X-Install-Id"];
    expect(installId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(fetchedHeaders(1)["X-Install-Id"]).toBe(installId);
  });

  it("rotates through the deck without new requests", async () => {
    vi.setSystemTime(localTime(10, 1));
    const { refreshBackground } = await setup();
    refreshBackground();
    await flush();
    vi.setSystemTime(localTime(11, 1));
    refreshBackground();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bgImage()).toContain("https://images.test/photo2?");
    expect((await storedDeck()).photos).toHaveLength(28);
  });

  it("fetches the next deck while the last photos are shown, without repeats", async () => {
    vi.setSystemTime(localTime(10, 1));
    respondWith(deck(7));
    const { refreshBackground } = await setup();
    refreshBackground();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    // 5 left after this one: the next deck comes while photo2 is shown
    respondWith(deck(30, 5));
    vi.setSystemTime(localTime(11, 1));
    refreshBackground();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bgImage()).toContain("https://images.test/photo2?");
    const ids = (await storedDeck()).photos.map((photo) => photo.id);
    expect(ids.slice(0, 3)).toEqual(["p3", "p4", "p5"]);
    expect(ids).toHaveLength(32);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ignores a deck of another collection", async () => {
    await fakeBrowser.storage.local.set({
      unsplashDeck: { collection: "other", photos: deck(5, 100).photos },
    });
    const { refreshBackground } = await setup();
    refreshBackground();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bgImage()).toContain("https://images.test/photo1?");
    expect((await storedDeck()).collection).toBe("");
  });

  it("waits as long as the backend says before asking again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.setSystemTime(localTime(10, 1));
    vi.mocked(fetch).mockResolvedValue(backendError(503, "curatedNotReady", 60));
    const { startBackground, refreshBackground } = await setup();
    startBackground();
    await flush();
    expect(state()).toBe("error");
    // another tab, or the settings: the same error without a request
    refreshBackground();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state()).toBe("error");

    respondWith(deck());
    await vi.advanceTimersByTimeAsync(60 * 1000 + 1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bgImage()).toContain("https://images.test/photo1?");
    expect(state()).toBe("idle");
  });
});

describe("image URL", () => {
  const state = () => document.querySelector<HTMLElement>("#bg-status")?.dataset.state;
  const text = () => document.querySelector("#bg-status-text")?.textContent;

  it("loads the image as is, without fetching or caching anything", async () => {
    const { refreshBackground } = await setup({
      bgMode: "url",
      imageUrl: "https://images.test/a.jpg?w=10",
    });
    refreshBackground();
    await flush();
    expect(bgImage()).toBe('url("https://images.test/a.jpg?w=10")');
    expect(state()).toBe("idle");
    expect(fetch).not.toHaveBeenCalled();
    expect(await fakeBrowser.storage.local.get("background")).toEqual({});
    expect(document.querySelector<HTMLElement>("#bg-credit")?.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["", "No image URL"],
    ["not a url", "Invalid image URL"],
    ['data:image/svg+xml,<svg a="b"/>', "Image URL must be http(s)"],
  ])("reports %j", async (imageUrl, message) => {
    const { refreshBackground } = await setup({ bgMode: "url", imageUrl });
    refreshBackground();
    await flush();
    expect(state()).toBe("error");
    expect(text()).toBe(message);
    expect(bgImage()).toBe("");
  });

  it("percent-encodes quotes so the URL stays inside url()", async () => {
    const { refreshBackground } = await setup({
      bgMode: "url",
      imageUrl: 'https://images.test/a".jpg',
    });
    refreshBackground();
    await flush();
    expect(bgImage()).toBe('url("https://images.test/a%22.jpg")');
  });
});

describe("local file", () => {
  const state = () => document.querySelector<HTMLElement>("#bg-status")?.dataset.state;
  const text = () => document.querySelector("#bg-status-text")?.textContent;
  let urls = 0;

  beforeEach(() => {
    // fake-indexeddb schedules its callbacks with timers, which fake timers would hold
    vi.useRealTimers();
    urls = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/${++urls}`);
  });

  it("shows the stored file and reuses its object URL", async () => {
    const { saveImageFile } = await import("../entrypoints/newtab/core/image-file");
    await saveImageFile(new Blob(["x"], { type: "image/png" }));
    const { refreshBackground } = await setup({ bgMode: "file", imageFileName: "a.png" });
    refreshBackground();
    await vi.waitFor(() => expect(bgImage()).toBe('url("blob:test/1")'));
    expect(state()).toBe("idle");
    expect(fetch).not.toHaveBeenCalled();

    refreshBackground();
    await vi.waitFor(() => expect(state()).toBe("idle"));
    expect(urls).toBe(1);
  });

  it("makes a new object URL after clearCache()", async () => {
    const { saveImageFile } = await import("../entrypoints/newtab/core/image-file");
    await saveImageFile(new Blob(["x"], { type: "image/png" }));
    const { refreshBackground, clearCache } = await setup({ bgMode: "file" });
    refreshBackground();
    await vi.waitFor(() => expect(bgImage()).toBe('url("blob:test/1")'));
    await clearCache();
    refreshBackground();
    await vi.waitFor(() => expect(bgImage()).toBe('url("blob:test/2")'));
  });

  it("reports a missing file", async () => {
    const { refreshBackground } = await setup({ bgMode: "file" });
    refreshBackground();
    await vi.waitFor(() => expect(text()).toBe("No image file"));
    expect(state()).toBe("error");
  });
});
