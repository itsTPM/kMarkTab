import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { Settings } from "../entrypoints/newtab/core/settings";

// Extra top-level bookmarks appended to the mock tree, for tests that need them.
const extraBookmarks = vi.hoisted((): { type: "bookmark"; title: string; url: string }[] => []);

vi.mock("../entrypoints/newtab/data/bookmark-tree", () => ({
  loadBookmarkTree: async () => [
    { type: "bookmark", title: "Alpha", url: "https://alpha.test" },
    {
      type: "folder",
      id: "tools",
      title: "Tools",
      children: [
        { type: "bookmark", title: "Beta", url: "https://beta.test" },
        {
          type: "folder",
          id: "nested",
          title: "Nested",
          children: [{ type: "bookmark", title: "Gamma", url: "https://gamma.test" }],
        },
      ],
    },
    { type: "bookmark", title: "Broken", url: "not a url" },
    { type: "bookmark", title: "Relay", url: "https://relay.test" },
    { type: "bookmark", title: "YouTube", url: "https://youtube.com" },
    ...extraBookmarks,
  ],
}));

// The module queries #search/#list/#list-empty/#list-notice and keeps state at the top level,
// so every test rebuilds the DOM and re-imports it.
async function setup(settingsOverrides?: Partial<Settings>) {
  document.body.innerHTML =
    '<input id="search" /><div id="list-empty"></div><div id="list"></div><p id="list-notice"></p>';
  document.body.className = "";
  vi.resetModules();
  if (settingsOverrides) {
    const { DEFAULT_SETTINGS, saveSettings } = await import("../entrypoints/newtab/core/settings");
    await saveSettings({ ...DEFAULT_SETTINGS, ...settingsOverrides });
  }
  const bookmarks = await import("../entrypoints/newtab/features/bookmarks");
  await bookmarks.initBookmarks();
  return bookmarks;
}

const rows = () => [...document.querySelectorAll("#list .row")];
const titles = () => rows().map((el) => el.querySelector(".title")?.textContent);
const rowByTitle = (title: string) =>
  rows().find((el) => el.querySelector(".title")?.textContent === title);
const selectedTitle = () => document.querySelector("#list .row.selected .title")?.textContent;

function type(text: string) {
  const search = document.querySelector<HTMLInputElement>("#search");
  if (!search) {
    throw new Error("#search not found");
  }
  search.value = text;
  search.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(key: string, init: KeyboardEventInit = {}) {
  document.querySelector("#search")?.dispatchEvent(new KeyboardEvent("keydown", { key, ...init }));
}

const mouse = (el: Element | undefined, type: string, init: MouseEventInit = {}) =>
  el?.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init }));

