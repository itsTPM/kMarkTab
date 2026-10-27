import { type Browser, browser } from "wxt/browser";

export interface BookmarkNode {
  type: "bookmark";
  title: string;
  url: string;
}

export interface FolderNode {
  type: "folder";
  id: string;
  title: string;
  children: TreeNode[];
}

export type TreeNode = BookmarkNode | FolderNode;

// "Bookmarks bar" folder id: '1' in Chrome, 'toolbar_____' in Firefox.
// folderType only appeared in Chrome 134 and does not exist in Firefox.
const TOOLBAR_IDS = new Set(["1", "toolbar_____"]);

const isToolbar = (node: Browser.bookmarks.BookmarkTreeNode) =>
  node.folderType === "bookmarks-bar" || TOOLBAR_IDS.has(node.id);

// A Firefox-specific field, missing from the Chrome types.
// Chrome also does not have separators in bookmarks.
const isSeparator = (node: Browser.bookmarks.BookmarkTreeNode) =>
  (node as { type?: string }).type === "separator";

function toNodes(nodes: Browser.bookmarks.BookmarkTreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of nodes) {
    if (isSeparator(node)) {
      continue;
    }

    if (node.url) {
      out.push({ type: "bookmark", title: node.title, url: node.url });
    } else {
      out.push({
        type: "folder",
        id: node.id,
        title: node.title,
        children: toNodes(node.children ?? []),
      });
    }
  }
  return out;
}

// The "Bookmarks bar" contents are hoisted to the top level; the other roots
// ("Other bookmarks" and others) follow it as ordinary folders, and empty roots
// are hidden. If "Bookmarks bar" is not found, nothing is hoisted to the top level.
export function browserTreeToNodes(root: Browser.bookmarks.BookmarkTreeNode): TreeNode[] {
  const roots = root.children ?? [];
  const toolbar = roots.find(isToolbar);
  const rest = roots.filter((node) => node !== toolbar && (node.children?.length ?? 0) > 0);
  return [...toNodes(toolbar?.children ?? []), ...toNodes(rest)];
}

export async function loadBookmarkTree(): Promise<TreeNode[]> {
  // In dev builds the browser's real bookmarks are replaced by the mock tree,
  // unless started with WXT_REAL_BOOKMARKS=1 (`pnpm dev:real`). The branch and
  // the mock chunk are statically dropped from production builds.
  if (import.meta.env.COMMAND === "serve" && !import.meta.env.WXT_REAL_BOOKMARKS) {
    const { mockBookmarkTree } = await import("./mock-bookmarks");
    return mockBookmarkTree;
  }
  const [root] = await browser.bookmarks.getTree();
  return root ? browserTreeToNodes(root) : [];
}
