import { storage } from "#imports";
import { browser } from "wxt/browser";
import { q } from "../core/dom";
import { loadImageFile } from "../core/image-file";
import { getSettings, IMAGE_WIDTHS, unsplashCollectionId } from "../core/settings";

// kMarkTab-backend: serves Unsplash photos in decks of 30, so the extension needs no key of
// its own. The URL is set at build time, in .env.
const BACKEND_URL: string = import.meta.env.WXT_BACKEND_URL;
// Attribution per the Unsplash API guidelines
// https://help.unsplash.com/en/articles/2511315-guideline-attribution
const UNSPLASH_UTM = "utm_source=kMarkTab&utm_medium=referral";
// Not a documented API, but the feed of bing.com's own home page; needs no key
const BING_ORIGIN = "https://www.bing.com";
const BING_ENDPOINT = `${BING_ORIGIN}/HPImageArchive.aspx`;
// An optional permission (wxt.config.ts), asked for when Bing is chosen. Only the feed
// needs it: the image itself is loaded like any other.
const BING_ACCESS = { origins: [`${BING_ORIGIN}/*`] };
const NO_BING_ACCESS = "Bing needs access to bing.com: allow it under Background";

type ImageSource = "unsplash" | "bing";

interface BackgroundCredit {
  // Unsplash: the photographer; Bing: the image description ending in "(© Author/Agency)"
  name: string;
  // Unsplash: the photographer's profile; Bing: a Bing search about the image
  link: string;
}

interface CachedImage {
  // The full-size image: the quality is applied by sizedUrl() when it is shown
  url: string;
  at: number;
  credit?: BackgroundCredit;
}

type BackgroundCache =
  | (CachedImage & { source: "unsplash" })
  // until: when the next image of the day is due
  | (CachedImage & { source: "bing"; until: number });

const backgroundCacheItem = storage.defineItem<BackgroundCache | null>("local:background", {
  fallback: null,
});

// A photo of a deck, as the backend sends it (the fields we use)
interface BackendPhoto {
  id: string;
  // urls.raw: sizedUrl() adds the imgix parameters
  url: string;
  author: { name: string; link: string };
}

// The photos of the last deck not shown yet. Each rotation takes the next one, so a deck
// of 30 lasts 30 rotations; the next one is asked for when DECK_LOW are left.
interface UnsplashDeck {
  // unsplashCollectionId() it came from ("" for the curated collection): a deck of another
  // collection is not used
  collection: string;
  photos: BackendPhoto[];
  // The backend turned the last request away: no new request before `until`, and with an
  // empty deck the error is shown as is
  blocked?: { until: number; message: string };
}

const deckItem = storage.defineItem<UnsplashDeck | null>("local:unsplashDeck", {
  fallback: null,
});

// Sent with the requests for a user's collection, which the backend limits per install
const installIdItem = storage.defineItem<string>("local:installId", {
  init: () => crypto.randomUUID(),
});

const root = document.documentElement;
const creditEl = q<HTMLDivElement>("#bg-credit");
const creditUnsplashEl = q<HTMLSpanElement>("#bg-credit-unsplash");
const creditAuthorEl = q<HTMLAnchorElement>("#bg-credit-author");
const creditBingEl = q<HTMLAnchorElement>("#bg-credit-bing");
const statusEl = q<HTMLDivElement>("#bg-status");
const statusTextEl = q<HTMLSpanElement>("#bg-status-text");

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// setTimeout overflows past 2^31-1 ms (~24.8 days) and fires immediately
const MAX_TIMER_MS = 2 ** 31 - 1;
// How soon to ask Bing again when the image of the day isn't there yet (see
// fetchBingImage) or the request failed
const BING_RETRY_MS = 15 * MINUTE_MS;
// Photos left in the deck when the next one is fetched, while they are still shown
const DECK_LOW = 5;
// How long a failed deck request holds back the next one when the backend doesn't say
// (no Retry-After, or the network failed)
const DECK_RETRY_MS = 5 * MINUTE_MS;

// Object URL of the stored image file, made once and kept for the page's lifetime.
// Never revoked: it may still be the shown background, and revoking it could drop
// the image on the next repaint. clearCache() forgets it when another file is picked.
let fileUrl: string | undefined;

