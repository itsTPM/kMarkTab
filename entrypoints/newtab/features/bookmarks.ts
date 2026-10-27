import uFuzzy from "@leeoniya/ufuzzy";
import { browser } from "wxt/browser";
import { storage } from "#imports";
import { q, setScrollbarGutter } from "../core/dom";
import { getSettings } from "../core/settings";
import {
  type BookmarkNode,
  type FolderNode,
  loadBookmarkTree,
  type TreeNode,
} from "../data/bookmark-tree";

const ROW_BASE_PAD = 10;
const ROW_INDENT = 18;

// The rendered tree is a flat list of sibling elements, so each row carries the
// position among *its own* siblings for aria-posinset/aria-setsize.
interface RowPosition {
  depth: number;
  posinset: number;
  setsize: number;
}

type Row =
  | (RowPosition & {
      node: BookmarkNode;
      isFolder?: false;
      // folder path and match ranges — only on search-result rows
      crumb?: string;
      ranges?: number[];
    })
  | (RowPosition & { node: FolderNode; isFolder: true });

const searchEl = q<HTMLInputElement>("#search");
const listEl = q<HTMLDivElement>("#list");
const emptyEl = q<HTMLDivElement>("#list-empty");
const noticeEl = q<HTMLParagraphElement>("#list-notice");

let bookmarkTree: TreeNode[] = [];

// Folder expansion is tracked by tree-node identity; collapsed folders outlive
// the tab — their ids are persisted in local:collapsedFolders
const expandedFolders = new Set<FolderNode>();
const collapsedFoldersItem = storage.defineItem<string[]>("local:collapsedFolders", {
  fallback: [],
});
let query = "";
let flatRows: Row[] = [];
let rowEls: HTMLDivElement[] = [];
let selectedIndex = 0;

function expandFolders(nodes: TreeNode[], collapsedIds: ReadonlySet<string>) {
  for (const node of nodes) {
    if (node.type !== "folder") {
      continue;
    }
    if (!collapsedIds.has(node.id)) {
      expandedFolders.add(node);
    }
    expandFolders(node.children, collapsedIds);
  }
}

function collectCollapsedIds(nodes: TreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type !== "folder") {
      continue;
    }
    if (!expandedFolders.has(node)) {
      out.push(node.id);
    }
    collectCollapsedIds(node.children, out);
  }
  return out;
}

// Search: uFuzzy ranks a flat "title + URL" index; intraMode 1 tolerates one
// typo per word, and out-of-order terms are allowed. uFuzzy's default patterns
// only know A-Z (any other letter splits words), so they are widened to all
// Unicode letters.
const fuzzy = new uFuzzy({
  intraMode: 1,
  unicode: true,
  interSplit: "[^\\p{L}\\d']+",
  intraSplit: "\\p{Ll}\\p{Lu}",
  intraBound: "\\p{L}\\d|\\d\\p{L}|\\p{Ll}\\p{Lu}",
  intraChars: "[\\p{L}\\d']",
  intraContr: "'\\p{L}{1,2}\\b",
});

// Fold accented Latin letters to plain ones (café → cafe) and ё to е, so either
// spelling matches. Every replacement is one character for one, which keeps
// uFuzzy's match ranges valid for highlighting the original title.
function foldForSearch(text: string): string {
  return uFuzzy.latinize(text).replace(/ё/g, "е").replace(/Ё/g, "Е");
}

interface SearchEntry {
  node: BookmarkNode;
  folderPath: string;
}

const searchEntries: SearchEntry[] = [];
const haystacks: string[] = [];

function buildSearchIndex(nodes: TreeNode[], path: string[]) {
  for (const node of nodes) {
    if (node.type === "bookmark") {
      searchEntries.push({ node, folderPath: path.join(" / ") });
      haystacks.push(foldForSearch(`${node.title} ${node.url}`));
    } else {
      buildSearchIndex(node.children, [...path, node.title]);
    }
  }
}

// Hit faviconV2 directly instead of www.google.com/s2/favicons: the redirect from
// there rewrites the parameter to url=http://…, and over http Google returns
// wrong or stale icons.
function googleFaviconUrl(host: string): string {
  return `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(`https://${host}`)}&size=64`;
}

function faviconUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    switch (getSettings().faviconProvider) {
      case "duckduckgo":
        return `https://icons.duckduckgo.com/ip3/${host}.ico`;
      case "chrome": {
        if (!globalThis.chrome?.runtime?.getURL) {
          throw new Error("Not in the chrome extension context");
        }

        const api = new URL(globalThis.chrome.runtime.getURL("/_favicon/"));
        api.searchParams.set("pageUrl", url);
        api.searchParams.set("size", "64");
        return api.toString();
      }
      default:
        return googleFaviconUrl(host);
    }
  } catch {
    return "";
  }
}

