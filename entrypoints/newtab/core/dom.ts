export function q<T extends Element>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) {
    throw new Error(`Element not found: ${selector}`);
  }
  return el;
}

// Sets --scrollbar-gutter on an element with `scrollbar-gutter: stable` to the width reserved
// for its scrollbar (0 with overlay scrollbars), which CSS can't read. The zoom changes it in
// CSS pixels: measure again on resize.
export function setScrollbarGutter(el: HTMLElement) {
  el.style.setProperty("--scrollbar-gutter", `${el.offsetWidth - el.clientWidth}px`);
}