let rotateTimer: ReturnType<typeof setTimeout> | undefined;
// With rotate "tab", an image fetched since then is this tab's own and stays
const pageOpenedAt = Date.now();
// The deck request in flight, shared by a refill in the background and a rotation that
// found the deck empty
let deckRequest: { collection: string; deck: Promise<UnsplashDeck> } | undefined;
// Bumped by every refreshBackground(): a fetch or an image load that finishes after
// a newer refresh (settings saved, mode switched) must not overwrite its result.
let generation = 0;

export type BackgroundStatus =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string };

let currentStatus: BackgroundStatus = { state: "idle" };
const statusListeners: ((status: BackgroundStatus) => void)[] = [];

// Calls `listener` with the current status, then on every change
export function onStatusChange(listener: (status: BackgroundStatus) => void) {
  statusListeners.push(listener);
  listener(currentStatus);
}

// #bg-status is a live region, so it is never hidden: in the idle state it is empty
// and takes no space. Only the error text is announced; the loader is purely visual.
function setStatus(status: BackgroundStatus) {
  currentStatus = status;
  statusListeners.forEach((listener) => listener(status));
  statusEl.dataset.state = status.state;
  statusTextEl.textContent = status.state === "error" ? status.message : "";
  // the error text is truncated on narrow windows, so the tooltip carries it in full
  statusEl.title =
    status.state === "loading"
      ? "Loading background…"
      : status.state === "error"
        ? status.message
        : "";
}

function showCredit(image: BackgroundCache | undefined) {
  if (!image?.credit) {
    creditEl.hidden = true;
    return;
  }
  const { source, credit } = image;
  if (source === "bing") {
    creditBingEl.textContent = credit.name;
    creditBingEl.href = credit.link;
  } else {
    creditAuthorEl.textContent = credit.name;
    creditAuthorEl.href = `${credit.link}?${UNSPLASH_UTM}`;
  }
  creditUnsplashEl.hidden = source !== "unsplash";
  creditBingEl.hidden = source !== "bing";
  creditEl.hidden = false;
}

function applySolidBackground(color: string) {
  setStatus({ state: "idle" });
  document.body.classList.remove("bg-loaded");
  root.style.setProperty("--bg-image", "none");
  root.style.setProperty("--bg-page", color);
  showCredit(undefined);
}

// image: the cached image the URL comes from, for the credit
function applyImageBackground(url: string, gen: number, image?: BackgroundCache) {
  const cssValue = `url("${url}")`;
  if (root.style.getPropertyValue("--bg-image") === cssValue) {
    setStatus({ state: "idle" });
    return;
  }
  root.style.removeProperty("--bg-page");
  setStatus({ state: "loading" });
  const img = new Image();
  img.onload = () => {
    if (gen !== generation) {
      return;
    }
    root.style.setProperty("--bg-image", cssValue);
    document.body.classList.add("bg-loaded");
    showCredit(image);
    setStatus({ state: "idle" });
  };
  img.onerror = () => {
    if (gen !== generation) {
      return;
    }
    setStatus({ state: "error", message: "Couldn't load the background image" });
  };
  img.src = url;
}

// Loaded as is on every refresh: no rotation, no sizing, and no cache besides the
// browser's own HTTP cache
function applyUrlBackground(rawUrl: string, gen: number) {
  if (!rawUrl) {
    setStatus({ state: "error", message: "No image URL" });
    return;
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    setStatus({ state: "error", message: "Invalid image URL" });
    return;
  }
  // Also keeps the URL safe inside url("…"): the parser percent-encodes quotes in
  // http(s) URLs, but not in opaque ones like data:
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    setStatus({ state: "error", message: "Image URL must be http(s)" });
    return;
  }
  applyImageBackground(url.href, gen);
}

async function applyFileBackground(gen: number) {
  if (!fileUrl) {
    let file: Blob | undefined;
    try {
      file = await loadImageFile();
    } catch (err) {
      console.error("Reading the background image file failed:", err);
    }
    if (gen !== generation) {
      return;
    }
    if (!file) {
      setStatus({ state: "error", message: "No image file" });
      return;
    }
    fileUrl = URL.createObjectURL(file);
  }
  applyImageBackground(fileUrl, gen);
}