function faviconFallback(): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "favicon favicon-fallback";
  return span;
}

function createFaviconElement(src: string): HTMLElement {
  if (!src) {
    return faviconFallback();
  }
  const img = document.createElement("img");
  img.className = "favicon";
  img.src = src;
  img.alt = "";
  img.addEventListener("error", () => img.replaceWith(faviconFallback()), {
    once: true,
  });
  return img;
}

// The whole tree (empty query): folders group the bookmarks in tree order.
function buildTreeRows(nodes: TreeNode[], depth: number, rows: Row[]) {
  nodes.forEach((node, i) => {
    const pos = { depth, posinset: i + 1, setsize: nodes.length };
    if (node.type === "bookmark") {
      rows.push({ node, ...pos });
    } else {
      rows.push({ node, ...pos, isFolder: true });
      if (expandedFolders.has(node)) {
        buildTreeRows(node.children, depth + 1, rows);
      }
    }
  });
}

// Search results: a flat list ordered by descending relevance, without folders.
function buildSearchRows(rows: Row[]) {
  const [idxs, info, order] = fuzzy.search(haystacks, foldForSearch(query), 1);
  if (!idxs) {
    return;
  }
  if (info && order) {
    for (const infoIdx of order) {
      const haystackIdx = info.idx[infoIdx];
      const entry = haystackIdx === undefined ? undefined : searchEntries[haystackIdx];
      if (!entry) {
        continue;
      }
      rows.push({
        node: entry.node,
        depth: 0,
        posinset: rows.length + 1,
        setsize: 0,
        crumb: entry.folderPath,
        ranges: info.ranges[infoIdx],
      });
    }
  } else {
    // if the result set is large (larger than infoThresh) uFuzzy returns filtered indexes only
    for (const i of idxs) {
      const entry = searchEntries[i];
      if (!entry) {
        continue;
      }
      rows.push({
        node: entry.node,
        depth: 0,
        posinset: rows.length + 1,
        setsize: 0,
        crumb: entry.folderPath,
      });
    }
  }
  // the sibling count is only known once the whole result list is built
  for (const row of rows) {
    row.setsize = rows.length;
  }
}

// uFuzzy's match ranges are relative to the 'title + " " + url' haystack;
// highlight only the part that falls inside the visible title.
function appendHighlighted(el: HTMLElement, text: string, ranges: number[]) {
  let pos = 0;
  for (let i = 0; i < ranges.length; i += 2) {
    const start = Math.min(ranges[i] ?? text.length, text.length);
    const end = Math.min(ranges[i + 1] ?? 0, text.length);
    if (end <= start) {
      continue;
    }
    if (start > pos) {
      el.append(text.slice(pos, start));
    }
    const mark = document.createElement("mark");
    mark.textContent = text.slice(start, end);
    el.append(mark);
    pos = end;
  }
  if (pos < text.length) {
    el.append(text.slice(pos));
  }
}

function firstBookmarkIndex() {
  const i = flatRows.findIndex((row) => !row.isFolder);
  return i === -1 ? 0 : i;
}

function createRowElement(row: Row, index: number) {
  const el = document.createElement("div");
  el.className = `row ${row.isFolder ? "folder" : "bookmark"}`;
  el.style.paddingLeft = `${ROW_BASE_PAD + row.depth * ROW_INDENT}px`;

  // The nesting is only visual (an indent), so the structure the APG treeview
  // pattern normally reads off nested role="group" elements is spelled out here.
  // The id is what aria-activedescendant on the search field points at.
  el.id = `row-${index}`;
  el.setAttribute("role", "treeitem");
  el.setAttribute("aria-level", String(row.depth + 1));
  el.setAttribute("aria-posinset", String(row.posinset));
  el.setAttribute("aria-setsize", String(row.setsize));

  const title = document.createElement("span");
  title.className = "title";
  if (!row.isFolder && row.ranges) {
    appendHighlighted(title, row.node.title, row.ranges);
  } else {
    title.textContent = row.node.title;
  }

  if (row.isFolder) {
    const expanded = expandedFolders.has(row.node);
    el.setAttribute("aria-expanded", String(expanded));
    if (expanded) {
      el.classList.add("expanded");
    }
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "▶";
    arrow.setAttribute("aria-hidden", "true");
    el.append(arrow, title);
  } else {
    el.append(createFaviconElement(faviconUrl(row.node.url)), title);
    if (row.crumb) {
      const crumb = document.createElement("span");
      crumb.className = "crumb";
      crumb.textContent = row.crumb;
      el.append(crumb);
    }
  }

  // click/auxclick only fire when the button is released over the same row —
  // just like an ordinary link
  el.addEventListener("click", (e) => {
    selectedIndex = index;
    applySelection();
    activate(row, e.ctrlKey || e.metaKey);
  });

  el.addEventListener("auxclick", (e) => {
    if (e.button !== 1 || row.isFolder) {
      return;
    }
    selectedIndex = index;
    applySelection();
    openBookmark(row.node.url, true);
  });

  return el;
}

