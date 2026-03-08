#!/usr/bin/env node
import process from "node:process";

const baseUrl = (process.env.MISSION_CONTROL_URL || "http://127.0.0.1:4310").replace(/\/+$/, "");
const [typeArg, titleArg, descriptionArg, severityArg, sourceIdArg] = process.argv.slice(2);

const type = (typeArg || "incident").trim();
const allowed = new Set(["support_ticket", "incident", "ci_failure", "release_request"]);
if (!allowed.has(type)) {
  console.error(`Unsupported type: ${type}`);
  console.error("Allowed types: support_ticket, incident, ci_failure, release_request");
  process.exit(1);
}

const payload = {
  type,
  title: (titleArg || `Atria ${type}`).slice(0, 200),
  description: (descriptionArg || "No description provided").slice(0, 1200),
  severity: (severityArg || (type === "incident" ? "high" : "medium")).toLowerCase(),
  reporter: "ops@atria.so",
  source: "atria-cli",
  sourceId: (sourceIdArg || `cli:${Date.now()}`).slice(0, 120),
};

try {
  const response = await fetch(`${baseUrl}/api/integrations/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(3000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error(`Mission Control event failed (${response.status}): ${body.slice(0, 400)}`);
    process.exit(1);
  }

  console.log(`Mission Control event sent: ${type} -> ${baseUrl}/api/integrations/events`);
} catch (error) {
  console.error("Mission Control event post error:", error);
  process.exit(1);
}
