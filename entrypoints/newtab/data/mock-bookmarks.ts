import type { TreeNode } from "./bookmark-tree";

// Mock tree for local development (pnpm dev); unused in production builds,
// where the tree comes from browser.bookmarks.
export const mockBookmarkTree: TreeNode[] = [
  { type: "bookmark", title: "GitHub", url: "https://github.com" },
  { type: "bookmark", title: "YouTube", url: "https://youtube.com" },
  { type: "bookmark", title: "Gmail", url: "https://mail.google.com" },
  {
    type: "folder",
    id: "dev",
    title: "Development",
    children: [
      {
        type: "bookmark",
        title: "MDN Web Docs",
        url: "https://developer.mozilla.org",
      },
      {
        type: "bookmark",
        title: "Stack Overflow",
        url: "https://stackoverflow.com",
      },
      {
        type: "bookmark",
        title: "Rust Docs",
        url: "https://doc.rust-lang.org",
      },
      {
        type: "folder",
        id: "frontend",
        title: "Frontend",
        children: [
          {
            type: "bookmark",
            title: "CSS Tricks",
            url: "https://css-tricks.com",
          },
          { type: "bookmark", title: "Can I Use", url: "https://caniuse.com" },
        ],
      },
    ],
  },
  {
    type: "folder",
    id: "news",
    title: "News",
    children: [
      {
        type: "bookmark",
        title: "Hacker News",
        url: "https://news.ycombinator.com",
      },
      { type: "bookmark", title: "Lobsters", url: "https://lobste.rs" },
    ],
  },
  { type: "bookmark", title: "Reddit", url: "https://reddit.com" },
];
