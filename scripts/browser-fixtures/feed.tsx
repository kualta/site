import { createRoot } from "react-dom/client";
import FeedComposer from "../../src/components/FeedComposer";
import "../../src/scripts/published-feed-post";
import {
  reconcilePublishedRows,
  restorePublishedRows,
  uniqueHistoricalRows,
  mergeNewestRows,
} from "../../src/lib/bluesky/published-feed";
const list = document.querySelector<HTMLOListElement>("ol")!;
window.addEventListener("bluesky:published", () => restorePublishedRows(list));
(window as any).reconcile = (html: string) => {
  const template = document.createElement("template");
  template.innerHTML = html;
  list.replaceChildren(
    ...mergeNewestRows([...list.children] as HTMLElement[], [...template.content.children] as HTMLElement[]),
  );
};
(window as any).older = (html: string) => {
  const template = document.createElement("template");
  template.innerHTML = html;
  list.append(...uniqueHistoricalRows(list, [...template.content.children] as HTMLElement[]));
};
(window as any).navigate = () => {
  list.replaceChildren();
  restorePublishedRows(list);
};
createRoot(document.querySelector("#composer")!).render(<FeedComposer />);
