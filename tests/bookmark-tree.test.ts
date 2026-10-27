import { describe, expect, it } from "vitest";
import type { Browser } from "wxt/browser";
import { browserTreeToNodes } from "../entrypoints/newtab/data/bookmark-tree";

type RawNode = Browser.bookmarks.BookmarkTreeNode;

// Minimal BookmarkTreeNode factory; `syncing` is required by the Chrome types
// but irrelevant to the mapping.
const raw = (node: Partial<RawNode> & Pick<RawNode, "id" | "title">): RawNode =>
  ({ syncing: false, ...node }) as RawNode;

const bookmark = (id: string, title: string, url: string) => raw({ id, title, url });

const chromeRoot = (toolbarChildren: RawNode[], otherChildren: RawNode[] = []): RawNode =>
  raw({
    id: "0",
    title: "",
    children: [
      raw({
        id: "1",
        title: "Bookmarks bar",
        folderType: "bookmarks-bar",
        children: toolbarChildren,
      }),
      raw({ id: "2", title: "Other bookmarks", children: otherChildren }),
    ],
  });

describe("browserTreeToNodes", () => {
  it("hoists toolbar children to the top level", () => {
    const tree = browserTreeToNodes(
      chromeRoot([
        bookmark("10", "GitHub", "https://github.com"),
        raw({
          id: "11",
          title: "Dev",
          children: [bookmark("12", "MDN", "https://developer.mozilla.org")],
        }),
      ]),
    );
    expect(tree).toEqual([
      { type: "bookmark", title: "GitHub", url: "https://github.com" },
      {
        type: "folder",
        id: "11",
        title: "Dev",
        children: [
          {
            type: "bookmark",
            title: "MDN",
            url: "https://developer.mozilla.org",
          },
        ],
      },
    ]);
  });

  it("appends non-empty non-toolbar roots as folders", () => {
    const tree = browserTreeToNodes(
      chromeRoot(
        [bookmark("10", "GitHub", "https://github.com")],
        [bookmark("20", "Saved", "https://example.com")],
      ),
    );
    expect(tree).toEqual([
      { type: "bookmark", title: "GitHub", url: "https://github.com" },
      {
        type: "folder",
        id: "2",
        title: "Other bookmarks",
        children: [{ type: "bookmark", title: "Saved", url: "https://example.com" }],
      },
    ]);
  });

  it("hides empty roots", () => {
    const tree = browserTreeToNodes(
      chromeRoot([bookmark("10", "GitHub", "https://github.com")], []),
    );
    expect(tree).toEqual([{ type: "bookmark", title: "GitHub", url: "https://github.com" }]);
  });

  it("recognizes the Firefox toolbar by id and skips separators", () => {
    const tree = browserTreeToNodes(
      raw({
        id: "root________",
        title: "",
        children: [
          raw({
            id: "menu________",
            title: "Bookmarks Menu",
            children: [bookmark("a", "Lobsters", "https://lobste.rs")],
          }),
          raw({
            id: "toolbar_____",
            title: "Bookmarks Toolbar",
            children: [
              bookmark("b", "HN", "https://news.ycombinator.com"),
              // Firefox-only `type` field, absent from the Chrome-style types
              { id: "c", title: "", type: "separator" } as unknown as RawNode,
              bookmark("d", "MDN", "https://developer.mozilla.org"),
            ],
          }),
        ],
      }),
    );
    expect(tree).toEqual([
      { type: "bookmark", title: "HN", url: "https://news.ycombinator.com" },
      { type: "bookmark", title: "MDN", url: "https://developer.mozilla.org" },
      {
        type: "folder",
        id: "menu________",
        title: "Bookmarks Menu",
        children: [{ type: "bookmark", title: "Lobsters", url: "https://lobste.rs" }],
      },
    ]);
  });

  it("turns all non-empty roots into folders when no toolbar is found", () => {
    const tree = browserTreeToNodes(
      raw({
        id: "0",
        title: "",
        children: [
          raw({
            id: "custom",
            title: "Managed",
            children: [bookmark("x", "Wiki", "https://wiki.example.com")],
          }),
          raw({ id: "empty", title: "Empty", children: [] }),
        ],
      }),
    );
    expect(tree).toEqual([
      {
        type: "folder",
        id: "custom",
        title: "Managed",
        children: [{ type: "bookmark", title: "Wiki", url: "https://wiki.example.com" }],
      },
    ]);
  });
});
