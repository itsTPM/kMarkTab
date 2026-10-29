import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import indexHtml from "../entrypoints/newtab/index.html?raw";

// The panel only calls into these features; their own DOM isn't needed here
vi.mock("../entrypoints/newtab/features/background", () => ({
  clearCache: vi.fn(),
  refreshBackground: vi.fn(),
  onStatusChange: vi.fn(),
  hasBingAccess: vi.fn(async () => true),
  requestBingAccess: vi.fn(async () => true),
  onBingAccessChange: vi.fn(),
}));
vi.mock("../entrypoints/newtab/core/image-file", () => ({
  saveImageFile: vi.fn(),
  deleteImageFile: vi.fn(),
}));
vi.mock("../entrypoints/newtab/features/bookmarks", () => ({
  focusSearch: vi.fn(),
  rerenderBookmarks: vi.fn(),
}));
vi.mock("../entrypoints/newtab/features/clock", () => ({
  applyClockSettings: vi.fn(),
}));
vi.mock("../entrypoints/newtab/features/appearance", () => ({
  applyAppearance: vi.fn(),
}));

function el<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) {
    throw new Error(`${selector} not found`);
  }
  return found;
}

// The module queries the panel markup and keeps state at the top level, so every
// test rebuilds the DOM from the real index.html and re-imports it.
async function setup() {
  // <template> content is inert: unlike DOMParser, happy-dom doesn't try to load
  // the page's stylesheet and scripts from it
  const page = document.createElement("template");
  page.innerHTML = indexHtml;
  document.body.replaceChildren(
    ...["#settings-toggle", "#settings"].map((selector) => {
      const node = page.content.querySelector(selector);
      if (!node) {
        throw new Error(`${selector} not found in index.html`);
      }
      return document.importNode(node, true);
    }),
  );
  vi.resetModules();
  const { DEFAULT_SETTINGS, saveSettings } = await import("../entrypoints/newtab/core/settings");
  await saveSettings({
    ...DEFAULT_SETTINGS,
    unsplashSource: "collection",
    unsplashCollection: "custom",
    rotate: "day",
  });
  const { initSettingsPanel } = await import("../entrypoints/newtab/features/settings-panel");
  initSettingsPanel();
  el<HTMLButtonElement>("#settings-toggle").click();
}

const settled = () => vi.advanceTimersByTimeAsync(0);
const stored = async () => (await import("../entrypoints/newtab/core/settings")).getSettings();
const mocks = async () => ({
  ...(await import("../entrypoints/newtab/core/image-file")),
  ...(await import("../entrypoints/newtab/features/background")),
  ...(await import("../entrypoints/newtab/features/clock")),
  ...(await import("../entrypoints/newtab/features/appearance")),
  ...(await import("../entrypoints/newtab/features/bookmarks")),
});
const dialog = () => el<HTMLDialogElement>("#settings");

const resetButton = () => el<HTMLButtonElement>("#set-reset");
const clickReset = (button = resetButton(), detail = 1) =>
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
const confirming = (button = resetButton()) => button.hasAttribute("data-confirming");
const collection = () => el<HTMLInputElement>("#set-unsplashCollection").value;
const status = () => el("#set-reset-status").textContent;

const selectMode = (mode: string) => {
  const radio = el<HTMLInputElement>(`input[name="bgMode"][value="${mode}"]`);
  radio.checked = true;
  radio.dispatchEvent(new Event("change"));
};
const type = (selector: string, value: string) => {
  const input = el<HTMLInputElement>(selector);
  input.value = value;
  input.dispatchEvent(new Event("input"));
};
// returns the event, to check whether its default was prevented
const press = (selector: string, key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  el(selector).dispatchEvent(event);
  return event;
};
const pending = (selector: string) =>
  el(selector).closest(".setting")?.hasAttribute("data-pending");

