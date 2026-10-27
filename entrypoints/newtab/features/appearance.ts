// The first paint is styled by public/appearance-init.js (a synchronous script in <head>);
// this applies the settings once they are loaded and whenever they change.
import { getSettings, type Settings } from "../core/settings";

// Also previews values that aren't stored yet, while a slider is being dragged
export function applyAppearance(
  { panelOpacity, panelBlur }: Pick<Settings, "panelOpacity" | "panelBlur"> = getSettings(),
) {
  window.applyAppearance(panelOpacity, panelBlur);
}
