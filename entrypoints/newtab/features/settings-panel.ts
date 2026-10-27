import { browser } from "wxt/browser";
import { q, setScrollbarGutter } from "../core/dom";
import { deleteImageFile, saveImageFile } from "../core/image-file";
import {
  DEFAULT_SETTINGS,
  type Effect,
  getSettings,
  keysAffecting,
  PANEL_BLUR_RANGE,
  PANEL_OPACITY_RANGE,
  type Settings,
  type SettingsInput,
  saveSettings,
  settingsFromJson,
  settingsToJson,
  unsplashCollectionId,
} from "../core/settings";
import { applyAppearance } from "./appearance";
import { clearCache, onStatusChange, refreshBackground } from "./background";
import { focusSearch, rerenderBookmarks } from "./bookmarks";
import { applyClockSettings } from "./clock";

// Settings whose change costs a network request (or a new image): they are not applied as
// you type, but by the check button that appears next to a changed field, or Enter.
const COMMIT_KEYS = ["unsplashCollection", "imageUrl"] as const;
type CommitKey = (typeof COMMIT_KEYS)[number];

// Compared by unsplashCollectionId() in applyChange()
const UNSPLASH_KEYS = ["unsplashSource", "unsplashCollection"] as const;

// What each reset button restores (its data-reset), and what it announces
const RESET_SCOPES = {
  all: {
    keys: Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[],
    prompt: "Press again to restore default settings",
    done: "Default settings restored",
  },
  background: {
    keys: keysAffecting("background"),
    prompt: "Press again to reset the background settings",
    done: "Background settings restored",
  },
};
type ResetScope = keyof typeof RESET_SCOPES;

const settingsToggle = q<HTMLButtonElement>("#settings-toggle");
const settingsPanel = q<HTMLDialogElement>("#settings");
const settingsBody = q<HTMLDivElement>(".settings-body", settingsPanel);
const resetStatus = q<HTMLSpanElement>("#set-reset-status");
const panelStatus = q<HTMLParagraphElement>("#set-status");
const solidPreview = q<HTMLSpanElement>("#set-solid-preview");
const modeInputs = [...settingsPanel.querySelectorAll<HTMLInputElement>('input[name="bgMode"]')];
type Control = HTMLInputElement | HTMLSelectElement;

// Settings edited by something other than one #set-<key> control
const SPECIAL_KEYS = ["bgMode", "imageFileName"] as const;
type FieldKey = Exclude<keyof Settings, (typeof SPECIAL_KEYS)[number]>;
const FIELD_KEYS = (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).filter(
  (key): key is FieldKey => !(SPECIAL_KEYS as readonly string[]).includes(key),
);
const fields = {
  ...(Object.fromEntries(FIELD_KEYS.map((key) => [key, q<Control>(`#set-${key}`)])) as Record<
    FieldKey,
    Control
  >),
  imageFile: q<HTMLInputElement>("#set-imageFile"),
};

function isCheckbox(field: Control): field is HTMLInputElement {
  return field.type === "checkbox";
}

function fieldValue(field: Control): string | boolean {
  return isCheckbox(field) ? field.checked : field.value;
}

function setFieldValue(field: Control, value: Settings[FieldKey]) {
  if (isCheckbox(field)) {
    field.checked = Boolean(value);
  } else {
    field.value = String(value);
  }
}
const rangeValues = {
  panelOpacity: q<HTMLSpanElement>("#set-panelOpacity-value"),
  panelBlur: q<HTMLSpanElement>("#set-panelBlur-value"),
};
const systemOpaqueHint = q<HTMLSpanElement>("#set-system-opaque");
// Mirrors the media query in style.css that makes the panel opaque whatever the settings say
const systemOpaque = matchMedia(
  "(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)",
);
const imageFileNameEl = q<HTMLSpanElement>("#set-imageFile-name");
const importFile = q<HTMLInputElement>("#set-import-file");
const transferStatus = q<HTMLParagraphElement>("#set-transfer-status");
const summaries = {
  background: q<HTMLSpanElement>("#set-summary-background"),
  appearance: q<HTMLSpanElement>("#set-summary-appearance"),
  clock: q<HTMLSpanElement>("#set-summary-clock"),
  bookmarks: q<HTMLSpanElement>("#set-summary-bookmarks"),
  about: q<HTMLSpanElement>("#set-summary-about"),
};

function selectedMode(): string {
  return modeInputs.find((input) => input.checked)?.value ?? DEFAULT_SETTINGS.bgMode;
}

