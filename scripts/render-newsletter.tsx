import { mkdir, writeFile } from "node:fs/promises";
import { render, toPlainText } from "react-email";
import Newsletter from "../src/emails/Newsletter";
import { loadIssue } from "./newsletter/load-issue";

const issue = await loadIssue(process.argv[2] || "src/content/posts/memetic-culture.mdx");
const html = await render(<Newsletter {...issue} />);
await mkdir("build/newsletter", { recursive: true });
await writeFile("build/newsletter/newsletter.html", html);
await writeFile("build/newsletter/newsletter.txt", toPlainText(html));
console.log("Rendered build/newsletter/newsletter.html and newsletter.txt");
