import { defineConfig } from "wxt";

// The image of the day feed; the page asks for the same origin (BING_ACCESS in background.ts)
const BING_HOSTS = "https://www.bing.com/*";

export default defineConfig({
  imports: false,
  // Called after WXT has loaded the .env files into process.env
  manifest: ({ browser, manifestVersion }) => {
    checkBackendUrl();
    return {
      name: "kMarkTab",
      description:
        "A keyboard-first new tab with searchable bookmarks, a clock, and custom backgrounds.",
      permissions: [
        "storage",
        "bookmarks",
        "search",
        // Firefox does not have favicon api for extensions
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1315616
        ...(browser === "firefox" ? [] : ["favicon"]),
      ],
      // No host_permissions: the backend sends CORS headers, so its responses need none
      // Asked for when the Bing background is chosen, so that installing doesn't warn about it.
      // WXT drops optional_host_permissions from MV2 instead of moving them: there hosts are
      // optional_permissions.
      ...(manifestVersion === 2
        ? { optional_permissions: [BING_HOSTS] }
        : { optional_host_permissions: [BING_HOSTS] }),
    };
  },
});

// WXT_BACKEND_URL is set in .env; the page reads it as import.meta.env.WXT_BACKEND_URL.
// Checked here so that a build without it, or with a malformed one, fails.
function checkBackendUrl() {
  const url = process.env.WXT_BACKEND_URL;
  if (!url) {
    throw new Error("WXT_BACKEND_URL is not set");
  }
  new URL(url);
}