function showEmpty(title: string, text: string): void {
  const titleEl = document.createElement("p");
  titleEl.className = "empty-title";
  titleEl.textContent = title;
  const textEl = document.createElement("p");
  textEl.textContent = text;
  emptyEl.replaceChildren(titleEl, textEl);
}

function render() {
  flatRows = [];
  if (query) {
    buildSearchRows(flatRows);
  } else {
    buildTreeRows(bookmarkTree, 0, flatRows);
  }

  listEl.innerHTML = "";
  rowEls = [];

  // aria-expanded on the combobox describes whether the popup shows anything
  searchEl.setAttribute("aria-expanded", String(flatRows.length > 0));

  if (flatRows.length === 0) {
    if (query) {
      showEmpty("No matches", "Press Enter to search the web");
    } else {
      showEmpty("No bookmarks yet", "Add some websites to your browser bookmarks to see them here");
    }
    searchEl.removeAttribute("aria-activedescendant");
    return;
  }

  emptyEl.textContent = "";

  flatRows.forEach((row, i) => {
    const el = createRowElement(row, i);
    listEl.appendChild(el);
    rowEls.push(el);
  });

  if (selectedIndex >= flatRows.length) {
    selectedIndex = flatRows.length - 1;
  }
  applySelection();
}

function applySelection() {
  rowEls.forEach((el, i) => {
    const selected = i === selectedIndex;
    el.classList.toggle("selected", selected);
    el.setAttribute("aria-selected", String(selected));
  });
  const active = rowEls[selectedIndex];
  active?.scrollIntoView({ block: "nearest" });
  // focus never leaves the search field, so the active row is named this way
  if (active) {
    searchEl.setAttribute("aria-activedescendant", active.id);
  } else {
    searchEl.removeAttribute("aria-activedescendant");
  }
}

// How far PageUp/PageDown move: the rows that fit into the list, less one, so the
// previously selected row stays in view
function pageSize() {
  const rowHeight = rowEls[selectedIndex]?.offsetHeight ?? 0;
  if (rowHeight === 0) {
    return 1;
  }
  return Math.max(1, Math.floor(listEl.clientHeight / rowHeight) - 1);
}

function toggleFolder(node: FolderNode) {
  if (expandedFolders.has(node)) {
    expandedFolders.delete(node);
  } else {
    expandedFolders.add(node);
  }
  void collapsedFoldersItem.setValue(collectCollapsedIds(bookmarkTree));
  render();
}

// The tab stays visible while the browser loads the page — show a spinner on the
// selected row and dim the panel.
function beginNavigation() {
  endNavigation();
  document.body.classList.add("navigating");
  rowEls[selectedIndex]?.classList.add("navigating");
}

function endNavigation() {
  document.body.classList.remove("navigating");
  listEl.querySelector(".row.navigating")?.classList.remove("navigating");
}

// A page may navigate itself to web URLs only: Chrome silently drops a top-level
// navigation to data: (the spinner would never end), and an extension page cannot
// open file: or browser pages either. The tabs API can; Firefox refuses such URLs
// there too, and the rejection ends the navigation feedback.
function needsTabsApi(url: string) {
  return /^[a-z][a-z\d+.-]*:/i.test(url) && !/^(https?|javascript):/i.test(url);
}

async function openWithTabsApi(url: string, newTab: boolean) {
  try {
    const current = await browser.tabs.getCurrent();
    if (newTab) {
      await browser.tabs.create({
        url,
        index: current && current.index + 1,
        openerTabId: current?.id,
      });
    } else if (/^data:/i.test(url) && current?.id !== undefined) {
      // Chrome drops tabs.update() to data: as well ("Not allowed to navigate top
      // frame to data URL"), but tabs.create() opens it: replace this tab with a new
      // one at its place. The tab's back history is lost.
      await browser.tabs.create({ url, index: current.index, windowId: current.windowId });
      await browser.tabs.remove(current.id);
    } else {
      await browser.tabs.update(current?.id, { url });
    }
  } catch (error) {
    console.warn(`Cannot open ${url}`, error);
    endNavigation();
  }
}