// The cached image in the selected quality. Applied when shown rather than when fetched, so
// another quality is the same image, not a new request.
function sizedUrl(image: BackgroundCache): string {
  const width = IMAGE_WIDTHS[getSettings().imageQuality];
  const url = new URL(image.url);
  if (image.source === "unsplash") {
    const params = new URLSearchParams("ixlib=rb-4.1.0&fm=avif&crop=entropy&cs=srgb&q=80");
    if (width) {
      params.set("w", String(width));
    }
    for (const [key, value] of params) {
      url.searchParams.set(key, value);
    }
  } else {
    // `w` scales the 3840px _UHD original down on Bing's side (never up), and without
    // `qlt` the JPEG comes noticeably more compressed
    if (width) {
      url.searchParams.set("w", String(width));
    }
    url.searchParams.set("qlt", "90");
  }
  return url.toString();
}

// A deck request the backend turned away, with how long to hold back the next one
class DeckError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

function deckErrorMessage(status: number, code: unknown): string {
  switch (code) {
    case "collectionNotFound":
      return "Unsplash: no such public collection";
    case "invalidCollection":
      return "Unsplash: invalid collection ID";
    case "tooManyRequests":
      return "Unsplash: too many requests, try again later";
    case "curatedNotReady":
    case "budgetExhausted":
    case "upstream":
      return "Unsplash is unavailable for now, try again later";
    default:
      return `Unsplash error ${status}`;
  }
}

// The curated collection when `collection` is empty, else that collection
async function fetchDeck(collection: string): Promise<BackendPhoto[]> {
  const headers: Record<string, string> = {};
  let path = "v1/curated";
  if (collection) {
    path = `v1/collections/${encodeURIComponent(collection)}`;
    headers["X-Install-Id"] = await installIdItem.getValue();
  }
  let res: Response;
  try {
    res = await fetch(new URL(path, `${BACKEND_URL}/`), { headers });
  } catch {
    // fetch() rejects with a bare TypeError ("Failed to fetch") on network errors
    throw new DeckError("Couldn't reach Unsplash", DECK_RETRY_MS);
  }
  if (!res.ok) {
    const body: { error?: unknown } = await res.json().catch(() => ({}));
    const retryAfter = Number(res.headers.get("Retry-After"));
    throw new DeckError(
      deckErrorMessage(res.status, body.error),
      retryAfter > 0 ? retryAfter * 1000 : DECK_RETRY_MS,
    );
  }
  const data: { photos: BackendPhoto[] } = await res.json();
  return data.photos;
}

// The next deck appended to what is left of the stored one, or the stored one marked blocked
// if the request fails. Merged with the deck as stored when the response comes, since
// another tab may have taken a photo of it meanwhile; a photo already in it isn't added
// twice.
function refillDeck(collection: string): Promise<UnsplashDeck> {
  if (deckRequest?.collection === collection) {
    return deckRequest.deck;
  }
  const request = {
    collection,
    deck: (async () => {
      let update: (deck: UnsplashDeck) => UnsplashDeck;
      try {
        const photos = await fetchDeck(collection);
        update = (deck) => {
          const ids = new Set(deck.photos.map((photo) => photo.id));
          return { collection, photos: [...deck.photos, ...photos.filter((p) => !ids.has(p.id))] };
        };
      } catch (err) {
        console.error("Fetching an Unsplash deck failed:", err);
        const blocked =
          err instanceof DeckError
            ? { until: Date.now() + err.retryAfterMs, message: err.message }
            : { until: Date.now() + DECK_RETRY_MS, message: "Unsplash: invalid response" };
        update = (deck) => ({ ...deck, blocked });
      }
      const stored = await deckItem.getValue();
      const next = update(stored?.collection === collection ? stored : { collection, photos: [] });
      // a deck of another collection is not replaced by one that is no longer wanted
      if (unsplashCollectionId(getSettings()) === collection) {
        await deckItem.setValue(next);
      }
      return next;
    })().finally(() => {
      if (deckRequest === request) {
        deckRequest = undefined;
      }
    }),
  };
  deckRequest = request;
  return request.deck;
}

function isBlocked(deck: UnsplashDeck): boolean {
  return deck.blocked !== undefined && Date.now() < deck.blocked.until;
}

