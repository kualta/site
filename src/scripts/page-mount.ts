/**
 * Mounts on every page that has the element, and lets go before the next page
 * swaps in, so client-side navigation never leaves a player running behind it.
 */
export function mountOnEachPage(selector: string, mount: (element: HTMLElement) => () => void): void {
  let release: (() => void) | undefined;
  document.addEventListener("astro:page-load", () => {
    release?.();
    const element = document.querySelector<HTMLElement>(selector);
    release = element ? mount(element) : undefined;
  });
  document.addEventListener("astro:before-swap", () => {
    release?.();
    release = undefined;
  });
}
