import { calendarMonths, type StoryDay } from "@/lib/videos";
import { firstToShow, warmWhenNear } from "./stories-viewer";

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** What a day's ring or calendar cell is called: "Nov 16: 4 stories". */
export function dayName(day: StoryDay): string {
  return `${day.label}: ${day.stories.length} ${day.stories.length === 1 ? "story" : "stories"}`;
}

/**
 * Fills `container` with the stories calendar, as Instagram's archive shows it: a grid per month from the first day with
 * stories to the last, each such day showing its picture and opening its stories, and on into the days after it. The
 * newest month comes first, so the page opens on what's recent.
 */
export function renderCalendar(
  container: HTMLElement,
  days: StoryDay[],
  open: (position: number, from: HTMLElement) => void,
): void {
  const positions = new Map(days.map((day, position) => [day.day, position]));
  const cell = (className: string, text = ""): HTMLElement => {
    const element = document.createElement("span");
    element.className = className;
    element.textContent = text;
    return element;
  };
  container.replaceChildren(
    ...calendarMonths(days.map((day) => day.day))
      .reverse()
      .map((month) => {
        const section = document.createElement("section");
        section.className = "story-month";
        section.setAttribute("aria-label", month.label);
        const title = document.createElement("h2");
        title.textContent = month.label;
        const grid = document.createElement("div");
        grid.className = "story-month-grid";
        for (const name of WEEKDAYS) grid.append(cell("story-weekday", name));
        for (let blank = 0; blank < month.lead; blank++) grid.append(cell("story-date"));
        for (const date of month.days) {
          const number = String(Number(date.slice(8)));
          const position = positions.get(date);
          if (position === undefined) {
            grid.append(cell("story-date", number));
            continue;
          }
          const day = days[position];
          const button = document.createElement("button");
          button.type = "button";
          button.className = "story-date story-date-has";
          button.setAttribute("aria-label", dayName(day));
          const cover = day.stories.at(-1)?.thumbnail;
          if (cover) {
            const image = new Image();
            image.alt = "";
            image.decoding = "async";
            image.loading = "lazy";
            image.src = cover;
            button.append(image);
          }
          button.append(cell("", number));
          button.addEventListener("click", () => open(position, button));
          warmWhenNear(button, undefined, () => firstToShow(day.stories));
          grid.append(button);
        }
        section.append(title, grid);
        return section;
      }),
  );
}