// The next photo of the deck, fetching a deck first when it is empty. A deck running low is
// refilled in the background.
async function nextUnsplashImage(): Promise<BackgroundCache> {
  const collection = unsplashCollectionId(getSettings());
  const stored = await deckItem.getValue();
  let deck: UnsplashDeck = stored?.collection === collection ? stored : { collection, photos: [] };
  if (deck.photos.length === 0) {
    if (!isBlocked(deck)) {
      deck = await refillDeck(collection);
    }
    if (deck.photos.length === 0) {
      throw deck.blocked
        ? new DeckError(deck.blocked.message, deck.blocked.until - Date.now())
        : new Error("Unsplash: the collection has no photos");
    }
  }
  const [photo, ...rest] = deck.photos;
  const remaining = { ...deck, photos: rest };
  await deckItem.setValue(remaining);
  if (rest.length <= DECK_LOW && !isBlocked(remaining)) {
    void refillDeck(collection);
  }
  return {
    source: "unsplash",
    url: photo!.url,
    at: Date.now(),
    credit: { name: photo!.author.name, link: photo!.author.link },
  };
}

// "YYYYMMDDHHmm" in UTC
function parseBingTime(value: string): number {
  const part = (start: number, end: number) => Number(value.slice(start, end));
  return Date.UTC(part(0, 4), part(4, 6) - 1, part(6, 8), part(8, 10), part(10, 12));
}

// Bing changes the image of the day at local midnight in the market's time zone, so the
// next one is due a day after the current one started. On the days the market's clocks
// change, the day is 23 or 25 hours long: on a short day the old image stays an hour
// longer, on a long day the request at +24h still gets the old image and is retried.
async function fetchBingImage(): Promise<BackgroundCache> {
  // Without the permission the request fails like a network error would
  if (!(await hasBingAccess())) {
    throw new Error(NO_BING_ACCESS);
  }
  const { bingMarket } = getSettings();
  const endpoint = new URL(BING_ENDPOINT);
  endpoint.searchParams.set("format", "js");
  endpoint.searchParams.set("idx", "0");
  endpoint.searchParams.set("n", "1");
  endpoint.searchParams.set("mkt", bingMarket);
  const res = await fetch(endpoint);
  if (!res.ok) {
    throw new Error(`Bing error ${res.status}`);
  }
  const data: {
    images: { fullstartdate: string; urlbase: string; copyright: string; copyrightlink: string }[];
  } = await res.json();
  const image = data.images[0];
  if (!image) {
    throw new Error("Bing: no image of the day");
  }
  // _UHD is the 3840px original
  const url = new URL(`${image.urlbase}_UHD.jpg`, BING_ORIGIN);
  const now = Date.now();
  const next = parseBingTime(image.fullstartdate) + DAY_MS;
  return {
    source: "bing",
    url: url.toString(),
    at: now,
    // A day after the start is already past when Bing is late with the new image, and
    // NaN (a malformed fullstartdate) fails the comparison as well: either way, ask again
    // soon rather than set a timer for the past, which would refetch in a loop.
    until: next > now ? next : now + BING_RETRY_MS,
    credit: { name: image.copyright, link: image.copyrightlink },
  };
}

// Local wall-clock time as a DST-free millisecond count, and back
function toWallClock(t: number): number {
  const d = new Date(t);
  return Date.UTC(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  );
}

function fromWallClock(wall: number): number {
  const d = new Date(wall);
  return new Date(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  ).getTime();
}

const ROTATION_MS = { hour: HOUR_MS, day: DAY_MS } as const;

// The rotation period containing the instant t, as [start, end) in wall-clock ms.
// Periods follow the local wall clock so that images change at predictable times,
// not relative to the fetch time: at :00 of every hour, or at local midnight.
function rotationPeriod(t: number, rotateMs: number): { start: number; end: number } {
  const start = Math.floor(toWallClock(t) / rotateMs) * rotateMs;
  return { start, end: start + rotateMs };
}

function isCurrent(cached: BackgroundCache): boolean {
  if (cached.source === "bing") {
    return Date.now() < cached.until;
  }
  const { rotate } = getSettings();
  if (rotate === "tab") {
    // the image this page has shown, not one of an earlier tab
    return cached.at >= pageOpenedAt;
  }
  const rotateMs = ROTATION_MS[rotate];
  return rotationPeriod(cached.at, rotateMs).start === rotationPeriod(Date.now(), rotateMs).start;
}

