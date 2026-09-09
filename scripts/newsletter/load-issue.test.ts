import { expect, test } from "bun:test";
import { renderIssue } from "../../src/lib/newsletter/render";
import { loadIssue } from "./load-issue";

test("full post survives email rendering with absolute images and light styling", async () => {
  const issue = await loadIssue("src/content/posts/memetic-culture.mdx");
  const { html } = await renderIssue(
    issue,
    { NEWSLETTER_TOKEN_SECRET: "t".repeat(64) },
    crypto.randomUUID(),
    crypto.randomUUID(),
  );
  expect(issue.markdown).toContain("Stand proud, together with the rest of us.");
  expect(html).toContain("Stand proud, together with the rest of us.");
  expect(html).toContain("https://kualta.dev/images/posts/memetic-culture/ac92f923c3df.png");
  expect(html).toContain("Takeaways</h3>");
  expect(html).toContain("<blockquote");
  expect(html).toContain('content="light"');
  expect(html).toContain("Read on the website");
  expect(html).not.toContain("→");
});