function openBookmark(url: string, newTab: boolean) {
  noticeEl.textContent = "";
  // A bookmarklet acts on the page open in the tab, and there is none here: this is
  // the extension's own page, whose CSP blocks javascript: URLs anyway.
  if (/^javascript:/i.test(url)) {
    noticeEl.textContent = "Bookmarklets run on a web page, not on the new tab";
    return;
  }
  if (needsTabsApi(url)) {
    if (!newTab) {
      beginNavigation();
    }
    void openWithTabsApi(url, newTab);
  } else if (newTab) {
    window.open(url, "_blank", "noopener");
  } else {
    beginNavigation();
    window.location.href = url;
  }
}

function activate(row: Row, newTab: boolean) {
  if (row.isFolder) {
    toggleFolder(row.node);
  } else {
    openBookmark(row.node.url, newTab);
  }
}

// The browser's default search engine; requires the "search" permission
function searchWeb(text: string, newTab: boolean) {
  if (!browser.search?.query) {
    return;
  }
  if (!newTab) {
    beginNavigation();
  }
  void browser.search.query({
    text,
    disposition: newTab ? "NEW_TAB" : "CURRENT_TAB",
  });
}

function clearSearch() {
  searchEl.value = "";
  onSearchInput();
}

function onSearchInput() {
  // navigation may never have happened — typing clears the indicator
  endNavigation();
  noticeEl.textContent = "";
  query = searchEl.value.trim();
  render();
  selectedIndex = firstBookmarkIndex();
  applySelection();
}

// ←/→ control folders only while the search field is empty — otherwise they move
// the caret inside the input.
function onSearchKeydown(e: KeyboardEvent) {
  const sel = flatRows[selectedIndex];

  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      if (flatRows.length === 0) {
        break;
      }
      selectedIndex = Math.min(flatRows.length - 1, selectedIndex + 1);
      applySelection();
      break;
    case "ArrowUp":
      e.preventDefault();
      selectedIndex = Math.max(0, selectedIndex - 1);
      applySelection();
      break;
    case "PageDown":
      e.preventDefault();
      if (flatRows.length === 0) {
        break;
      }
      selectedIndex = Math.min(flatRows.length - 1, selectedIndex + pageSize());
      applySelection();
      break;
    case "PageUp":
      e.preventDefault();
      selectedIndex = Math.max(0, selectedIndex - pageSize());
      applySelection();
      break;
    case "ArrowRight":
      if (searchEl.value !== "" || !sel?.isFolder) {
        break;
      }
      e.preventDefault();
      if (!expandedFolders.has(sel.node)) {
        toggleFolder(sel.node);
      } else if (selectedIndex < flatRows.length - 1) {
        selectedIndex += 1;
        applySelection();
      }
      break;
    case "ArrowLeft":
      if (searchEl.value !== "" || !sel) {
        break;
      }
      if (sel.isFolder && expandedFolders.has(sel.node)) {
        e.preventDefault();
        toggleFolder(sel.node);
      } else if (sel.depth > 0) {
        e.preventDefault();
        for (let i = selectedIndex - 1; i >= 0; i--) {
          const row = flatRows[i];
          if (row?.isFolder && row.depth === sel.depth - 1) {
            selectedIndex = i;
            applySelection();
            break;
          }
        }
      }
      break;
    case "Enter":
      e.preventDefault();
      if (sel) {
        activate(sel, e.ctrlKey || e.metaKey);
      } else if (query) {
        searchWeb(query, e.ctrlKey || e.metaKey);
      }
      break;
    case " ":
      // Space toggles the folder instead of typing a space into the search field
      if (sel?.isFolder) {
        e.preventDefault();
        toggleFolder(sel.node);
      }
      break;
    case "Escape":
      if (searchEl.value !== "") {
        e.preventDefault();
        clearSearch();
      }
      break;
  }
}

export function rerenderBookmarks() {
  render();
}

export function focusSearch() {
  searchEl.focus();
}

export async function initBookmarks() {
  const [tree, collapsedIds] = await Promise.all([
    loadBookmarkTree(),
    collapsedFoldersItem.getValue(),
  ]);
  bookmarkTree = tree;
  buildSearchIndex(bookmarkTree, []);
  expandFolders(bookmarkTree, new Set(collapsedIds));
  searchEl.addEventListener("input", onSearchInput);
  searchEl.addEventListener("keydown", onSearchKeydown);
  // Keep the focus on the search field — on a row as well as on the empty space
  // below the rows, which tabindex="-1" would otherwise make focus the list itself.
  // This also disables middle-click autoscroll.
  listEl.addEventListener("mousedown", (e) => e.preventDefault());
  // coming back through the bfcache shows the tab in its previous state
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      endNavigation();
    }
  });
  setScrollbarGutter(listEl);
  window.addEventListener("resize", () => setScrollbarGutter(listEl));
  render();
  selectedIndex = firstBookmarkIndex();
  applySelection();
  searchEl.focus();
}