// Unsplash rotation is scheduled up front by scheduleNextRotation(); the next Bing
// refresh depends on the image of the day, so it is scheduled once that is known. A failed
// Unsplash deck with nothing to show instead is retried once the backend allows it.
function scheduleRefresh(at: number) {
  clearTimeout(rotateTimer);
  // +1s past the boundary, like scheduleNextRotation()
  const delay = Math.min(Math.max(at - Date.now(), 0) + 1000, MAX_TIMER_MS);
  rotateTimer = setTimeout(refreshBackground, delay);
}

async function rotateBackground(gen: number, source: ImageSource) {
  const stored = await backgroundCacheItem.getValue();
  if (gen !== generation) {
    return;
  }
  // an image from the other source is not a fallback either
  const cached = stored?.source === source ? stored : null;

  if (cached && isCurrent(cached)) {
    applyImageBackground(sizedUrl(cached), gen, cached);
    if (cached.source === "bing") {
      scheduleRefresh(cached.until);
    }
    return;
  }

  setStatus({ state: "loading" });
  try {
    const next = source === "bing" ? await fetchBingImage() : await nextUnsplashImage();
    if (gen !== generation) {
      return;
    }
    await backgroundCacheItem.setValue(next);
    applyImageBackground(sizedUrl(next), gen, next);
    if (next.source === "bing") {
      scheduleRefresh(next.until);
    }
  } catch (err) {
    if (gen !== generation) {
      return;
    }
    console.error("Background rotation failed:", err);
    if (source === "bing") {
      scheduleRefresh(Date.now() + BING_RETRY_MS);
    }
    // A stale cached image is still a working background, so the error is only
    // shown when there is nothing to fall back to.
    if (cached) {
      applyImageBackground(sizedUrl(cached), gen, cached);
      return;
    }
    // ...and then the deck is retried before the rotation would, if the backend allows it
    if (err instanceof DeckError && Date.now() + err.retryAfterMs < nextRotationAt()) {
      scheduleRefresh(Date.now() + err.retryAfterMs);
    }
    // A network error of Bing's fetch(): fetchDeck() turns those of Unsplash into DeckErrors
    if (err instanceof TypeError) {
      setStatus({ state: "error", message: "Couldn't reach Bing" });
    } else {
      setStatus({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }
}

// When the current rotation period ends; never for a new image per tab
function nextRotationAt(): number {
  const { rotate } = getSettings();
  if (rotate === "tab") {
    return Infinity;
  }
  // The boundary is on the hour, so it is never inside the hour repeated when clocks go
  // back: at worst its start, whose first occurrence is still ahead
  return fromWallClock(rotationPeriod(Date.now(), ROTATION_MS[rotate]).end);
}

function scheduleNextRotation() {
  clearTimeout(rotateTimer);
  const { bgMode, rotate } = getSettings();
  if (bgMode !== "unsplash" || rotate === "tab") {
    return;
  }
  // +1s so the timer is guaranteed to fire past the period boundary
  const delay = nextRotationAt() - Date.now() + 1000;
  rotateTimer = setTimeout(refreshBackground, delay);
}

export function refreshBackground() {
  const gen = ++generation;
  const settings = getSettings();
  document.body.classList.toggle("bg-dim", settings.bgDim);
  if (settings.bgMode === "solid") {
    applySolidBackground(settings.solidColor);
  } else if (settings.bgMode === "file") {
    void applyFileBackground(gen);
  } else if (settings.bgMode === "url") {
    applyUrlBackground(settings.imageUrl, gen);
  } else {
    void rotateBackground(gen, settings.bgMode);
  }
  scheduleNextRotation();
}

export async function clearCache() {
  fileUrl = undefined;
  await backgroundCacheItem.removeValue();
}

export function hasBingAccess(): Promise<boolean> {
  return browser.permissions.contains(BING_ACCESS);
}

// Call it from a user action, before any await: the browser shows its prompt only then
export function requestBingAccess(): Promise<boolean> {
  // rejected when called outside a user action
  return browser.permissions.request(BING_ACCESS).catch(() => false);
}

// Access granted or revoked, from this tab, another one or the browser's extension page
export function onBingAccessChange(listener: () => void) {
  browser.permissions.onAdded.addListener(listener);
  browser.permissions.onRemoved.addListener(listener);
}

export function startBackground() {
  refreshBackground();
  // Granted while the error was shown (or the prompt was open): the image can come now
  onBingAccessChange(() => {
    if (getSettings().bgMode === "bing") {
      refreshBackground();
    }
  });
}
