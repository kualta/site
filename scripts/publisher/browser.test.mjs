import { expect, test } from "bun:test";
import { closestPlace, draftListed, pickHashtag, publicationUrl, tikTokCaptionParts } from "./browser.mjs";

test("a TikTok draft counts as saved once the draft list carries its caption's first line", () => {
  const list = { status_code: 0, total_count: 1, draft_list: [{ desc: "time to go out love #fyp" }] };
  expect(draftListed(list, "time to go out love\n\n#fyp #walk")).toBe(true);
  expect(draftListed(list, "something else\n\n#fyp")).toBe(false);
  expect(draftListed({ status_code: 0, total_count: 1 }, "\n#fyp")).toBe(true);
  expect(draftListed({ status_code: 0, total_count: 0 }, "")).toBe(false);
  expect(draftListed({ status_code: 8, total_count: 1, draft_list: list.draft_list }, "time to go out love")).toBe(false);
  expect(draftListed(null, "time to go out love")).toBe(false);
});

test("TikTok links photo posts apart from videos; a YouTube post links to the post", () => {
  expect(publicationUrl("tiktok", "video", "7")).toBe("https://www.tiktok.com/@_/video/7");
  expect(publicationUrl("tiktok", "photo", "7")).toBe("https://www.tiktok.com/@_/photo/7");
  expect(publicationUrl("youtube", "photo", "Ugkx1")).toBe("https://www.youtube.com/post/Ugkx1");
  expect(publicationUrl("xiaohongshu", "photo", "abc", "https://www.rednote.com/explore")).toBe(
    "https://www.rednote.com/explore/abc",
  );
});

test("picks the place itself over places in it, ignoring accents and case", () => {
  const offered = [
    ["Habitaciones económicas x días, Teusaquillo, Bogotá.", "Cra. 30 #45, Bogotá"],
    ["波哥大市中心", "Bogota Centro"],
    ["波哥大", "Bogota"],
    ["Residence Inn by Marriott Bogota", "Cl. 90 #16-30, Bogotá, Colombia"],
  ];
  expect(closestPlace(offered, "Bogotá, Colombia")).toBe(2);
  expect(closestPlace(offered, "波哥大")).toBe(2);
});

test("prefers a name that starts with the place, then the shortest containing it", () => {
  expect(closestPlace([["Hotel Bogota Plaza"], ["Bogota DC"], ["Bogota, Colombia"]], "Bogota")).toBe(1);
  expect(closestPlace([["Monserrate bogota"], ["Norte De Bogota"]], "bogota")).toBe(1);
});

test("picks nothing when no offer is the place, rather than a nearby one", () => {
  expect(closestPlace([["Male Bathroom"], ["Cali"]], "Bogotá")).toBe(-1);
  // A nearby place's address names the city: that isn't the city.
  expect(closestPlace([["Male Bathroom", "Cra. 7 #45, Chapinero, Bogotá, Colombia"]], "Bogotá, Colombia")).toBe(-1);
  expect(closestPlace([], "Bogotá")).toBe(-1);
});

test("named: only a place called that, never one whose name mentions it", () => {
  const offered = [["Habitaciones económicas, Teusaquillo, Bogotá."], ["Bogota Bar"], ["波哥大", "Bogota"]];
  expect(closestPlace(offered, "Bogotá", { named: true })).toBe(2);
  expect(closestPlace([["Bogota Bar"]], "Bogotá", { named: true })).toBe(-1);
  expect(closestPlace([["Hostal en Bogotá"]], "Bogotá", { named: true })).toBe(-1);
  expect(closestPlace([["Hostal en Bogotá"]], "Bogotá")).toBe(0);
});

test("TikTok's caption splits into text to type and hashtags to pick, minus the space a pick adds", () => {
  expect(tikTokCaptionParts("Lorax wisdom, part 2\n\n#patriarchy #architects")).toEqual([
    { text: "Lorax wisdom, part 2\n\n" },
    { tag: "patriarchy", space: true },
    { tag: "architects", space: true },
  ]);
  expect(tikTokCaptionParts("In #Bogotá, inline #tag\nnext")).toEqual([
    { text: "In " },
    { tag: "Bogotá", space: false },
    { text: ", inline " },
    { tag: "tag", space: false },
    { text: "\nnext" },
  ]);
});

test("picks the hashtag itself, else the top suggestion starting with it, else none", () => {
  expect(pickHashtag(["#recipes", " #Recipe ", "#recipetok"], "recipe")).toBe("Recipe");
  expect(pickHashtag(["#recipetok", "#recipeideas"], "recipe")).toBe("recipetok");
  expect(pickHashtag(["#cooking", "#recipetok"], "recipe")).toBe("recipetok");
  expect(pickHashtag(["#cooking", "#food"], "recipe")).toBeNull();
  expect(pickHashtag([], "recipe")).toBeNull();
  expect(pickHashtag(["#bogotá"], "Bogotá")).toBe("bogotá");
  // Searches offered alongside hashtags are never picked.
  expect(pickHashtag(["#recipe ideas for dinner", "#recipetok"], "recipe")).toBe("recipetok");
  expect(pickHashtag(["#recipe ideas for dinner"], "recipe")).toBeNull();
});

test("only a # that starts a word is a hashtag", () => {
  expect(tikTokCaptionParts("C# and #1 in #")).toEqual([
    { text: "C# and " },
    { tag: "1", space: true },
    { text: "in #" },
  ]);
  expect(tikTokCaptionParts("plain")).toEqual([{ text: "plain" }]);
});
