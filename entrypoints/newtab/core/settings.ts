import { storage } from "#imports";

// Read synchronously by public/clock-init.js before the first paint, when
// browser.storage (async) isn't available yet. Keep the key in sync there.
const CLOCK_KEY = "clock";
// Read the same way by public/appearance-init.js
const APPEARANCE_KEY = "appearance";

// The panel's opacity in percent and its backdrop blur in px
export const PANEL_OPACITY_RANGE = { min: 0, max: 100 } as const;
export const PANEL_BLUR_RANGE = { min: 0, max: 40 } as const;

const FAVICON_PROVIDERS = ["google", "duckduckgo", "chrome"] as const;

const TIME_FORMATS = ["24h", "12h"] as const;

// How often the Unsplash photo changes: on every new tab, or at the start of every
// hour or day of the local wall clock
const ROTATIONS = ["tab", "hour", "day"] as const;

const BG_MODES = ["solid", "file", "url", "unsplash", "bing"] as const;

const UNSPLASH_SOURCES = ["curated", "collection"] as const;

const IMAGE_QUALITIES = ["hd", "fhd", "qhd", "uhd", "original"] as const;
type ImageQuality = (typeof IMAGE_QUALITIES)[number];

// The width of the requested Unsplash/Bing image. "original" has none: the photo's own size
// on Unsplash, Bing's UHD as is (it has nothing bigger, so the option is Unsplash-only).
export const IMAGE_WIDTHS: Record<ImageQuality, number | undefined> = {
  hd: 1280,
  fhd: 1920,
  qhd: 2560,
  uhd: 3840,
  original: undefined,
};

// Bing image-of-the-day markets, as listed in Bing's own region picker. Each has its
// own image feed and changes it at local midnight in the market's time zone.
export const BING_MARKETS = [
  "en-US",
  "en-GB",
  "ja-JP",
  "de-DE",
  "fr-FR",
  "es-ES",
  "pt-BR",
  "en-IN",
  "en-CA",
  "en-AU",
  "zh-CN",
  "it-IT",
] as const;
const FALLBACK_BING_MARKET = "en-US";

type TimeFormat = (typeof TIME_FORMATS)[number];
type BingMarket = (typeof BING_MARKETS)[number];

// The market for the first of the browser's preferred languages whose region has one.
// Every market is the only one in its region, so matching by region is enough; a
// language without a region is expanded to its likely one first (de → de-DE, ja → ja-JP).
export function defaultBingMarket(languages: readonly string[] = navigator.languages): BingMarket {
  for (const language of languages) {
    let region: string | undefined;
    try {
      region = new Intl.Locale(language).maximize().region;
    } catch {
      // RangeError on a malformed language tag
      continue;
    }
    const market = BING_MARKETS.find((m) => m.endsWith(`-${region}`));
    if (market) {
      return market;
    }
  }
  return FALLBACK_BING_MARKET;
}

// The clock format of the browser's preferred language: 12h in en-US, 24h in de-DE.
// public/clock-init.js falls back to the same one before the settings are mirrored.
export function defaultTimeFormat(languages: readonly string[] = navigator.languages): TimeFormat {
  let hour12: boolean | undefined;
  try {
    hour12 = new Intl.DateTimeFormat([...languages], { hour: "numeric" }).resolvedOptions().hour12;
  } catch {
    // RangeError on a malformed language tag
  }
  return hour12 ? "12h" : "24h";
}

// What depends on a setting, refreshed when it changes. "backgroundCache": the cached image
// is stale. The "clock" and "appearance" settings are also the ones mirrored for the
// early-paint scripts.
export type Effect = "background" | "backgroundCache" | "clock" | "appearance" | "bookmarks";

// A setting's default value and how a raw value (a form field's, a stored or imported one)
// becomes a valid one
interface Value<T> {
  default: T;
  normalize(value: unknown): T;
}

interface Setting<T> extends Value<T> {
  affects: readonly Effect[];
}

function oneOf<const T extends readonly string[]>(
  values: T,
  fallback: T[number],
): Value<T[number]> {
  return {
    default: fallback,
    normalize: (value) =>
      (values as readonly unknown[]).includes(value) ? (value as T[number]) : fallback,
  };
}

function flag(fallback: boolean): Value<boolean> {
  return {
    default: fallback,
    normalize: (value) => (typeof value === "boolean" ? value : fallback),
  };
}

function text({ trim = true } = {}): Value<string> {
  return {
    default: "",
    normalize: (value) => (typeof value !== "string" ? "" : trim ? value.trim() : value),
  };
}

// What <input type="color"> gives; an imported file may hold anything
function color(fallback: string): Value<string> {
  return {
    default: fallback,
    normalize: (value) =>
      typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback,
  };
}

// A whole number within the range; anything that isn't a number becomes the default
function intIn(range: { min: number; max: number }, fallback: number): Value<number> {
  return {
    default: fallback,
    normalize: (value) => {
      const number = value === "" ? NaN : Number(value);
      if (!Number.isFinite(number)) {
        return fallback;
      }
      return Math.min(range.max, Math.max(range.min, Math.round(number)));
    },
  };
}

