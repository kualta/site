export {};
// Plunk calls event forwarding "workflows". These contain only a webhook, never email steps.
const key = process.env.PLUNK_SECRET_KEY;
const secret = process.env.NEWSLETTER_WEBHOOK_SECRET;
const origin = process.env.NEWSLETTER_ORIGIN || "https://kualta.dev";
if (!key || !secret || secret.length < 32) throw new Error("Set PLUNK_SECRET_KEY and NEWSLETTER_WEBHOOK_SECRET.");
if (new URL(origin).protocol !== "https:") throw new Error("Plunk feedback needs a public HTTPS origin.");
const enable = process.argv.includes("--enable");
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`https://next-api.useplunk.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Plunk ${method} ${path}: ${response.status}`);
  return response.json();
}
if (enable) {
  const check = await fetch(`${origin}/api/newsletter/feedback`, {
    headers: { Authorization: `Bearer ${secret}` },
    redirect: "error",
  });
  if (!check.ok || (await check.json()).ok !== true)
    throw new Error("Deploy the authenticated feedback endpoint before enabling forwarding.");
}
const workflows: { id: string; name: string }[] = [];
for (let page = 1; ; page++) {
  const result = await api(`/workflows?page=${page}&pageSize=100`);
  workflows.push(...result.data);
  if (page >= result.totalPages) break;
}
for (const type of ["delivery", "bounce", "complaint"]) {
  const name = `kualta-site: email.${type}`;
  const matches = workflows.filter((w) => w.name === name);
  if (matches.length > 1) throw new Error(`Duplicate forwarding workflows for ${type}; reconcile before continuing.`);
  let workflow = matches[0];
  if (!workflow)
    workflow = await api("/workflows", "POST", {
      name,
      eventName: `email.${type}`,
      description: "Delivery feedback to the site-owned newsletter database.",
      enabled: false,
      allowReentry: true,
    });
  const detail = await api(`/workflows/${workflow.id}`);
  if (detail.steps.some((s: { type: string }) => !["TRIGGER", "WEBHOOK"].includes(s.type)))
    throw new Error(`Unexpected steps in ${name}; refusing to modify.`);
  if (detail.triggerConfig?.eventName !== `email.${type}`) throw new Error(`Unexpected trigger in ${name}`);
  const desiredEnabled = enable || detail.enabled;
  const webhooks = detail.steps.filter((s: { type: string }) => s.type === "WEBHOOK");
  if (webhooks.length > 1) throw new Error(`Multiple webhooks in ${name}; reconcile first.`);
  const config = {
    url: `${origin}/api/newsletter/feedback?type=${type}`,
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  };
  if (webhooks.length) await api(`/workflows/${workflow.id}/steps/${webhooks[0].id}`, "PATCH", { config });
  else
    await api(`/workflows/${workflow.id}/steps`, "POST", {
      type: "WEBHOOK",
      name: "Store delivery feedback",
      position: { x: 100, y: 300 },
      config,
      autoConnect: true,
    });
  await api(`/workflows/${workflow.id}`, "PATCH", { enabled: desiredEnabled, allowReentry: true });
  const saved = await api(`/workflows/${workflow.id}`);
  if (
    saved.enabled !== desiredEnabled ||
    !saved.allowReentry ||
    saved.steps.filter((s: { type: string }) => s.type === "WEBHOOK").length !== 1
  )
    throw new Error(`Unable to verify ${name}`);
  console.log(`${name}: ${desiredEnabled ? "enabled" : "prepared (disabled until deployment)"}`);
}