function syncImageFileName() {
  const name = getSettings().imageFileName;
  imageFileNameEl.textContent = name || "No file chosen";
  // long names are cut off with an ellipsis
  imageFileNameEl.title = name;
}

// Fields of the other modes are only hidden: they keep their values, so switching back
// (Bing → Unsplash) restores the previous choices.
function syncModeVisibility() {
  const mode = selectedMode();
  settingsPanel.querySelectorAll<HTMLElement>("[data-mode]").forEach((el) => {
    el.hidden = !el.dataset.mode?.split(" ").includes(mode);
  });
  syncImageQuality();
  syncUnsplashSource();
}

// The collection ID field is only there for the "Collection ID" source; hidden, it keeps
// its value for switching back
function syncUnsplashSource() {
  const source = fields.unsplashSource.value;
  settingsPanel.querySelectorAll<HTMLElement>("[data-unsplash-source]").forEach((el) => {
    el.hidden = el.dataset.unsplashSource !== source;
  });
}

// "Original" is Unsplash-only: Bing's original is its UHD, so the field shows that there.
// The stored choice is kept for switching back to Unsplash.
function syncImageQuality() {
  const { imageQuality } = getSettings();
  const original = imageQuality === "original" && selectedMode() !== "unsplash";
  fields.imageQuality.value = original ? "uhd" : imageQuality;
}

// Where a value sits on a slider, from 0 to 1
function rangeFraction(value: number, range: { min: number; max: number }): number {
  return (value - range.min) / (range.max - range.min);
}

const RANGES = { panelOpacity: PANEL_OPACITY_RANGE, panelBlur: PANEL_BLUR_RANGE } as const;

// A slider dragged this close to its default value (a share of its length) lands on it
const SNAP_DISTANCE = 0.04;
// The slider under the pointer: only dragging snaps, arrow keys must be able to step off
// the default
let draggedRange: Control | undefined;

function snapToDefault(key: keyof typeof RANGES) {
  const field = fields[key];
  const value = Number(field.value);
  const fallback = DEFAULT_SETTINGS[key];
  const distance = Math.abs(
    rangeFraction(value, RANGES[key]) - rangeFraction(fallback, RANGES[key]),
  );
  if (draggedRange === field && distance <= SNAP_DISTANCE) {
    field.value = String(fallback);
  }
}

// The sliders' values as shown and announced, and the filled part of their tracks. Blur does nothing behind an opaque panel, so
// its slider is disabled then.
function syncRanges(panelOpacity: number, panelBlur: number) {
  const text = { panelOpacity: `${panelOpacity}%`, panelBlur: `${panelBlur} px` };
  const values = { panelOpacity, panelBlur };
  for (const key of ["panelOpacity", "panelBlur"] as const) {
    rangeValues[key].textContent = text[key];
    fields[key].setAttribute("aria-valuetext", text[key]);
    fields[key].style.setProperty("--value-at", String(rangeFraction(values[key], RANGES[key])));
  }
  fields.panelBlur.disabled = panelOpacity >= PANEL_OPACITY_RANGE.max;
}

// The slider values that aren't stored yet while one is being dragged
function enteredAppearance(): Pick<Settings, "panelOpacity" | "panelBlur"> {
  return {
    panelOpacity: Number(fields.panelOpacity.value),
    panelBlur: Number(fields.panelBlur.value),
  };
}

// The hint is only in the opacity slider's description while it is shown: aria-describedby
// reads a hidden target too
function syncSystemOpaque() {
  systemOpaqueHint.hidden = !systemOpaque.matches;
  if (systemOpaque.matches) {
    fields.panelOpacity.setAttribute("aria-describedby", systemOpaqueHint.id);
  } else {
    fields.panelOpacity.removeAttribute("aria-describedby");
  }
}

function appearanceText({ panelOpacity, panelBlur }: Settings): string {
  if (systemOpaque.matches) {
    return "Opaque panel · system setting";
  }
  if (panelOpacity >= PANEL_OPACITY_RANGE.max) {
    return "Opaque panel";
  }
  return `Opacity ${panelOpacity}% · ${panelBlur ? `blur ${panelBlur} px` : "no blur"}`;
}

function optionText(select: Control, value: string): string {
  return select.querySelector(`option[value="${value}"]`)?.textContent ?? value;
}