// Every setting: its type, default, normalization and what it affects
const SCHEMA = {
  bgMode: { ...oneOf(BG_MODES, "unsplash"), affects: ["background"] },
  solidColor: { ...color("#16181d"), affects: ["background"] },
  bgDim: { ...flag(true), affects: ["background"] },
  showTime: { ...flag(true), affects: ["clock"] },
  showDate: { ...flag(true), affects: ["clock"] },
  timeFormat: { ...oneOf(TIME_FORMATS, defaultTimeFormat()), affects: ["clock"] },
  panelOpacity: { ...intIn(PANEL_OPACITY_RANGE, 85), affects: ["appearance"] },
  panelBlur: { ...intIn(PANEL_BLUR_RANGE, 24), affects: ["appearance"] },
  faviconProvider: { ...oneOf(FAVICON_PROVIDERS, "chrome"), affects: ["bookmarks"] },
  unsplashSource: {
    ...oneOf(UNSPLASH_SOURCES, "curated"),
    affects: ["background", "backgroundCache"],
  },
  // Used only with unsplashSource "collection"
  unsplashCollection: { ...text(), affects: ["background", "backgroundCache"] },
  rotate: { ...oneOf(ROTATIONS, "hour"), affects: ["background"] },
  // Not "backgroundCache": the cache keeps the full-size image, sized when shown
  imageQuality: { ...oneOf(IMAGE_QUALITIES, "uhd"), affects: ["background"] },
  bingMarket: {
    ...oneOf(BING_MARKETS, defaultBingMarket()),
    affects: ["background", "backgroundCache"],
  },
  imageUrl: { ...text(), affects: ["background"] },
  // Only the name, shown in the settings; the file itself is in core/image-file.ts
  imageFileName: { ...text({ trim: false }), affects: ["background", "backgroundCache"] },
} satisfies Record<string, Setting<unknown>>;

export type Settings = { [K in keyof typeof SCHEMA]: (typeof SCHEMA)[K]["default"] };

// Raw settings-form values, before normalization
export type SettingsInput = {
  [K in keyof Settings]: Settings[K] extends number
    ? string | number
    : Settings[K] extends boolean
      ? boolean
      : string;
};

const KEYS = Object.keys(SCHEMA) as (keyof Settings)[];

export const DEFAULT_SETTINGS = Object.fromEntries(
  KEYS.map((key) => [key, SCHEMA[key].default]),
) as Settings;

// The settings that `effect` depends on
export function keysAffecting(effect: Effect): (keyof Settings)[] {
  return KEYS.filter((key) => (SCHEMA[key].affects as readonly Effect[]).includes(effect));
}

const settingsItem = storage.defineItem<Settings>("local:settings", {
  fallback: DEFAULT_SETTINGS,
});

// The module caches the settings: loadSettings() is called once on startup,
// after which every read goes through getSettings() synchronously
let settings: Settings = DEFAULT_SETTINGS;

function normalize(values: SettingsInput): Settings {
  return Object.fromEntries(
    KEYS.map((key) => [key, SCHEMA[key].normalize(values[key])]),
  ) as Settings;
}

function pick(values: Settings, keys: (keyof Settings)[]): Partial<Settings> {
  return Object.fromEntries(keys.map((key) => [key, values[key]]));
}

// The settings applied before the first paint, by scripts that can't wait for browser.storage
function mirrorEarlySettings(values: Settings) {
  localStorage.setItem(CLOCK_KEY, JSON.stringify(pick(values, keysAffecting("clock"))));
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify(pick(values, keysAffecting("appearance"))));
}

// The Unsplash collection to show photos of, "" for the backend's curated one. A collection
// source without an ID falls back to the curated one.
export function unsplashCollectionId(values: Settings): string {
  return values.unsplashSource === "collection" ? values.unsplashCollection : "";
}

export async function loadSettings(): Promise<Settings> {
  settings = { ...DEFAULT_SETTINGS, ...(await settingsItem.getValue()) };
  mirrorEarlySettings(settings);
  return settings;
}

export function getSettings(): Settings {
  return settings;
}

export async function saveSettings(values: SettingsInput): Promise<Settings> {
  settings = normalize(values);
  await settingsItem.setValue(settings);
  mirrorEarlySettings(settings);
  return settings;
}

// Settings files, exported and imported in the settings panel. The background image file
// stays on its device (it is in IndexedDB, not in the settings), so its name isn't exported
// either, and an import keeps the current one.
const SETTINGS_FILE_FORMAT = "kMarkTab-settings";
const SETTINGS_FILE_VERSION = 1;
const PORTABLE_KEYS = (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).filter(
  (key) => key !== "imageFileName",
);
export type PortableSettings = Omit<Settings, "imageFileName">;

export function settingsToJson(values: Settings): string {
  const settings = Object.fromEntries(PORTABLE_KEYS.map((key) => [key, values[key]]));
  return JSON.stringify(
    { format: SETTINGS_FILE_FORMAT, version: SETTINGS_FILE_VERSION, settings },
    null,
    2,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// undefined for anything but a settings file. A missing value or one of the wrong type
// becomes the default, so an import replaces every setting; saveSettings() normalizes the rest.
export function settingsFromJson(text: string): PortableSettings | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !isRecord(data) ||
    data.format !== SETTINGS_FILE_FORMAT ||
    data.version !== SETTINGS_FILE_VERSION ||
    !isRecord(data.settings)
  ) {
    return undefined;
  }
  const imported = data.settings;
  return Object.fromEntries(
    PORTABLE_KEYS.map((key) => {
      const value = imported[key];
      return [key, typeof value === typeof DEFAULT_SETTINGS[key] ? value : DEFAULT_SETTINGS[key]];
    }),
  ) as PortableSettings;
}
