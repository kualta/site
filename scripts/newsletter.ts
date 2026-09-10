import { readFile, writeFile } from "node:fs/promises";
import { loadIssue } from "./newsletter/load-issue";

const [command, argument, ...flags] = process.argv.slice(2);
const base = process.env.NEWSLETTER_ORIGIN || "https://kualta.dev";
const baseUrl = new URL(base);
if (baseUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(baseUrl.hostname))
  throw new Error("Use HTTPS for remote newsletter administration.");
const secret = process.env.NEWSLETTER_ADMIN_SECRET;
if (!secret) throw new Error("Set NEWSLETTER_ADMIN_SECRET (local development uses .dev.vars).");
async function api(body?: unknown, query = "") {
  const response = await fetch(new URL(`/api/newsletter/admin${query}`, base), {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180000),
    redirect: "error",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || `Request failed (${response.status})`);
  return result;
}
function option(name: string): string | undefined {
  const index = flags.indexOf(name);
  return index >= 0 ? flags[index + 1] : undefined;
}
function requireArgument(): string {
  if (!argument) throw new Error("Missing file, issue id, or email.");
  return argument;
}
switch (command) {
  case "prepare": {
    const issue = await loadIssue(requireArgument());
    console.log(JSON.stringify(await api({ action: "prepare", issue }), null, 2));
    console.log(
      `Audience prepared at ${base}. No email sent. Send with: newsletter send ${issue.id} --confirm ${issue.id}`,
    );
    break;
  }
  case "send": {
    const id = requireArgument();
    if (option("--confirm") !== id)
      throw new Error(`Sending requires --confirm ${id}. Review newsletter status ${id} first.`);
    for (;;) {
      const before = await api(undefined, `?issue=${encodeURIComponent(id)}`);
      if (["failed", "unknown", "sending"].some((state) => before.states[state] > 0))
        throw new Error("This issue has failed, uncertain, or in-flight deliveries. Reconcile them before continuing.");
      if (!before.states.pending) {
        console.log(JSON.stringify(before, null, 2));
        break;
      }
      console.log(JSON.stringify(await api({ action: "send", id }), null, 2));
    }
    break;
  }
  case "test": {
    const issue = await loadIssue(requireArgument());
    const to = option("--to");
    if (!to || !flags.includes("--send")) throw new Error("Use --to your-email --send to send one preview.");
    console.log(JSON.stringify(await api({ action: "test", issue, to }), null, 2));
    break;
  }
  case "resolve": {
    const id = requireArgument();
    if (option("--confirm") !== id)
      throw new Error("Resolution requires --confirm <delivery-id> after inspecting Plunk delivery activity.");
    const providerId = option("--provider-id");
    if (!providerId && !flags.includes("--skip"))
      throw new Error("Use --provider-id <verified-id> or --skip. This never resends.");
    console.log(
      JSON.stringify(await api({ action: "resolve", id, state: providerId ? "sent" : "skipped", providerId }), null, 2),
    );
    break;
  }
  case "status":
    console.log(JSON.stringify(await api(undefined, `?issue=${encodeURIComponent(requireArgument())}`), null, 2));
    break;
  case "subscriber":
    console.log(JSON.stringify(await api(undefined, `?subscriber=${encodeURIComponent(requireArgument())}`), null, 2));
    break;
  case "export": {
    const rows: unknown[] = [];
    let after = "";
    do {
      const page = await api(undefined, `?after=${encodeURIComponent(after)}`);
      rows.push(...page.subscribers);
      after = page.next;
    } while (after);
    await writeFile(requireArgument(), JSON.stringify(rows, null, 2), { mode: 0o600, flag: "wx" });
    console.log(`Exported ${rows.length} subscribers, including opt-outs and suppressions.`);
    break;
  }
  case "import": {
    const rows = JSON.parse(await readFile(requireArgument(), "utf8"));
    if (!Array.isArray(rows)) throw new Error("Expected a JSON array of subscribers.");
    console.log(`${rows.length} rows; destination ${base}.`);
    if (!flags.includes("--commit")) {
      console.log("Dry run. Add --commit to import. No email will be sent.");
      break;
    }
    for (let i = 0; i < rows.length; i += 100) await api({ action: "import", subscribers: rows.slice(i, i + 100) });
    console.log("Import complete. Existing opt-outs and suppressions preserved.");
    break;
  }
  default:
    throw new Error(
      "Commands: prepare <issue.json>, send <id> --confirm <id>, test <issue.json> --to <email> --send, status <id>, subscriber <email>, export <new-file.json>, import <file.json> [--commit]",
    );
}