// The line under a section's title: a summary of its values, updated as they change
function syncSummaries(values: Settings) {
  const background = {
    solid: "Solid color",
    file: values.imageFileName ? `Local file · ${values.imageFileName}` : "Local file",
    url: "Image URL",
    unsplash: `Unsplash · ${unsplashCollectionId(values) ? "collection" : "curated"} · ${optionText(fields.rotate, values.rotate).toLowerCase()}`,
    bing: `Bing · ${optionText(fields.bingMarket, values.bingMarket)}`,
  };
  summaries.background.textContent = background[values.bgMode];
  summaries.appearance.textContent = appearanceText(values);
  const clock = [values.showTime && "time", values.showDate && "date"]
    .filter(Boolean)
    .join(" and ");
  summaries.clock.textContent = clock
    ? `Shows ${clock}${values.showTime ? ` · ${values.timeFormat}` : ""}`
    : "Hidden";
  summaries.bookmarks.textContent = `Favicons: ${optionText(fields.faviconProvider, values.faviconProvider)}`;
}

// The About section: name and version from the manifest. The store reviews are addressed by
// the extension id, which is the store's id once installed from it (an unpacked build gets
// its own, so the link only works in a store install). Firefox builds are not on that store.
function initAbout() {
  const { name, version } = browser.runtime.getManifest();
  q<HTMLParagraphElement>("#set-about-name").textContent = name;
  q<HTMLParagraphElement>("#set-about-version").textContent = `Version ${version}`;
  summaries.about.textContent = `Version ${version}`;
  const review = q<HTMLAnchorElement>("#set-about-review");
  if (import.meta.env.BROWSER === "firefox") {
    review.hidden = true;
  } else {
    review.href = `https://chromewebstore.google.com/detail/${browser.runtime.id}/reviews`;
  }
}

function settingRow(key: CommitKey): HTMLElement {
  const row = fields[key].closest<HTMLElement>(".setting");
  if (!row) {
    throw new Error(`no .setting around the ${key} field`);
  }
  return row;
}

// A commit field is pending while its value differs from the stored one. The "not applied"
// line describes its field only then: aria-describedby reads a hidden target too.
function syncPending(key: CommitKey) {
  const row = settingRow(key);
  const field = fields[key];
  const pending = field.value !== getSettings()[key];
  row.toggleAttribute("data-pending", pending);
  const pendingId = q(".setting-pending", row).id;
  const ids = (field.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id && id !== pendingId);
  if (pending) {
    ids.push(pendingId);
  }
  if (ids.length) {
    field.setAttribute("aria-describedby", ids.join(" "));
  } else {
    field.removeAttribute("aria-describedby");
  }
}

function populateFields(values: Settings) {
  for (const input of modeInputs) {
    input.checked = input.value === values.bgMode;
  }
  for (const key of FIELD_KEYS) {
    setFieldValue(fields[key], values[key]);
  }
  solidPreview.style.background = values.solidColor;
  syncRanges(values.panelOpacity, values.panelBlur);
  syncSystemOpaque();
  fields.imageFile.value = "";
  syncImageFileName();
  for (const key of COMMIT_KEYS) {
    syncPending(key);
  }
  syncModeVisibility();
  syncSummaries(values);
}

// Stores the stored settings with `change` applied and refreshes whatever depends on the
// changed ones. `newFile`: a file was just picked, which may have the same name as the old one.
async function applyChange(change: Partial<SettingsInput>, newFile = false): Promise<Settings> {
  const prev = getSettings();
  const next = await saveSettings({ ...prev, ...change });
  if (!next.imageFileName && prev.imageFileName) {
    await deleteImageFile();
  }
  // The Unsplash source and ID count by the collection they make: "Collection ID" with an
  // empty ID applied is still the curated one, and must not bring a new photo
  const keyChanged = (key: keyof Settings) =>
    (UNSPLASH_KEYS as readonly string[]).includes(key)
      ? unsplashCollectionId(prev) !== unsplashCollectionId(next)
      : prev[key] !== next[key];
  const changed = (effect: Effect) => keysAffecting(effect).some(keyChanged);
  // clearCache must run before refreshBackground, or it would read the stale cache
  if (changed("backgroundCache") || newFile) {
    await clearCache();
  }
  if (changed("background") || newFile) {
    refreshBackground();
  }
  if (changed("clock")) {
    applyClockSettings();
  }
  if (changed("appearance")) {
    applyAppearance();
  }
  if (changed("bookmarks")) {
    rerenderBookmarks();
  }
  syncSummaries(next);
  return next;
}

