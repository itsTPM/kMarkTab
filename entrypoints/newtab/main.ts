import { loadSettings } from "./core/settings";
import { applyAppearance } from "./features/appearance";
import { startBackground } from "./features/background";
import { initBookmarks } from "./features/bookmarks";
import { startClock } from "./features/clock";
import { initSettingsPanel } from "./features/settings-panel";

// Settings are loaded once before the features are initialized — afterwards the
// module-level cache serves them synchronously. The page skeleton (clock, search)
// is visible right away from the static HTML; the list appears once the bookmark
// tree has loaded.
await loadSettings();

// appearance-init.js has already applied the localStorage mirror; this catches the case
// where the mirror is missing or stale
applyAppearance();
startClock();
startBackground();
await initBookmarks();
initSettingsPanel();