beforeEach(() => {
  fakeBrowser.reset();
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("list rendering", () => {
  it("shows all rows with folders expanded", async () => {
    await setup();
    expect(titles()).toEqual([
      "Alpha",
      "Tools",
      "Beta",
      "Nested",
      "Gamma",
      "Broken",
      "Relay",
      "YouTube",
    ]);
  });

  it("marks folders and bookmarks with classes", async () => {
    await setup();
    expect(rowByTitle("Tools")?.classList.contains("folder")).toBe(true);
    expect(rowByTitle("Alpha")?.classList.contains("bookmark")).toBe(true);
  });

  it("selects the first bookmark initially", async () => {
    await setup();
    expect(selectedTitle()).toBe("Alpha");
  });
});

describe("tree semantics", () => {
  const attrs = (title: string) => {
    const el = rowByTitle(title);
    return {
      role: el?.getAttribute("role"),
      level: el?.getAttribute("aria-level"),
      posinset: el?.getAttribute("aria-posinset"),
      setsize: el?.getAttribute("aria-setsize"),
    };
  };

  it("exposes the visual nesting as aria-level and sibling counts", async () => {
    await setup();
    // the five root nodes, then Tools' two children, then Nested's only child
    expect(attrs("Alpha")).toEqual({
      role: "treeitem",
      level: "1",
      posinset: "1",
      setsize: "5",
    });
    expect(attrs("Beta")).toEqual({
      role: "treeitem",
      level: "2",
      posinset: "1",
      setsize: "2",
    });
    expect(attrs("Gamma")).toEqual({
      role: "treeitem",
      level: "3",
      posinset: "1",
      setsize: "1",
    });
  });

  it("puts aria-expanded on folders only", async () => {
    await setup();
    expect(rowByTitle("Tools")?.getAttribute("aria-expanded")).toBe("true");
    expect(rowByTitle("Alpha")?.hasAttribute("aria-expanded")).toBe(false);
  });

  it("updates aria-expanded when a folder is collapsed", async () => {
    await setup();
    press("ArrowDown"); // Tools
    press(" ");
    expect(rowByTitle("Tools")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("numbers search results as a flat single-level list", async () => {
    await setup();
    type("a");
    const found = rows();
    expect(found.length).toBeGreaterThan(1);
    for (const [i, el] of found.entries()) {
      expect(el.getAttribute("aria-level")).toBe("1");
      expect(el.getAttribute("aria-posinset")).toBe(String(i + 1));
      expect(el.getAttribute("aria-setsize")).toBe(String(found.length));
    }
  });

  it("points aria-activedescendant at the selected row", async () => {
    await setup();
    const active = () => document.querySelector("#search")?.getAttribute("aria-activedescendant");
    expect(document.getElementById(active() ?? "")).toBe(rowByTitle("Alpha"));
    expect(rowByTitle("Alpha")?.getAttribute("aria-selected")).toBe("true");
    expect(rowByTitle("Tools")?.getAttribute("aria-selected")).toBe("false");

    press("ArrowDown");
    expect(document.getElementById(active() ?? "")).toBe(rowByTitle("Tools"));
    expect(rowByTitle("Tools")?.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the live region in the DOM and empties it when results return", async () => {
    await setup();
    const region = document.querySelector("#list-empty");
    expect(region?.hasAttribute("hidden")).toBe(false);
    expect(region?.textContent).toBe("");

    type("aaaaaa");
    expect([...(region?.children ?? [])].map((p) => p.textContent)).toEqual([
      "No matches",
      "Press Enter to search the web",
    ]);

    type("alpha");
    expect(region?.textContent).toBe("");
  });

  it("collapses the combobox and drops the active row when nothing matches", async () => {
    await setup();
    type("aaaaaa");
    const search = document.querySelector("#search");
    expect(search?.getAttribute("aria-expanded")).toBe("false");
    expect(search?.hasAttribute("aria-activedescendant")).toBe(false);
  });
});

describe("search", () => {
  it("shows a flat ranked list without folder rows", async () => {
    await setup();
    type("gam");
    expect(titles()).toEqual(["Gamma"]);
  });

  it("ranks a title-prefix match above an incidental URL match", async () => {
    await setup();
    type("y");
    expect(titles()[0]).toBe("YouTube");
  });

  it("tolerates a single typo in a term", async () => {
    await setup();
    type("gama");
    expect(titles()).toEqual(["Gamma"]);
  });

  it("highlights the matched part of the title", async () => {
    await setup();
    type("gam");
    expect(rowByTitle("Gamma")?.querySelector(".title mark")?.textContent).toBe("Gam");
  });

  it("shows the folder path next to a result", async () => {
    await setup();
    type("gam");
    expect(rowByTitle("Gamma")?.querySelector(".crumb")?.textContent).toBe("Tools / Nested");
  });

  it("is case-insensitive", async () => {
    await setup();
    type("ALPHA");
    expect(titles()).toEqual(["Alpha"]);
  });

  it("moves selection to the first matching bookmark", async () => {
    await setup();
    type("beta");
    expect(selectedTitle()).toBe("Beta");
  });

  it("shows the empty state when nothing matches", async () => {
    await setup();
    type("aaaaaa");
    expect(rows()).toHaveLength(0);
    expect(document.querySelector("#list-empty .empty-title")?.textContent).toBe("No matches");
  });

  it("matches against bookmark URLs", async () => {
    await setup();
    type("beta.test");
    expect(titles()).toEqual(["Beta"]);
  });

  it("matches titles only when searchUrl is off", async () => {
    await setup({ searchUrl: false });
    type("beta.test");
    expect(titles()).toEqual([]);
    type("test");
    expect(titles()).toEqual([]);
    type("bet");
    expect(titles()).toEqual(["Beta"]);
    expect(rowByTitle("Beta")?.querySelector(".title mark")?.textContent).toBe("Bet");
  });

  it("requires every word of a multi-word query to match", async () => {
    await setup();
    type("gamma test");
    expect(titles()).toEqual(["Gamma"]);
    type("gamma nope");
    expect(rows()).toHaveLength(0);
  });

  it("clears the query on Escape", async () => {
    await setup();
    type("gam");
    press("Escape");
    expect(document.querySelector<HTMLInputElement>("#search")?.value).toBe("");
    expect(titles()).toHaveLength(8);
    expect(selectedTitle()).toBe("Alpha");
  });

  it("restores the full list when the query is cleared", async () => {
    await setup();
    type("gam");
    type("");
    expect(titles()).toHaveLength(8);
  });
});

describe("search in collapsed folders", () => {
  it("finds bookmarks in collapsed folders by default", async () => {
    await setup();
    mouse(rowByTitle("Tools"), "click");
    type("gam");
    expect(titles()).toEqual(["Gamma"]);
  });

  it("skips bookmarks in a collapsed folder at any level when turned off", async () => {
    await setup({ searchCollapsed: false });
    mouse(rowByTitle("Nested"), "click");
    type("gam");
    expect(titles()).toEqual([]);
    type("beta");
    expect(titles()).toEqual(["Beta"]);
    type("");
    mouse(rowByTitle("Nested"), "click");
    mouse(rowByTitle("Tools"), "click");
    type("gam");
    expect(titles()).toEqual([]);
    type("beta");
    expect(titles()).toEqual([]);
  });

  it("applies a changed setting on rerender", async () => {
    const bookmarks = await setup();
    mouse(rowByTitle("Tools"), "click");
    type("beta");
    expect(titles()).toEqual(["Beta"]);
    const { DEFAULT_SETTINGS, saveSettings } = await import("../entrypoints/newtab/core/settings");
    await saveSettings({ ...DEFAULT_SETTINGS, searchCollapsed: false });
    bookmarks.rerenderBookmarks();
    expect(titles()).toEqual([]);
  });
});

describe("search results as a tree", () => {
  const levels = () => rows().map((el) => el.getAttribute("aria-level"));

  it("shows the matches under their folders in tree order", async () => {
    await setup({ searchFlat: false });
    type("a");
    expect(titles()).toEqual(["Alpha", "Tools", "Beta", "Nested", "Gamma", "Broken", "Relay"]);
    expect(levels()).toEqual(["1", "1", "2", "2", "3", "1", "1"]);
    expect(rowByTitle("Gamma")?.querySelector(".crumb")).toBeNull();
    expect(rowByTitle("Gamma")?.querySelector(".title mark")).not.toBeNull();
  });

  it("leaves out the folders without a match and counts only the shown siblings", async () => {
    await setup({ searchFlat: false });
    type("gam");
    expect(titles()).toEqual(["Tools", "Nested", "Gamma"]);
    expect(rowByTitle("Nested")?.getAttribute("aria-posinset")).toBe("1");
    expect(rowByTitle("Nested")?.getAttribute("aria-setsize")).toBe("1");
    expect(selectedTitle()).toBe("Gamma");
  });

  it("shows a collapsed folder expanded and keeps its state", async () => {
    await setup({ searchFlat: false });
    mouse(rowByTitle("Tools"), "click");
    type("gam");
    expect(titles()).toEqual(["Tools", "Nested", "Gamma"]);
    expect(rowByTitle("Tools")?.getAttribute("aria-expanded")).toBe("true");
    mouse(rowByTitle("Tools"), "click");
    expect(titles()).toEqual(["Tools", "Nested", "Gamma"]);
    type("");
    expect(titles()).toEqual(["Alpha", "Tools", "Broken", "Relay", "YouTube"]);
  });

  it("does not toggle a folder on Enter or Space", async () => {
    await setup({ searchFlat: false });
    type("gam");
    press("ArrowUp");
    press("ArrowUp");
    expect(selectedTitle()).toBe("Tools");
    const space = new KeyboardEvent("keydown", { key: " ", cancelable: true });
    document.querySelector("#search")?.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false);
    press("Enter");
    expect(titles()).toEqual(["Tools", "Nested", "Gamma"]);
    type("");
    expect(titles()).toHaveLength(8);
  });

  it("skips collapsed folders when searchCollapsed is off", async () => {
    await setup({ searchFlat: false, searchCollapsed: false });
    mouse(rowByTitle("Nested"), "click");
    type("test");
    expect(titles()).toEqual(["Alpha", "Tools", "Beta", "Relay"]);
  });
});

describe("search in other languages", () => {
  beforeEach(() => {
    extraBookmarks.push(
      { type: "bookmark", title: "Новости дня", url: "https://news.test" },
      { type: "bookmark", title: "Ёлки зелёные", url: "https://trees.test" },
      { type: "bookmark", title: "Crème brûlée", url: "https://dessert.test" },
    );
  });

  afterEach(() => {
    extraBookmarks.length = 0;
  });

  it("matches Cyrillic words", async () => {
    await setup();
    type("новости");
    expect(titles()).toEqual(["Новости дня"]);
  });

  it("tolerates a single typo in a Cyrillic term", async () => {
    await setup();
    type("новсти");
    expect(titles()).toEqual(["Новости дня"]);
  });

  it("treats е and ё as the same letter in both directions", async () => {
    await setup();
    type("елки зеленые");
    expect(titles()).toEqual(["Ёлки зелёные"]);
    type("ЁЛКИ");
    expect(titles()).toEqual(["Ёлки зелёные"]);
  });

  it("ignores diacritics on Latin letters", async () => {
    await setup();
    // "brûlée" has two accents — more than the single typo the search forgives
    type("brulee");
    expect(titles()).toEqual(["Crème brûlée"]);
    type("brûlée");
    expect(titles()).toEqual(["Crème brûlée"]);
  });

  it("highlights the original accented title", async () => {
    await setup();
    type("елки");
    expect(rowByTitle("Ёлки зелёные")?.querySelector(".title mark")?.textContent).toBe("Ёлки");
  });
});

describe("keyboard", () => {
  it("moves selection with arrows and stays within bounds", async () => {
    await setup();
    press("ArrowDown");
    expect(selectedTitle()).toBe("Tools");
    press("ArrowUp");
    press("ArrowUp");
    expect(selectedTitle()).toBe("Alpha");
  });

  it("opens the selected bookmark in a new tab on Ctrl+Enter", async () => {
    await setup();
    press("Enter", { ctrlKey: true });
    expect(window.open).toHaveBeenCalledWith("https://alpha.test", "_blank", "noopener");
  });

  it("collapses a folder on Enter", async () => {
    await setup();
    press("ArrowDown");
    press("Enter");
    expect(titles()).toEqual(["Alpha", "Tools", "Broken", "Relay", "YouTube"]);
  });

  it("toggles the selected folder on Space", async () => {
    await setup();
    press("ArrowDown");
    press(" ");
    expect(titles()).toEqual(["Alpha", "Tools", "Broken", "Relay", "YouTube"]);
    press(" ");
    expect(titles()).toHaveLength(8);
  });

  it("collapses an expanded folder on ArrowLeft and re-expands on ArrowRight", async () => {
    await setup();
    press("ArrowDown");
    press("ArrowLeft");
    expect(titles()).toEqual(["Alpha", "Tools", "Broken", "Relay", "YouTube"]);
    press("ArrowRight");
    expect(titles()).toHaveLength(8);
  });

  it("moves into an expanded folder on ArrowRight", async () => {
    await setup();
    press("ArrowDown");
    press("ArrowRight");
    expect(selectedTitle()).toBe("Beta");
  });

  it("jumps to the parent folder on ArrowLeft", async () => {
    await setup();
    for (let i = 0; i < 4; i++) {
      press("ArrowDown");
    }
    expect(selectedTitle()).toBe("Gamma");
    press("ArrowLeft");
    expect(selectedTitle()).toBe("Nested");
    press("ArrowLeft");
    press("ArrowLeft");
    expect(selectedTitle()).toBe("Tools");
  });

  it("moves selection by a visible page on PageDown/PageUp and stays within bounds", async () => {
    await setup();
    // 4 rows fit into the list, so a page is 3 rows
    Object.defineProperty(document.querySelector("#list"), "clientHeight", { value: 100 });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(25);
    press("PageDown");
    expect(selectedTitle()).toBe("Nested");
    press("PageDown");
    expect(selectedTitle()).toBe("Relay");
    press("PageDown");
    expect(selectedTitle()).toBe("YouTube");
    press("PageUp");
    expect(selectedTitle()).toBe("Gamma");
    press("PageUp");
    press("PageUp");
    expect(selectedTitle()).toBe("Alpha");
  });

  it("moves by at least one row when the list has no layout", async () => {
    await setup();
    press("PageDown");
    expect(selectedTitle()).toBe("Tools");
    press("PageUp");
    expect(selectedTitle()).toBe("Alpha");
  });

  it("leaves horizontal arrows to the input while the query is non-empty", async () => {
    await setup();
    type("beta");
    expect(selectedTitle()).toBe("Beta");
    press("ArrowLeft");
    press("ArrowRight");
    expect(selectedTitle()).toBe("Beta");
    expect(titles()).toEqual(["Beta"]);
  });
});

describe("web search", () => {
  async function setupWithSearchApi() {
    const query = vi.fn();
    const { browser } = await import("wxt/browser");
    (browser as unknown as { search?: { query: typeof query } }).search = {
      query,
    };
    await setup();
    return query;
  }

  afterEach(async () => {
    const { browser } = await import("wxt/browser");
    delete (browser as { search?: unknown }).search;
  });

  it("searches the web on Enter when nothing matches", async () => {
    const query = await setupWithSearchApi();
    type("how to exit vim");
    press("Enter");
    expect(query).toHaveBeenCalledWith({
      text: "how to exit vim",
      disposition: "CURRENT_TAB",
    });
    expect(document.body.classList.contains("navigating")).toBe(true);
  });

  it("searches in a new tab on Ctrl+Enter", async () => {
    const query = await setupWithSearchApi();
    type("how to exit vim");
    press("Enter", { ctrlKey: true });
    expect(query).toHaveBeenCalledWith({
      text: "how to exit vim",
      disposition: "NEW_TAB",
    });
    expect(document.body.classList.contains("navigating")).toBe(false);
  });

  it("does not search while a bookmark is selected", async () => {
    const query = await setupWithSearchApi();
    type("beta");
    press("Enter");
    expect(query).not.toHaveBeenCalled();
  });

  it("does nothing when the search API is unavailable", async () => {
    await setup();
    type("aaaaaa");
    press("Enter");
    expect(document.body.classList.contains("navigating")).toBe(false);
  });
});

describe("mouse", () => {
  it("opens a bookmark in the current tab on click", async () => {
    await setup();
    mouse(rowByTitle("Beta"), "click");
    expect(window.location.href).toBe("https://beta.test/");
  });

  it("opens in a new tab on Ctrl+click", async () => {
    await setup();
    mouse(rowByTitle("Beta"), "click", { ctrlKey: true });
    expect(window.open).toHaveBeenCalledWith("https://beta.test", "_blank", "noopener");
  });

  it("opens a bookmark in a new tab on middle click", async () => {
    await setup();
    mouse(rowByTitle("Gamma"), "auxclick", { button: 1 });
    expect(window.open).toHaveBeenCalledWith("https://gamma.test", "_blank", "noopener");
  });

  it("does nothing on middle click on a folder", async () => {
    await setup();
    mouse(rowByTitle("Tools"), "auxclick", { button: 1 });
    expect(window.open).not.toHaveBeenCalled();
  });

  it("does nothing on right click", async () => {
    await setup();
    mouse(rowByTitle("Beta"), "auxclick", { button: 2 });
    expect(window.open).not.toHaveBeenCalled();
  });

  it("does not open a bookmark on press without release", async () => {
    await setup();
    mouse(rowByTitle("Beta"), "mousedown");
    expect(window.open).not.toHaveBeenCalled();
  });

  it("keeps the focus in the search field on press over a row or the empty list", async () => {
    await setup();
    for (const target of [rowByTitle("Beta"), document.querySelector("#list")]) {
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      target?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it("collapses a folder on click", async () => {
    await setup();
    mouse(rowByTitle("Tools"), "click");
    expect(titles()).toEqual(["Alpha", "Tools", "Broken", "Relay", "YouTube"]);
  });
});

describe("navigation feedback", () => {
  it("marks the row and body when navigating in the current tab", async () => {
    await setup();
    mouse(rowByTitle("Beta"), "click");
    expect(document.body.classList.contains("navigating")).toBe(true);
    expect(rowByTitle("Beta")?.classList.contains("navigating")).toBe(true);
  });

  it("does not mark anything when opening in a new tab", async () => {
    await setup();
    mouse(rowByTitle("Beta"), "click", { ctrlKey: true });
    expect(document.body.classList.contains("navigating")).toBe(false);
  });

  it("moves the marker to the last activated row", async () => {
    await setup();
    mouse(rowByTitle("Beta"), "click");
    mouse(rowByTitle("Gamma"), "click");
    expect(rowByTitle("Beta")?.classList.contains("navigating")).toBe(false);
    expect(rowByTitle("Gamma")?.classList.contains("navigating")).toBe(true);
  });

  it("clears the feedback when restored from the back/forward cache", async () => {
    await setup();
    mouse(rowByTitle("Beta"), "click");
    const pageshow = new Event("pageshow");
    Object.defineProperty(pageshow, "persisted", { value: true });
    window.dispatchEvent(pageshow);
    expect(document.body.classList.contains("navigating")).toBe(false);
    expect(rowByTitle("Beta")?.classList.contains("navigating")).toBe(false);
  });

  it("clears the feedback when the user types again", async () => {
    await setup();
    mouse(rowByTitle("Beta"), "click");
    type("gam");
    expect(document.body.classList.contains("navigating")).toBe(false);
  });
});

describe("non-web URLs", () => {
  const dataUrl = "data:text/html,<title>White</title>";

  async function setupWithTabs(create: () => Promise<unknown> = async () => ({})) {
    extraBookmarks.push({ type: "bookmark", title: "White", url: dataUrl });
    extraBookmarks.push({ type: "bookmark", title: "Flags", url: "chrome://flags" });
    const { browser } = await import("wxt/browser");
    vi.spyOn(browser.tabs, "getCurrent").mockResolvedValue({
      id: 7,
      index: 2,
      windowId: 1,
    } as never);
    const updateSpy = vi.spyOn(browser.tabs, "update").mockResolvedValue({} as never);
    const createSpy = vi.spyOn(browser.tabs, "create").mockImplementation(create as never);
    const removeSpy = vi.spyOn(browser.tabs, "remove").mockResolvedValue(undefined as never);
    await setup();
    return { updateSpy, createSpy, removeSpy };
  }

  afterEach(() => {
    extraBookmarks.length = 0;
  });

  it("replaces the current tab with a new one for a data: URL", async () => {
    const { createSpy, removeSpy, updateSpy } = await setupWithTabs();
    const before = window.location.href;
    mouse(rowByTitle("White"), "click");
    await vi.waitFor(() => expect(removeSpy).toHaveBeenCalledWith(7));
    expect(createSpy).toHaveBeenCalledWith({ url: dataUrl, index: 2, windowId: 1 });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    expect(document.body.classList.contains("navigating")).toBe(true);
  });

  it("opens another non-web URL in the current tab through the tabs API", async () => {
    const { updateSpy } = await setupWithTabs();
    mouse(rowByTitle("Flags"), "click");
    await vi.waitFor(() => expect(updateSpy).toHaveBeenCalledWith(7, { url: "chrome://flags" }));
  });

  it("opens a data: URL in a new tab next to the current one", async () => {
    const { createSpy } = await setupWithTabs();
    mouse(rowByTitle("White"), "click", { ctrlKey: true });
    await vi.waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith({ url: dataUrl, index: 3, openerTabId: 7 }),
    );
    expect(window.open).not.toHaveBeenCalled();
  });

  it("ends the navigation feedback when the browser refuses the URL", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { removeSpy } = await setupWithTabs(async () => {
      throw new Error("Illegal URL");
    });
    mouse(rowByTitle("White"), "click");
    await vi.waitFor(() => expect(document.body.classList.contains("navigating")).toBe(false));
    expect(removeSpy).not.toHaveBeenCalled();
  });
});

describe("bookmarklets", () => {
  const notice = () => document.querySelector("#list-notice")?.textContent;

  beforeEach(() => {
    extraBookmarks.push({ type: "bookmark", title: "Edit", url: "javascript:void(0)" });
  });

  afterEach(() => {
    extraBookmarks.length = 0;
  });

  it("explains instead of running one, without navigation feedback", async () => {
    await setup();
    const before = window.location.href;
    mouse(rowByTitle("Edit"), "click");
    expect(notice()).toBe("Bookmarklets run on a web page, not on the new tab");
    expect(window.location.href).toBe(before);
    expect(document.body.classList.contains("navigating")).toBe(false);
  });

  it("does not open one in a new tab either", async () => {
    await setup();
    mouse(rowByTitle("Edit"), "auxclick", { button: 1 });
    expect(window.open).not.toHaveBeenCalled();
    expect(notice()).toBe("Bookmarklets run on a web page, not on the new tab");
  });

  it("clears the notice on typing or opening another bookmark", async () => {
    await setup();
    mouse(rowByTitle("Edit"), "click");
    type("ed");
    expect(notice()).toBe("");
    type("");
    mouse(rowByTitle("Edit"), "click");
    mouse(rowByTitle("Beta"), "click");
    expect(notice()).toBe("");
  });
});

describe("favicons", () => {
  const faviconSrc = (title: string) =>
    rowByTitle(title)?.querySelector(".favicon")?.getAttribute("src");

  const googleFavicon =
    "https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https%3A%2F%2Falpha.test&size=64";

  it("builds a Google URL for the google provider", async () => {
    await setup({ faviconProvider: "google" });
    expect(faviconSrc("Alpha")).toBe(googleFavicon);
  });

  it("builds a DuckDuckGo URL for the duckduckgo provider", async () => {
    await setup({ faviconProvider: "duckduckgo" });
    expect(faviconSrc("Alpha")).toBe("https://icons.duckduckgo.com/ip3/alpha.test.ico");
  });

  it("uses the extension API for the chrome provider when available", async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        getURL: (path: string) => `chrome-extension://test-id${path}`,
      },
    });
    await setup({ faviconProvider: "chrome" });
    expect(faviconSrc("Alpha")).toBe(
      "chrome-extension://test-id/_favicon/?pageUrl=https%3A%2F%2Falpha.test&size=64",
    );
  });

  it("renders the fallback glyph for the chrome provider outside an extension", async () => {
    await setup({ faviconProvider: "chrome" });
    const favicon = rowByTitle("Alpha")?.querySelector(".favicon");
    expect(favicon?.classList.contains("favicon-fallback")).toBe(true);
    expect(favicon?.tagName).not.toBe("IMG");
  });

  it("renders the fallback glyph for an invalid bookmark URL", async () => {
    await setup({ faviconProvider: "google" });
    const favicon = rowByTitle("Broken")?.querySelector(".favicon");
    expect(favicon?.classList.contains("favicon-fallback")).toBe(true);
    expect(favicon?.tagName).not.toBe("IMG");
  });

  it("swaps a failed favicon image for the fallback glyph", async () => {
    await setup({ faviconProvider: "google" });
    const img = rowByTitle("Alpha")?.querySelector("img.favicon");
    if (!img) {
      throw new Error("favicon image not found");
    }
    img.dispatchEvent(new Event("error"));
    const favicon = rowByTitle("Alpha")?.querySelector(".favicon");
    expect(favicon?.classList.contains("favicon-fallback")).toBe(true);
  });
});

describe("folder collapse persistence", () => {
  it("keeps a collapsed folder collapsed after a re-init", async () => {
    await setup();
    mouse(rowByTitle("Tools"), "click");
    expect(titles()).toEqual(["Alpha", "Tools", "Broken", "Relay", "YouTube"]);
    await setup();
    expect(titles()).toEqual(["Alpha", "Tools", "Broken", "Relay", "YouTube"]);
  });

  it("persists nested folder state independently", async () => {
    await setup();
    mouse(rowByTitle("Nested"), "click");
    await setup();
    expect(titles()).toEqual(["Alpha", "Tools", "Beta", "Nested", "Broken", "Relay", "YouTube"]);
  });

  it("forgets the collapsed state after re-expanding", async () => {
    await setup();
    mouse(rowByTitle("Tools"), "click");
    mouse(rowByTitle("Tools"), "click");
    await setup();
    expect(titles()).toHaveLength(8);
  });
});