async function commitField(key: CommitKey) {
  const field = fields[key];
  const entered = field.value;
  const change: Partial<SettingsInput> = {};
  change[key] = entered;
  if (key === "unsplashCollection" && entered.trim()) {
    // the source chosen along with it, not stored until there is an ID
    change.unsplashSource = fields.unsplashSource.value;
  }
  const next = await applyChange(change);
  // Shows what normalization made of the value (trimmed), unless the field was edited
  // again while the change was being applied
  if (field.value === entered) {
    field.value = next[key];
  }
  syncPending(key);
}

function revertField(key: CommitKey) {
  fields[key].value = getSettings()[key];
  syncPending(key);
}

async function commitImageFile() {
  const file = fields.imageFile.files?.[0];
  if (!file) {
    return;
  }
  try {
    // stored before the settings, so that they never name a file that isn't there
    await saveImageFile(file);
    await applyChange({ imageFileName: file.name }, true);
  } catch {
    panelStatus.textContent = "Couldn't save the image file";
  } finally {
    // cleared even on failure: picking the same file again must fire `change` again
    fields.imageFile.value = "";
    syncImageFileName();
  }
}

function exportSettings() {
  transferStatus.textContent = "";
  const blob = new Blob([settingsToJson(getSettings())], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "kMarkTab-settings.json";
  link.click();
  // revoked a moment later: Firefox fails the download if the URL goes away right after click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// Replaces every setting but the background image file, which stays on this device
async function importSettings() {
  const file = importFile.files?.[0];
  if (!file) {
    return;
  }
  // emptied first, so that importing again announces the same message again
  transferStatus.textContent = "";
  try {
    const values = settingsFromJson(await file.text());
    if (!values) {
      transferStatus.textContent = "Not a kMarkTab settings file";
      return;
    }
    const next = await applyChange(values);
    populateFields(next);
    transferStatus.textContent =
      next.bgMode === "file" && !next.imageFileName
        ? "Settings imported. The image file isn't part of them: choose it under Background"
        : "Settings imported";
  } catch {
    transferStatus.textContent = "Couldn't import the settings";
  } finally {
    // picking the same file again must fire `change` again
    importFile.value = "";
  }
}

function openSettings() {
  populateFields(getSettings());
  settingsPanel.showModal();
  // measured once shown: the closed dialog isn't laid out
  setScrollbarGutter(settingsBody);
}

// A reset needs a second click on the same button. The armed state expires on its own,
// and is also dropped on blur and when the panel closes.
const RESET_CONFIRM_MS = 3000;
let resetConfirmTimer: ReturnType<typeof setTimeout> | undefined;
let armedReset: HTMLButtonElement | undefined;

function disarmReset() {
  clearTimeout(resetConfirmTimer);
  resetConfirmTimer = undefined;
  armedReset?.removeAttribute("data-confirming");
  armedReset = undefined;
  // cleared so that arming again changes the text and gets announced again
  resetStatus.textContent = "";
}

async function restoreDefaults(keys: (keyof Settings)[]) {
  const defaults = Object.fromEntries(keys.map((key) => [key, DEFAULT_SETTINGS[key]]));
  populateFields(await applyChange(defaults));
}

function onResetClick(e: MouseEvent) {
  const button = e.currentTarget as HTMLButtonElement;
  const scope = RESET_SCOPES[button.dataset.reset as ResetScope];
  if (armedReset !== button) {
    disarmReset();
    armedReset = button;
    button.setAttribute("data-confirming", "");
    resetStatus.textContent = scope.prompt;
    resetConfirmTimer = setTimeout(disarmReset, RESET_CONFIRM_MS);
    return;
  }
  disarmReset();
  resetStatus.textContent = scope.done;
  void restoreDefaults(scope.keys);
}

// See the pointerdown handler in initSettingsPanel
let colorPickerOpen = false;

function closeSettings() {
  settingsPanel.close();
}

// Runs however the dialog closes: the close button, Escape, a click outside. Pending edits
// of the commit fields are dropped: opening the panel again shows the stored values.
function onSettingsClosed() {
  colorPickerOpen = false;
  disarmReset();
  transferStatus.textContent = "";
  focusSearch();
}

function initCommitField(key: CommitKey) {
  const button = q<HTMLButtonElement>(".commit-button", settingRow(key));
  // typed as HTMLElement: the listeners of a union of element types get a plain Event
  const field: HTMLElement = fields[key];
  field.addEventListener("input", () => syncPending(key));
  field.addEventListener("change", () => syncPending(key));
  field.addEventListener("keydown", (e) => {
    // Enter also confirms an IME candidate; that one is not a commit
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      void commitField(key);
    } else if (e.key === "Escape" && settingRow(key).hasAttribute("data-pending")) {
      // Reverts the field instead of closing the dialog: a canceled Escape keydown
      // doesn't make a close request
      e.preventDefault();
      revertField(key);
    }
  });
  button.addEventListener("click", () => {
    // the button disappears once the value is applied; focus goes back to its field
    field.focus();
    void commitField(key);
  });
}

export function initSettingsPanel() {
  settingsToggle.addEventListener("click", openSettings);
  q<HTMLButtonElement>("#set-close").addEventListener("click", closeSettings);
  settingsPanel.addEventListener("close", onSettingsClosed);
  window.addEventListener("resize", () => {
    if (settingsPanel.open) {
      setScrollbarGutter(settingsBody);
    }
  });
  initAbout();

  // The page behind the modal dialog is inert, so #bg-status isn't announced while the
  // dialog is open: its errors are repeated in the dialog's own live region. Only one of
  // the two is in the accessibility tree at a time, so nothing is announced twice.
  onStatusChange((status) => {
    panelStatus.textContent = status.state === "error" ? status.message : "";
  });

  for (const input of modeInputs) {
    input.addEventListener("change", () => {
      syncModeVisibility();
      void applyChange({ bgMode: input.value });
    });
  }
  fields.solidColor.addEventListener("input", () => {
    solidPreview.style.background = fields.solidColor.value;
  });
  // Every field but the commit ones and the Unsplash source is stored as soon as it changes
  for (const key of FIELD_KEYS) {
    if (!(COMMIT_KEYS as readonly string[]).includes(key) && key !== "unsplashSource") {
      const field = fields[key];
      field.addEventListener("change", () => applyChange({ [key]: fieldValue(field) }));
    }
  }
  // The sliders preview as they move and are stored once released (or on each key press)
  for (const key of ["panelOpacity", "panelBlur"] as const) {
    const field = fields[key];
    const range = RANGES[key];
    field.setAttribute("min", String(range.min));
    field.setAttribute("max", String(range.max));
    field.parentElement?.style.setProperty(
      "--default-at",
      String(rangeFraction(DEFAULT_SETTINGS[key], range)),
    );
    field.addEventListener("pointerdown", () => {
      draggedRange = field;
    });
    field.addEventListener("input", () => {
      snapToDefault(key);
      const entered = enteredAppearance();
      syncRanges(entered.panelOpacity, entered.panelBlur);
      applyAppearance(entered);
    });
  }
  for (const type of ["pointerup", "pointercancel"]) {
    document.addEventListener(type, () => {
      draggedRange = undefined;
    });
  }
  systemOpaque.addEventListener("change", () => {
    syncSystemOpaque();
    syncSummaries(getSettings());
  });
  // "Collection ID" with no stored ID only shows the field: the source is stored with the
  // ID, once it is applied
  fields.unsplashSource.addEventListener("change", () => {
    syncUnsplashSource();
    const source = fields.unsplashSource.value;
    if (source === "collection" && !getSettings().unsplashCollection) {
      fields.unsplashCollection.focus();
    } else {
      void applyChange({ unsplashSource: source });
    }
  });
  fields.imageFile.addEventListener("change", commitImageFile);
  q<HTMLButtonElement>("#set-export").addEventListener("click", exportSettings);
  q<HTMLButtonElement>("#set-import").addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", importSettings);
  COMMIT_KEYS.forEach(initCommitField);

  settingsPanel.querySelectorAll<HTMLButtonElement>("[data-reset]").forEach((button) => {
    button.addEventListener("click", onResetClick);
    button.addEventListener("blur", disarmReset);
  });
  // The native color picker is not part of the DOM, and the click that dismisses it still
  // reaches the page as an outside pointerdown. There's no API to ask whether the picker is
  // open, so remember that it was opened and let the next outside pointerdown only close it.
  // `change` fires when the picker closes with a new value; closing it unchanged (Escape)
  // leaves the flag set, which costs one extra click — harmless.
  fields.solidColor.addEventListener("click", () => {
    colorPickerOpen = true;
  });
  fields.solidColor.addEventListener("change", () => {
    colorPickerOpen = false;
  });
  // A click outside the modal dialog lands on its ::backdrop, which reports the dialog itself
  // as the target, so "outside" is told by the coordinates.
  // pointerdown rather than click: a text selection started inside the panel and released
  // outside dispatches click on the dialog too.
  settingsPanel.addEventListener("pointerdown", (e) => {
    const pickerWasOpen = colorPickerOpen;
    colorPickerOpen = false;
    const rect = settingsPanel.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (!inside && !pickerWasOpen) {
      closeSettings();
    }
  });
}
