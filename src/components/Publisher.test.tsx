import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import Publisher from "./Publisher";

test("the owner's composer renders on the server", () => {
  const html = renderToString(
    <Publisher initialAccess="owner" initialHelper={{ online: true, platforms: ["instagram"] }} />,
  );
  expect(html).toContain("New post");
  expect(html).toContain("Laptop connected");
  expect(renderToString(<Publisher initialAccess="signin" />)).toContain("Continue with Flow ID");
});
