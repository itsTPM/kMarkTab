// A classic synchronous script in <head>: applies the panel appearance before the first
// paint, like clock-init.js does for the clock. The settings live in async browser.storage;
// core/settings.ts mirrors these into localStorage. features/appearance.ts reuses
// window.applyAppearance. Missing or broken value → the defaults from style.css.
window.applyAppearance = (panelOpacity, panelBlur) => {
  const root = document.documentElement.style;
  root.setProperty("--panel-opacity", `${panelOpacity}%`);
  // none rather than blur(0px), which still costs a compositing layer; an opaque panel
  // has nothing behind it to blur
  root.setProperty(
    "--panel-backdrop",
    panelBlur > 0 && panelOpacity < 100 ? `blur(${panelBlur}px)` : "none",
  );
};

let appearance = {};
try {
  appearance = JSON.parse(localStorage.getItem("appearance")) ?? {};
} catch {}
if (typeof appearance.panelOpacity === "number" && typeof appearance.panelBlur === "number") {
  window.applyAppearance(appearance.panelOpacity, appearance.panelBlur);
}