beforeEach(() => {
  fakeBrowser.reset();
  // not implemented by fakeBrowser
  vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({
    manifest_version: 3,
    name: "kMarkTab",
    version: "1.2.3",
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("restore defaults confirmation", () => {
  it("only asks for confirmation on the first click", async () => {
    await setup();
    clickReset();
    expect(confirming()).toBe(true);
    expect(collection()).toBe("custom");
    expect(status()).toContain("Press again");
  });

  it("restores and applies the defaults on the second click", async () => {
    await setup();
    clickReset();
    clickReset();
    await settled();
    expect(collection()).toBe("");
    expect((await stored()).unsplashCollection).toBe("");
    expect(confirming()).toBe(false);
    expect(status()).toContain("restored");
  });

  it("confirms from the keyboard, where clicks have detail 0", async () => {
    await setup();
    clickReset(resetButton(), 0);
    clickReset(resetButton(), 0);
    await settled();
    expect(collection()).toBe("");
  });

  it("takes the second click of a double-click as the confirmation", async () => {
    await setup();
    clickReset(resetButton(), 1);
    clickReset(resetButton(), 2);
    await settled();
    expect(collection()).toBe("");
  });

  it("expires after a few seconds", async () => {
    await setup();
    clickReset();
    vi.advanceTimersByTime(3000);
    expect(confirming()).toBe(false);
    expect(status()).toBe("");
    clickReset();
    expect(collection()).toBe("custom");
  });

  it("disarms when the button loses focus", async () => {
    await setup();
    clickReset();
    resetButton().dispatchEvent(new FocusEvent("blur"));
    expect(confirming()).toBe(false);
  });

  it("disarms when the panel closes", async () => {
    await setup();
    clickReset();
    el<HTMLButtonElement>("#set-close").click();
    el<HTMLButtonElement>("#settings-toggle").click();
    expect(confirming()).toBe(false);
    clickReset();
    expect(collection()).toBe("custom");
  });

  it("does not take a click on another reset button as the confirmation", async () => {
    await setup();
    const backgroundReset = el<HTMLButtonElement>('[data-reset="background"]');
    clickReset();
    clickReset(backgroundReset);
    expect(confirming()).toBe(false);
    expect(confirming(backgroundReset)).toBe(true);
    expect(collection()).toBe("custom");
  });

  it("resets only the background settings from the Background section", async () => {
    await setup();
    const showTime = el<HTMLInputElement>("#set-showTime");
    showTime.checked = false;
    showTime.dispatchEvent(new Event("change"));
    const backgroundReset = el<HTMLButtonElement>('[data-reset="background"]');
    clickReset(backgroundReset);
    clickReset(backgroundReset);
    await settled();
    expect(await stored()).toMatchObject({ unsplashCollection: "", showTime: false });
    expect(showTime.checked).toBe(false);
  });
});

describe("applying changes", () => {
  it("applies a switch right away", async () => {
    await setup();
    const showDate = el<HTMLInputElement>("#set-showDate");
    showDate.checked = false;
    showDate.dispatchEvent(new Event("change"));
    await settled();
    expect((await stored()).showDate).toBe(false);
    expect((await mocks()).applyClockSettings).toHaveBeenCalled();
  });

  it("applies the time format right away and shows it in the summary", async () => {
    await setup();
    const timeFormat = el<HTMLSelectElement>("#set-timeFormat");
    timeFormat.value = timeFormat.value === "12h" ? "24h" : "12h";
    timeFormat.dispatchEvent(new Event("change"));
    await settled();
    expect((await stored()).timeFormat).toBe(timeFormat.value);
    expect((await mocks()).applyClockSettings).toHaveBeenCalled();
    expect(el("#set-summary-clock").textContent).toBe(`Shows time and date · ${timeFormat.value}`);
  });

  it("applies a select right away, clearing the cache before the refresh", async () => {
    await setup();
    const market = el<HTMLSelectElement>("#set-bingMarket");
    market.value = "ja-JP";
    market.dispatchEvent(new Event("change"));
    await settled();
    expect((await stored()).bingMarket).toBe("ja-JP");
    const { clearCache, refreshBackground } = await mocks();
    expect(vi.mocked(clearCache).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(refreshBackground).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("keeps the cached image for another image quality", async () => {
    await setup();
    const quality = el<HTMLSelectElement>("#set-imageQuality");
    quality.value = "fhd";
    quality.dispatchEvent(new Event("change"));
    await settled();
    expect((await stored()).imageQuality).toBe("fhd");
    const { clearCache, refreshBackground } = await mocks();
    expect(clearCache).not.toHaveBeenCalled();
    expect(refreshBackground).toHaveBeenCalled();
  });

  it("applies the rotation right away, keeping the cached image", async () => {
    await setup();
    selectMode("unsplash");
    await settled();
    const rotate = el<HTMLSelectElement>("#set-rotate");
    rotate.value = "tab";
    rotate.dispatchEvent(new Event("change"));
    await settled();
    expect((await stored()).rotate).toBe("tab");
    const { clearCache, refreshBackground } = await mocks();
    expect(clearCache).not.toHaveBeenCalled();
    expect(refreshBackground).toHaveBeenCalled();
    expect(el("#set-summary-background").textContent).toBe("Unsplash · collection · every tab");
  });

  it("rerenders the bookmarks for another favicon provider", async () => {
    await setup();
    const provider = el<HTMLSelectElement>("#set-faviconProvider");
    provider.value = "google";
    provider.dispatchEvent(new Event("change"));
    await settled();
    expect((await stored()).faviconProvider).toBe("google");
    expect((await mocks()).rerenderBookmarks).toHaveBeenCalled();
  });

  it("applies the collapsed-folder search switch and shows it in the summary", async () => {
    await setup();
    expect(el("#set-summary-bookmarks").textContent).toBe("Favicons: Chrome API");
    const toggle = el<HTMLInputElement>("#set-searchCollapsed");
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await settled();
    expect((await stored()).searchCollapsed).toBe(false);
    expect((await mocks()).rerenderBookmarks).toHaveBeenCalled();
    expect(el("#set-summary-bookmarks").textContent).toBe("Favicons: Chrome API · skips collapsed");
  });

  it("applies the result layout switch and shows it in the summary", async () => {
    await setup();
    const toggle = el<HTMLInputElement>("#set-searchFlat");
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await settled();
    expect((await stored()).searchFlat).toBe(false);
    expect((await mocks()).rerenderBookmarks).toHaveBeenCalled();
    expect(el("#set-summary-bookmarks").textContent).toBe(
      "Favicons: Chrome API · results as a tree",
    );
  });

  it("applies the URL matching switch, leaving it out of the summary", async () => {
    await setup();
    const toggle = el<HTMLInputElement>("#set-searchUrl");
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await settled();
    expect((await stored()).searchUrl).toBe(false);
    expect((await mocks()).rerenderBookmarks).toHaveBeenCalled();
    expect(el("#set-summary-bookmarks").textContent).toBe("Favicons: Chrome API");
  });

  it("applies the color when the picker closes, previewing it in its tile while picking", async () => {
    await setup();
    const color = el<HTMLInputElement>("#set-solidColor");
    color.value = "#336699";
    color.dispatchEvent(new Event("input"));
    expect(el<HTMLElement>("#set-solid-preview").style.background).toContain("#336699");
    expect((await stored()).solidColor).not.toBe("#336699");
    color.dispatchEvent(new Event("change"));
    await settled();
    expect((await stored()).solidColor).toBe("#336699");
  });

  it("summarizes a collapsed section", async () => {
    await setup();
    selectMode("unsplash");
    await settled();
    expect(el("#set-summary-background").textContent).toBe("Unsplash · collection · every day");
    const showTime = el<HTMLInputElement>("#set-showTime");
    showTime.checked = false;
    showTime.dispatchEvent(new Event("change"));
    await settled();
    expect(el("#set-summary-clock").textContent).toBe("Shows date");
    selectMode("bing");
    await settled();
    expect(el("#set-summary-background").textContent).toMatch(/^Bing · \w/);
  });

  it("repeats background errors in the dialog's own live region", async () => {
    await setup();
    const { onStatusChange } = await mocks();
    const listener = vi.mocked(onStatusChange).mock.calls[0]?.[0];
    listener?.({ state: "error", message: "Couldn't reach Unsplash" });
    expect(el("#set-status").textContent).toBe("Couldn't reach Unsplash");
    listener?.({ state: "loading" });
    expect(el("#set-status").textContent).toBe("");
  });

  it("closes on a pointerdown outside the dialog, except the one dismissing the color picker", async () => {
    await setup();
    const outside = () =>
      dialog().dispatchEvent(new MouseEvent("pointerdown", { clientX: 5000, clientY: 5000 }));
    el<HTMLInputElement>("#set-solidColor").click();
    outside();
    expect(dialog().open).toBe(true);
    outside();
    expect(dialog().open).toBe(false);
  });
});

describe("panel appearance", () => {
  const slide = (selector: string, value: string, event: "input" | "change") => {
    const range = el<HTMLInputElement>(selector);
    range.value = value;
    range.dispatchEvent(new Event(event));
  };

  it("previews a slider as it moves and stores it once released", async () => {
    await setup();
    const { applyAppearance } = await mocks();
    slide("#set-panelBlur", "10", "input");
    expect(applyAppearance).toHaveBeenLastCalledWith({ panelOpacity: 85, panelBlur: 10 });
    expect(el("#set-panelBlur-value").textContent).toBe("10 px");
    expect(el("#set-panelBlur").getAttribute("aria-valuetext")).toBe("10 px");
    expect((await stored()).panelBlur).toBe(24);

    slide("#set-panelBlur", "10", "change");
    await settled();
    expect((await stored()).panelBlur).toBe(10);
    expect(applyAppearance).toHaveBeenLastCalledWith();
    expect(el("#set-summary-appearance").textContent).toBe("Opacity 85% · blur 10 px");
  });

  it("marks the default value and fills the track up to the current one", async () => {
    await setup();
    const blur = el<HTMLInputElement>("#set-panelBlur");
    expect(blur.parentElement?.style.getPropertyValue("--default-at")).toBe("0.6");
    expect(blur.style.getPropertyValue("--value-at")).toBe("0.6");
    slide("#set-panelBlur", "10", "input");
    expect(blur.style.getPropertyValue("--value-at")).toBe("0.25");
  });

  it("snaps a dragged slider to its default value, but not one moved by keys", async () => {
    await setup();
    const opacity = el<HTMLInputElement>("#set-panelOpacity");
    slide("#set-panelOpacity", "88", "input");
    expect(opacity.value).toBe("88");

    opacity.dispatchEvent(new Event("pointerdown"));
    slide("#set-panelOpacity", "88", "input");
    expect(opacity.value).toBe("85");
    slide("#set-panelOpacity", "80", "input");
    expect(opacity.value).toBe("80");
    document.dispatchEvent(new Event("pointerup"));

    slide("#set-panelOpacity", "86", "input");
    expect(opacity.value).toBe("86");
  });

  it("disables the blur slider for an opaque panel", async () => {
    await setup();
    slide("#set-panelOpacity", "100", "input");
    expect(el<HTMLInputElement>("#set-panelBlur").disabled).toBe(true);
    slide("#set-panelOpacity", "100", "change");
    await settled();
    expect(el("#set-summary-appearance").textContent).toBe("Opaque panel");
    slide("#set-panelOpacity", "50", "input");
    expect(el<HTMLInputElement>("#set-panelBlur").disabled).toBe(false);
  });

  it("tells when the system makes the panel opaque", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    await setup();
    expect(el<HTMLElement>("#set-system-opaque").hidden).toBe(false);
    expect(el("#set-panelOpacity").getAttribute("aria-describedby")).toBe("set-system-opaque");
    expect(el("#set-summary-appearance").textContent).toBe("Opaque panel · system setting");
  });

  it("describes the opacity slider without the system hint otherwise", async () => {
    await setup();
    expect(el<HTMLElement>("#set-system-opaque").hidden).toBe(true);
    expect(el("#set-panelOpacity").hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("fields applied with a check button", () => {
  it("does not apply while typing, and marks the field as pending", async () => {
    await setup();
    type("#set-unsplashCollection", "other");
    await settled();
    expect((await stored()).unsplashCollection).toBe("custom");
    expect(pending("#set-unsplashCollection")).toBe(true);
    type("#set-unsplashCollection", "custom");
    expect(pending("#set-unsplashCollection")).toBe(false);
  });

  it("applies with the check button and refreshes the background", async () => {
    await setup();
    type("#set-unsplashCollection", "other");
    el("#set-unsplashCollection")
      .closest(".setting")
      ?.querySelector<HTMLButtonElement>("button")
      ?.click();
    await settled();
    expect((await stored()).unsplashCollection).toBe("other");
    expect(pending("#set-unsplashCollection")).toBe(false);
    const { clearCache, refreshBackground } = await mocks();
    expect(vi.mocked(clearCache).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(refreshBackground).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("applies with Enter and shows the normalized value", async () => {
    await setup();
    type("#set-unsplashCollection", "  other ");
    press("#set-unsplashCollection", "Enter");
    await settled();
    expect((await stored()).unsplashCollection).toBe("other");
    expect(collection()).toBe("other");
  });

  it("reverts with Escape without closing the panel", async () => {
    await setup();
    type("#set-unsplashCollection", "other");
    // a canceled Escape keydown makes no close request
    expect(press("#set-unsplashCollection", "Escape").defaultPrevented).toBe(true);
    expect(collection()).toBe("custom");
    expect(pending("#set-unsplashCollection")).toBe(false);
    // with nothing to revert, Escape is left to close the dialog
    expect(press("#set-unsplashCollection", "Escape").defaultPrevented).toBe(false);
  });

  it("ignores the Enter that confirms an IME candidate", async () => {
    await setup();
    type("#set-unsplashCollection", "oth");
    el("#set-unsplashCollection").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    await settled();
    expect((await stored()).unsplashCollection).toBe("custom");
  });

  it("describes a pending field by its 'not applied' line, and only then", async () => {
    await setup();
    const describedBy = () => el("#set-imageUrl").getAttribute("aria-describedby");
    expect(describedBy()).toBeNull();
    type("#set-imageUrl", "https://images.test/a.jpg");
    expect(describedBy()).toBe("set-imageUrl-pending");
    press("#set-imageUrl", "Escape");
    expect(describedBy()).toBeNull();
    // other descriptions are kept
    const collectionDescribedBy = () =>
      el("#set-unsplashCollection").getAttribute("aria-describedby");
    type("#set-unsplashCollection", "other");
    expect(collectionDescribedBy()).toBe(
      "set-unsplashCollection-hint set-unsplashCollection-pending",
    );
    press("#set-unsplashCollection", "Escape");
    expect(collectionDescribedBy()).toBe("set-unsplashCollection-hint");
  });

  it("returns focus to the field from its check button", async () => {
    await setup();
    type("#set-unsplashCollection", "other");
    el("#set-unsplashCollection")
      .closest(".setting")
      ?.querySelector<HTMLButtonElement>("button")
      ?.click();
    expect(document.activeElement).toBe(el("#set-unsplashCollection"));
  });

  it("clears pending fields on a reset", async () => {
    await setup();
    type("#set-unsplashCollection", "other");
    clickReset();
    clickReset();
    await settled();
    expect(pending("#set-unsplashCollection")).toBe(false);
  });

  it("drops a pending value when the panel closes", async () => {
    await setup();
    type("#set-unsplashCollection", "other");
    el<HTMLButtonElement>("#set-close").click();
    el<HTMLButtonElement>("#settings-toggle").click();
    expect(collection()).toBe("custom");
    expect((await stored()).unsplashCollection).toBe("custom");
  });
});

describe("background mode fields", () => {
  const shown = (selector: string) => !el(selector).closest<HTMLElement>("[data-mode]")?.hidden;

  it("shows only the region and the shared fields for Bing", async () => {
    await setup();
    selectMode("bing");
    expect(shown("#set-bingMarket")).toBe(true);
    expect(shown("#set-imageQuality")).toBe(true);
    expect(shown("#set-rotate")).toBe(false);
    expect(shown("#set-unsplashCollection")).toBe(false);
  });

  it("shows the collection ID field only for the collection source, keeping its value", async () => {
    await setup();
    selectMode("unsplash");
    const source = el<HTMLSelectElement>("#set-unsplashSource");
    const idShown = () =>
      !el("#set-unsplashCollection").closest<HTMLElement>("[data-unsplash-source]")?.hidden;
    expect(source.value).toBe("collection");
    expect(idShown()).toBe(true);
    source.value = "curated";
    source.dispatchEvent(new Event("change"));
    await settled();
    expect(idShown()).toBe(false);
    expect(await stored()).toMatchObject({
      unsplashSource: "curated",
      unsplashCollection: "custom",
    });
    expect((await mocks()).clearCache).toHaveBeenCalled();
    source.value = "collection";
    source.dispatchEvent(new Event("change"));
    expect(idShown()).toBe(true);
    expect(collection()).toBe("custom");
  });

  it("stores the collection source only with an applied ID", async () => {
    await setup();
    selectMode("unsplash");
    const source = el<HTMLSelectElement>("#set-unsplashSource");
    const choose = (value: string) => {
      source.value = value;
      source.dispatchEvent(new Event("change"));
    };
    type("#set-unsplashCollection", "");
    press("#set-unsplashCollection", "Enter");
    choose("curated");
    await settled();
    expect(await stored()).toMatchObject({ unsplashSource: "curated", unsplashCollection: "" });
    const { clearCache, refreshBackground } = await mocks();
    vi.mocked(clearCache).mockClear();
    vi.mocked(refreshBackground).mockClear();
    choose("collection");
    await settled();
    expect((await stored()).unsplashSource).toBe("curated");
    expect(refreshBackground).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(el("#set-unsplashCollection"));
    press("#set-unsplashCollection", "Enter");
    await settled();
    expect((await stored()).unsplashSource).toBe("curated");
    type("#set-unsplashCollection", "new");
    expect(pending("#set-unsplashCollection")).toBe(true);
    press("#set-unsplashCollection", "Enter");
    await settled();
    expect(await stored()).toMatchObject({
      unsplashSource: "collection",
      unsplashCollection: "new",
    });
    expect(clearCache).toHaveBeenCalled();
    expect(refreshBackground).toHaveBeenCalled();
  });

  it("drops a collection source without an ID when the panel closes", async () => {
    await setup();
    selectMode("unsplash");
    const source = el<HTMLSelectElement>("#set-unsplashSource");
    type("#set-unsplashCollection", "");
    press("#set-unsplashCollection", "Enter");
    source.value = "curated";
    source.dispatchEvent(new Event("change"));
    await settled();
    source.value = "collection";
    source.dispatchEvent(new Event("change"));
    el<HTMLDialogElement>("#settings").close();
    el<HTMLButtonElement>("#settings-toggle").click();
    expect(source.value).toBe("curated");
    expect(
      el("#set-unsplashCollection").closest<HTMLElement>("[data-unsplash-source]")?.hidden,
    ).toBe(true);
  });

  it("applies the mode right away and keeps the Unsplash settings", async () => {
    await setup();
    selectMode("bing");
    await settled();
    expect(await stored()).toMatchObject({
      bgMode: "bing",
      unsplashCollection: "custom",
      rotate: "day",
    });
    expect((await mocks()).refreshBackground).toHaveBeenCalled();
  });

  it("offers the original image quality for Unsplash only, keeping it for a switch back", async () => {
    await setup();
    const quality = el<HTMLSelectElement>("#set-imageQuality");
    const original = () => el<HTMLOptionElement>('#set-imageQuality option[value="original"]');
    selectMode("unsplash");
    await settled();
    quality.value = "original";
    quality.dispatchEvent(new Event("change"));
    await settled();
    expect((await stored()).imageQuality).toBe("original");

    selectMode("bing");
    await settled();
    expect(original().hidden).toBe(true);
    expect(quality.value).toBe("uhd");
    expect((await stored()).imageQuality).toBe("original");

    selectMode("unsplash");
    expect(original().hidden).toBe(false);
    expect(quality.value).toBe("original");
  });

  it("shows only the URL and the dimming for an image URL", async () => {
    await setup();
    selectMode("url");
    expect(shown("#set-imageUrl")).toBe(true);
    expect(shown("#set-bgDim")).toBe(true);
    expect(shown("#set-imageQuality")).toBe(false);
    expect(shown("#set-rotate")).toBe(false);
    expect(shown("#set-bingMarket")).toBe(false);
  });

  it("saves the image URL", async () => {
    await setup();
    selectMode("url");
    type("#set-imageUrl", "https://images.test/a.jpg");
    press("#set-imageUrl", "Enter");
    await settled();
    expect(await stored()).toMatchObject({ bgMode: "url", imageUrl: "https://images.test/a.jpg" });
  });

  describe("image file", () => {
    const fileInput = () => el<HTMLInputElement>("#set-imageFile");
    const fileName = () => el("#set-imageFile-name").textContent;
    const pick = (file: File) => {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      fileInput().files = transfer.files;
      fileInput().dispatchEvent(new Event("change"));
    };

    it("stores a picked file right away and refreshes the background, even under the same name", async () => {
      await setup();
      selectMode("file");
      expect(shown("#set-imageFile")).toBe(true);
      expect(shown("#set-bgDim")).toBe(true);
      expect(shown("#set-imageQuality")).toBe(false);
      expect(fileName()).toBe("No file chosen");

      const file = new File(["x"], "photo.jpg", { type: "image/jpeg" });
      pick(file);
      await settled();
      expect(fileName()).toBe("photo.jpg");
      const { saveImageFile, clearCache, refreshBackground } = await mocks();
      expect(saveImageFile).toHaveBeenCalledWith(file);
      expect(await stored()).toMatchObject({ bgMode: "file", imageFileName: "photo.jpg" });

      vi.mocked(clearCache).mockClear();
      vi.mocked(refreshBackground).mockClear();
      pick(new File(["y"], "photo.jpg", { type: "image/jpeg" }));
      await settled();
      expect(clearCache).toHaveBeenCalled();
      expect(refreshBackground).toHaveBeenCalled();
    });

    it("reports a file that couldn't be stored, and lets it be picked again", async () => {
      await setup();
      selectMode("file");
      const { saveImageFile } = await mocks();
      vi.mocked(saveImageFile).mockRejectedValueOnce(new Error("QuotaExceededError"));
      pick(new File(["x"], "photo.jpg", { type: "image/jpeg" }));
      await settled();
      expect(el("#set-status").textContent).toBe("Couldn't save the image file");
      expect((await stored()).imageFileName).toBe("");
      expect(fileInput().value).toBe("");
    });

    it("drops the stored file when the defaults are restored", async () => {
      await setup();
      selectMode("file");
      pick(new File(["x"], "photo.jpg", { type: "image/jpeg" }));
      await settled();
      clickReset();
      clickReset();
      await settled();
      expect(fileName()).toBe("No file chosen");
      expect((await mocks()).deleteImageFile).toHaveBeenCalled();
    });
  });

  it("lists exactly the supported markets", async () => {
    await setup();
    const { BING_MARKETS } = await import("../entrypoints/newtab/core/settings");
    const options = [...el<HTMLSelectElement>("#set-bingMarket").options].map((o) => o.value);
    expect(options).toEqual([...BING_MARKETS]);
  });

  it("lists exactly the supported image qualities", async () => {
    await setup();
    const { IMAGE_WIDTHS } = await import("../entrypoints/newtab/core/settings");
    const options = [...el<HTMLSelectElement>("#set-imageQuality").options].map((o) => o.value);
    expect(options).toEqual(Object.keys(IMAGE_WIDTHS));
  });

  it("lists exactly the supported modes", async () => {
    await setup();
    const modes = [...document.querySelectorAll<HTMLInputElement>('input[name="bgMode"]')];
    expect(modes.map((input) => input.value)).toEqual(["solid", "file", "url", "unsplash", "bing"]);
  });
});

describe("Bing access", () => {
  const accessRow = () => el<HTMLElement>("#set-bing-access");

  it("asks for it when Bing is chosen", async () => {
    await setup();
    const { requestBingAccess } = await mocks();
    selectMode("unsplash");
    expect(requestBingAccess).not.toHaveBeenCalled();
    selectMode("bing");
    expect(requestBingAccess).toHaveBeenCalledTimes(1);
    await settled();
    expect((await stored()).bgMode).toBe("bing");
  });

  it("offers to allow it while it isn't granted, until it is", async () => {
    await setup();
    const { hasBingAccess, onBingAccessChange, requestBingAccess } = await mocks();
    const accessChanged = vi.mocked(onBingAccessChange).mock.calls[0]![0];
    vi.mocked(hasBingAccess).mockResolvedValue(false);
    accessChanged();
    await settled();
    expect(accessRow().hidden).toBe(false);
    el<HTMLButtonElement>("#set-bing-access-button").click();
    expect(requestBingAccess).toHaveBeenCalledTimes(1);

    vi.mocked(hasBingAccess).mockResolvedValue(true);
    accessChanged();
    await settled();
    expect(accessRow().hidden).toBe(true);
  });

  it("hides the offer when access is granted", async () => {
    await setup();
    await settled();
    expect(accessRow().hidden).toBe(true);
  });
});

describe("import and export", () => {
  const settingsFile = (settings: object) =>
    new File([JSON.stringify({ format: "kMarkTab-settings", version: 1, settings })], "s.json", {
      type: "application/json",
    });
  const importFile = (file: File) => {
    const input = el<HTMLInputElement>("#set-import-file");
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change"));
  };
  const transferStatus = () => el("#set-transfer-status").textContent;

  it("exports the stored settings as a download", async () => {
    await setup();
    let blob: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((object) => {
      blob = object as Blob;
      return "blob:settings";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    el<HTMLButtonElement>("#set-export").click();
    expect(click).toHaveBeenCalled();
    expect(click.mock.contexts[0]).toMatchObject({ download: "kMarkTab-settings.json" });
    const exported = JSON.parse(await blob!.text());
    expect(exported.settings).toMatchObject({ unsplashCollection: "custom", rotate: "day" });
    expect(exported.settings).not.toHaveProperty("imageFileName");
  });

  it("applies an imported file, replacing every setting, and shows it", async () => {
    await setup();
    importFile(settingsFile({ bgMode: "bing", showTime: false }));
    await settled();
    expect(await stored()).toMatchObject({
      bgMode: "bing",
      showTime: false,
      unsplashCollection: "",
      rotate: "hour",
    });
    expect(collection()).toBe("");
    expect(el<HTMLInputElement>('input[value="bing"]').checked).toBe(true);
    const { clearCache, refreshBackground, applyClockSettings } = await mocks();
    expect(clearCache).toHaveBeenCalled();
    expect(refreshBackground).toHaveBeenCalled();
    expect(applyClockSettings).toHaveBeenCalled();
    expect(transferStatus()).toBe("Settings imported");
  });

  it("says where to allow Bing when the imported settings use it without access", async () => {
    await setup();
    vi.mocked((await mocks()).hasBingAccess).mockResolvedValue(false);
    importFile(settingsFile({ bgMode: "bing" }));
    await settled();
    expect(transferStatus()).toBe(
      "Settings imported. Bing needs access to bing.com: allow it under Background",
    );
  });

  it("keeps the image file of this device", async () => {
    await setup();
    const { saveSettings, getSettings } = await import("../entrypoints/newtab/core/settings");
    await saveSettings({ ...getSettings(), imageFileName: "photo.jpg" });
    importFile(settingsFile({ bgMode: "file" }));
    await settled();
    expect(await stored()).toMatchObject({ bgMode: "file", imageFileName: "photo.jpg" });
    expect((await mocks()).deleteImageFile).not.toHaveBeenCalled();
    expect(transferStatus()).toBe("Settings imported");
  });

  it("asks for an image file when this device has none", async () => {
    await setup();
    importFile(settingsFile({ bgMode: "file" }));
    await settled();
    expect((await stored()).bgMode).toBe("file");
    expect(el("#set-imageFile-name").textContent).toBe("No file chosen");
    expect(transferStatus()).toContain("choose it under Background");
  });

  it("rejects a file that isn't a settings file", async () => {
    await setup();
    importFile(new File(["{}"], "other.json", { type: "application/json" }));
    await settled();
    expect(transferStatus()).toBe("Not a kMarkTab settings file");
    expect((await stored()).unsplashCollection).toBe("custom");
    expect(el<HTMLInputElement>("#set-import-file").value).toBe("");
  });
});

describe("about section", () => {
  it("shows the name and version from the manifest", async () => {
    await setup();
    expect(el("#set-about-name").textContent).toBe("kMarkTab");
    expect(el("#set-about-version").textContent).toBe("Version 1.2.3");
    expect(el("#set-summary-about").textContent).toBe("Version 1.2.3");
  });

  it("links the store reviews by the extension id", async () => {
    await setup();
    expect(el<HTMLAnchorElement>("#set-about-review").href).toBe(
      `https://chromewebstore.google.com/detail/${fakeBrowser.runtime.id}/reviews`,
    );
  });
});
