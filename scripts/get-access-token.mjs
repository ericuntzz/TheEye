#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT_DIR = process.cwd();
const ENV_FILENAMES = [".env.local", ".env"];

function parseEnvFile(filePath) {
  const parsed = {};
  const source = readFileSync(filePath, "utf8");

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in parsed)) {
      parsed[key] = value;
    }
  }

  return parsed;
}

function loadLocalEnv() {
  for (const filename of ENV_FILENAMES) {
    const filePath = path.join(ROOT_DIR, filename);
    if (!existsSync(filePath)) continue;

    const parsed = parseEnvFile(filePath);
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function requireEnv(key, helpText) {
  const value = process.env[key];
  if (value) return value;

  console.error(`[get-access-token] Missing ${key}. ${helpText}`);
  process.exit(1);
}

loadLocalEnv();

const supabaseUrl = requireEnv(
  "NEXT_PUBLIC_SUPABASE_URL",
  "Set it in your environment or .env.local before requesting a token.",
);
const supabaseAnonKey = requireEnv(
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "Set it in your environment or .env.local before requesting a token.",
);
const email = requireEnv(
  "GATE_TEST_EMAIL",
  "Set a dedicated gate/test account email in your environment or .env.local.",
);
const password = requireEnv(
  "GATE_TEST_PASSWORD",
  "Set a dedicated gate/test account password in your environment or .env.local.",
);

const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    apikey: supabaseAnonKey,
  },
  body: JSON.stringify({
    email,
    password,
  }),
});

if (!response.ok) {
  const body = await response.text().catch(() => "");
  console.error(
    `[get-access-token] Supabase auth failed with ${response.status} ${response.statusText}`,
  );
  if (body) {
    console.error(body.slice(0, 500));
  }
  process.exit(1);
}

const payload = await response.json();
if (!payload?.access_token || typeof payload.access_token !== "string") {
  console.error("[get-access-token] Supabase response did not include an access token.");
  process.exit(1);
}

process.stdout.write(payload.access_token);
