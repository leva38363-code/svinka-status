// Checks every component in config.json once and updates the data files the status page reads.
// Usage: node scripts/check.mjs <data-dir>
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const DAYS_KEPT = 90;
const INCIDENTS_KEPT = 50;
const TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 5_000;
const USER_AGENT = "svinka-status (+https://github.com/leva38363-code/svinka-status)";

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("usage: node scripts/check.mjs <data-dir>");
  process.exit(2);
}

const config = JSON.parse(await readFile("config.json", "utf8"));

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(path.join(dataDir, file), "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await writeFile(path.join(dataDir, file), JSON.stringify(value, null, 1) + "\n");
}

/** Day key (YYYY-MM-DD) in the configured time zone. */
function dayKey(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone || "UTC" }).format(date);
}

function isOk(component, status) {
  if (status === 0) return false;
  if (component.okStatus) return component.okStatus.includes(status);
  if (component.failStatus) return !component.failStatus.includes(status);
  return status >= 200 && status < 400;
}

async function probe(component) {
  const started = performance.now();
  try {
    const response = await fetch(component.url, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel();
    const ms = Math.round(performance.now() - started);
    return { status: response.status, ms, error: null };
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    return { status: 0, ms, error: error.name === "TimeoutError" ? "timeout" : "connection failed" };
  }
}

/** One retry after a short pause, so a single dropped packet is not an incident. */
async function check(component) {
  let result = await probe(component);
  if (!isOk(component, result.status)) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    result = await probe(component);
  }
  return { ...result, ok: isOk(component, result.status) };
}

await mkdir(dataDir, { recursive: true });
const now = new Date();
const today = dayKey(now);
const oldest = dayKey(new Date(now.getTime() - (DAYS_KEPT - 1) * 86_400_000));

const status = await readJson("status.json", { components: {} });
const days = await readJson("days.json", {});
const incidents = await readJson("incidents.json", []);

const results = await Promise.all(config.components.map(async (c) => [c, await check(c)]));

for (const [component, result] of results) {
  const previous = status.components[component.id];
  const changed = !previous || previous.ok !== result.ok;
  status.components[component.id] = {
    ok: result.ok,
    status: result.status,
    error: result.error,
    ms: result.ms,
    since: changed ? now.toISOString() : previous.since,
  };

  const perDay = (days[component.id] ||= {});
  const entry = (perDay[today] ||= { checks: 0, ok: 0, totalMs: 0 });
  entry.checks += 1;
  if (result.ok) {
    entry.ok += 1;
    entry.totalMs += result.ms;
  }
  for (const key of Object.keys(perDay)) {
    if (key < oldest) delete perDay[key];
  }

  const open = incidents.find((i) => i.component === component.id && !i.end);
  if (!result.ok && !open) {
    incidents.unshift({
      component: component.id,
      start: now.toISOString(),
      end: null,
      status: result.status,
      error: result.error,
    });
  } else if (result.ok && open) {
    open.end = now.toISOString();
  }
  console.log(`${component.id}: ${result.ok ? "up" : "DOWN"} status=${result.status} ${result.ms}ms${result.error ? " " + result.error : ""}`);
}

status.updated = now.toISOString();
incidents.splice(INCIDENTS_KEPT);

await writeJson("status.json", status);
await writeJson("days.json", days);
await writeJson("incidents.json", incidents);
// The page reads component names from the data branch, so it needs no second source.
await writeJson("config.json", {
  title: config.title,
  timezone: config.timezone,
  components: config.components.map(({ id, name, description }) => ({ id, name, description })),
});
