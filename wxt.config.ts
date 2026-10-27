import { defineConfig } from "wxt";

export default defineConfig({
  imports: false,
  // Called after WXT has loaded the .env files into process.env
  manifest: ({ browser }) => ({
    name: "kMarkTab",
    permissions: [
      "storage",
      "bookmarks",
      "search",
      // Firefox does not have favicon api for extensions
      // https://bugzilla.mozilla.org/show_bug.cgi?id=1315616
      ...(browser === "firefox" ? [] : ["favicon"]),
    ],
    host_permissions: [`${backendOrigin()}/*`, "https://www.bing.com/*"],
  }),
});

// WXT_BACKEND_URL is set in .env; the page reads it as import.meta.env.WXT_BACKEND_URL
function backendOrigin(): string {
  const url = process.env.WXT_BACKEND_URL;
  if (!url) {
    throw new Error("WXT_BACKEND_URL is not set");
  }
  return new URL(url).origin;
}
