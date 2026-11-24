/*
 * Runs against the build output (npm run build first; the gate does): the package as a
 * consumer gets it, with nothing but dist/ and its one runtime dependency.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../scripts/collect.ts";

const entry = join(ROOT, "dist", "index.js");

interface Api {
  loadRules: () => unknown;
  carriers: (rules: unknown) => unknown[];
  findCarrier: (rules: unknown, name: string) => { id: string } | undefined;
  trackingUrl: (rules: unknown, id: string, number: string, locale?: string) => string | undefined;
  detectTrackingNumbers: (rules: unknown, text: string, hints?: object) => { carrier: string }[];
  mapStatus: (rules: unknown, carrier: string, raw: object) => { status: string } | null;
  resolveStatus: (
    rules: unknown,
    carrier: string,
    latest: object,
    history: object[],
  ) => { status: string };
  parseArrival: (rules: unknown, text: string, options: object) => { from: string } | null;
  parseEmail: (rules: unknown, mail: object) => { ruleId: string }[];
  ignoredStatus: (rules: unknown, carrier: string, raw: object) => string | null;
  findCarrierKey: (rules: unknown, carrier: string, name: string) => { value: string } | undefined;
  carrierKeys: (rules: unknown, carrier: string) => unknown[];
  pastDayOffset: (rules: unknown, word: string) => number | undefined;
}

async function api(): Promise<Api> {
  expect(existsSync(entry), "dist/index.js is missing: run npm run build").toBe(true);
  return (await import(entry)) as Api;
}

describe("built package", () => {
  it("answers one call per public function", async () => {
    const m = await api();
    const rules = m.loadRules();
    expect(m.loadRules()).toBe(rules);
    expect(m.carriers(rules).length).toBeGreaterThan(10);
    expect(m.findCarrier(rules, "dhl paket")?.id).toBe("dhl");
    expect(m.trackingUrl(rules, "dhl", "00340434123456789012", "de-DE")).toBe(
      "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=00340434123456789012",
    );
    expect(m.detectTrackingNumbers(rules, "1Z5R89390357567127")[0]?.carrier).toBe("ups");
    expect(m.mapStatus(rules, "gls", { code: "DELIVEREDPS" })?.status).toBe("at_pickup_point");
    expect(m.resolveStatus(rules, "dpd", { code: "?" }, [{ code: "DLO" }]).status).toBe(
      "out_for_delivery",
    );
    const now = new Date("2026-11-18T08:00:00Z");
    expect(
      m.parseArrival(rules, "Zustellung morgen", { now, timeZone: "Europe/Berlin" })?.from,
    ).toBe("2026-11-19T00:00:00+01:00");
    const mail = {
      from: "DHL Paket <noreply@dhl.de>",
      subject: "Ihr DHL Paket kommt heute",
      text: "Sendungsnummer: 00340434123456789012",
    };
    expect(m.parseEmail(rules, mail).length).toBeGreaterThan(0);
    expect(m.ignoredStatus(rules, "amazon", { text: "Storniert" })).toBe("order_cancelled");
    expect(m.findCarrierKey(rules, "evri", "website_key")?.value).not.toBe("");
    expect(m.carrierKeys(rules, "amazon").length).toBeGreaterThan(1);
    expect(m.pastDayOffset(rules, "gestern")).toBe(-1);
  });

  it("type-checks a strict consumer against the emitted declarations", () => {
    const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
    const run = spawnSync(process.execPath, [tsc, "-p", join(ROOT, "test", "consumer")], {
      encoding: "utf8",
    });
    expect(run.stdout + run.stderr).toBe("");
    expect(run.status).toBe(0);
    // A full tsc run takes well over the default 5 s on a CPU-capped CI container.
  }, 60_000);

  it("packs dist, data and schema, without sources or tests", () => {
    const npmCli =
      process.env["npm_execpath"] ??
      join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const args = [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"];
    const npm = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
    expect(npm.status, npm.stderr).toBe(0);
    const [pack] = JSON.parse(npm.stdout) as [{ files: { path: string }[] }];
    const paths = pack.files.map((file) => file.path);
    for (const needed of ["dist/index.js", "dist/index.d.ts", "dist/bundle.json", "package.json"]) {
      expect(paths).toContain(needed);
    }
    expect(paths.some((path) => path.startsWith("data/status/"))).toBe(true);
    expect(paths.some((path) => path.startsWith("schema/"))).toBe(true);
    expect(paths.some((path) => path.startsWith("src/") || path.startsWith("test/"))).toBe(false);
  });
});
