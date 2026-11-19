// Addendum A1 (cold /v1/models): pure parts of scripts/perf/catalog-cold-probe.ts.
// The live run needs a built dist/ and is exercised on the sandbox, not here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import {
  CALL_TIMEOUT_MS,
  MIN_VALID_SAMPLES,
  PING_TIMEOUT_MS,
  SAMPLES,
  SERVER_BUILD_TIMEOUT_MS,
  OWNER_MARKER,
  StartError,
  WAIT_MS,
  buildSample,
  claimDataDir,
  coldServerEnv,
  parseColdArgs,
  pingOnce,
  pingsDuring,
  sampleInvalidReason,
  startFailureReason,
  startPingLoop,
  summarizeSamples,
  timedGet,
  type CallResult,
  type Sample,
} from "../../scripts/perf/catalog-cold-probe.ts";
import { CATALOG_TTL_MS } from "../../scripts/perf/request-io-seed.ts";
import { redactSecrets } from "../../scripts/perf/request-io-probe.ts";

const ok = (over: Partial<CallResult> = {}): CallResult => ({
  status: 200,
  ms: 100,
  ttfbMs: 50,
  bytes: 10,
  catalogHeader: null,
  error: null,
  ...over,
});

const sample = (i: number, ms: number, maxPingMs: number | null, invalid: string | null = null) =>
  ({
    i,
    status: 200,
    ms,
    ttfbMs: ms,
    bytes: 1,
    catalogHeader: null,
    maxPingMs,
    pings: 1,
    pingTimedOut: false,
    invalidReason: invalid,
  }) satisfies Sample;

test("coldServerEnv: INITIAL_PASSWORD is empty (not deleted); preload, timeout and DATA_DIR set", () => {
  const env = coldServerEnv(
    { INITIAL_PASSWORD: "from-shell", OMNIROUTE_API_KEY: "leak", PATH: "/bin" },
    "/iso/m10",
    "/iso/counters",
    "file:///r/scripts/perf/request-io-preload.mjs"
  );
  // Present and empty, so bin/omniroute.mjs does not refill it from the arm's .env.
  assert.equal(Object.hasOwn(env, "INITIAL_PASSWORD"), true);
  assert.equal(env.INITIAL_PASSWORD, "");
  assert.equal(env.DATA_DIR, "/iso/m10");
  assert.equal(env.PERF_IO_COUNTER_DIR, "/iso/counters");
  assert.equal(env.NODE_OPTIONS, "--import file:///r/scripts/perf/request-io-preload.mjs");
  assert.equal(env.CATALOG_BUILD_TIMEOUT_MS, String(SERVER_BUILD_TIMEOUT_MS));
  assert.equal(env.OMNIROUTE_API_KEY, undefined);
  assert.equal(env.REQUIRE_API_KEY, "false");
});

test("startup keeps the seed's requireLogin:false only when INITIAL_PASSWORD is empty", async () => {
  // The server's startup step (instrumentation-node.ts) on a DB seeded like the catalog seed.
  const { updateSettings, getSettings } = await import("../../src/lib/db/settings.ts");
  const { ensurePersistentManagementPasswordHash } =
    await import("../../src/lib/auth/managementPassword.ts");
  const { isAuthRequired } = await import("../../src/shared/utils/apiAuth.ts");
  const { invalidateDbCache } = await import("../../src/lib/db/readCache.ts");
  const saved = process.env.INITIAL_PASSWORD;
  const bootWith = async (initialPassword: string) => {
    await updateSettings({ requireLogin: false, setupComplete: true, password: "" });
    process.env.INITIAL_PASSWORD = initialPassword;
    await ensurePersistentManagementPasswordHash({ settings: await getSettings(), source: "test" });
    invalidateDbCache("settings");
    return isAuthRequired();
  };
  try {
    // A non-empty INITIAL_PASSWORD (what buildChildEnv sets) turns login back on: the 401.
    assert.equal(await bootWith("lts-baseline-fake-initial-password"), true);
    // Empty (coldServerEnv): no password is stored and requireLogin stays false.
    assert.equal(await bootWith(""), false);
    assert.equal((await getSettings()).requireLogin, false);
  } finally {
    if (saved === undefined) delete process.env.INITIAL_PASSWORD;
    else process.env.INITIAL_PASSWORD = saved;
  }
});

test("constants match addendum A1", () => {
  assert.equal(SAMPLES, 5);
  assert.equal(MIN_VALID_SAMPLES, 4);
  // The wait passes TTL + the 30 s stale window, so every sample takes the cold path.
  assert.ok(WAIT_MS > CATALOG_TTL_MS + 30_000, `${WAIT_MS} must exceed TTL + 30 s`);
  assert.equal(WAIT_MS, 32_000);
  assert.ok(CALL_TIMEOUT_MS > SERVER_BUILD_TIMEOUT_MS);
  assert.equal(SERVER_BUILD_TIMEOUT_MS, 60_000);
  assert.equal(PING_TIMEOUT_MS, 10_000);
});

test("parseColdArgs: every flag required; label is a safe folder name", () => {
  const argv = ["--root", "/a", "--label", "probe-p1-a-m10", "--providers", "/p.txt"];
  const full = [
    ...argv,
    "--out",
    "/o.json",
    "--log",
    "/o.log",
    "--data-dir",
    "/h/perf-m10/s1/probe-p1-a-m10",
    "--owner-token",
    "tok",
  ];
  assert.equal(parseColdArgs(full).label, "probe-p1-a-m10");
  assert.equal(parseColdArgs(full).ownerToken, "tok");
  assert.throws(() => parseColdArgs(argv), /--out is required/);
  for (const dir of ["rel/dir", "/h/../etc", "/", "/h/x/"]) {
    const withDir = full.map((v) => (v === "/h/perf-m10/s1/probe-p1-a-m10" ? dir : v));
    assert.throws(() => parseColdArgs(withDir), /--data-dir must be/, dir);
  }
  assert.throws(() => parseColdArgs([...full, "--x", "1"]), /unknown flag/);
  assert.throws(() => parseColdArgs(["--root"]), /requires a value/);
  const bad = full.map((v) => (v === "probe-p1-a-m10" ? "../escape" : v));
  assert.throws(() => parseColdArgs(bad), /--label must match/);
  assert.equal(parseColdArgs(["--help"]).help, true);
});

test("sampleInvalidReason: no response, non-200 (401 included), timeout-path headers", () => {
  assert.equal(sampleInvalidReason(ok()), null);
  assert.equal(sampleInvalidReason(ok({ catalogHeader: "fresh" })), null);
  assert.equal(sampleInvalidReason(ok({ status: 401 })), "status-401");
  assert.equal(sampleInvalidReason(ok({ status: 503 })), "status-503");
  assert.equal(sampleInvalidReason(ok({ catalogHeader: "last-good" })), "header-last-good");
  assert.equal(sampleInvalidReason(ok({ catalogHeader: "build-timeout" })), "header-build-timeout");
  assert.equal(sampleInvalidReason(ok({ status: null, error: "timeout" })), "no-response(timeout)");
});

test("pingsDuring / buildSample: only pings that start inside the call count", () => {
  const pings = [
    { startMs: 0, durMs: 900, timedOut: false }, // before the call
    { startMs: 1000, durMs: 20, timedOut: false },
    { startMs: 1100, durMs: 1300, timedOut: false },
    { startMs: 1600, durMs: 10_000, timedOut: true }, // starts at the call's last ms
    { startMs: 1700, durMs: 5000, timedOut: false }, // after the call
  ];
  assert.deepEqual(pingsDuring(pings, 1000, 1600), { count: 3, maxMs: 10_000, timedOut: true });
  assert.deepEqual(pingsDuring(pings, 5000, 6000), { count: 0, maxMs: null, timedOut: false });
  const s = buildSample(2, ok({ ms: 500 }), 1000, pings);
  assert.equal(s.maxPingMs, 1300);
  assert.equal(s.pings, 2);
  assert.equal(s.invalidReason, null);
});

test("summarizeSamples: median of valid times, max of valid pings, 4 of 5 needed", () => {
  const five = [
    sample(1, 400, 30),
    sample(2, 100, 900),
    sample(3, 300, 20),
    sample(4, 200, null),
    sample(5, 9000, 5000, "status-503"),
  ];
  assert.deepEqual(summarizeSamples(five), {
    m10: 250,
    m11: 900,
    validSamples: 4,
    invalidReason: null,
  });
  const three = five.map((s, i) => (i === 0 ? { ...s, invalidReason: "header-last-good" } : s));
  assert.deepEqual(summarizeSamples(three), {
    m10: null,
    m11: null,
    validSamples: 3,
    invalidReason: "samples(3/5 valid)",
  });
});

test("startPingLoop: one in flight, 100 ms pacing, stop waits for the ping in flight", async () => {
  let clock = 0;
  const durations = [30, 250, 40, 40];
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const waits: number[] = [];
  let stopped: Promise<void> | null = null;
  let resolveStopped: () => void = () => undefined;
  const stoppedSet = new Promise<void>((resolve) => (resolveStopped = resolve));
  // `loop` is read inside the callback only from ping 4 on, long after it is assigned.
  const loop: ReturnType<typeof startPingLoop> = startPingLoop(
    async () => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      if (calls === 4) {
        // stop() arrives while ping 4 is in flight.
        stopped = loop.stop();
        resolveStopped();
      }
      clock += durations[calls - 1] ?? 40;
      inFlight--;
      return { timedOut: calls === 4 };
    },
    () => clock,
    async (ms) => {
      waits.push(ms);
      clock += ms;
    }
  );
  await stoppedSet;
  await stopped;
  assert.equal(maxInFlight, 1);
  // Starts: 0; 100 (30 ms ping, waits 70); 350 (the 250 ms ping ran late, no wait);
  // 450 (40 ms ping, waits 60). Ping 4 was in flight at stop() and is still recorded.
  assert.deepEqual(
    loop.pings.map((p) => p.startMs),
    [0, 100, 350, 450]
  );
  assert.deepEqual(waits, [70, 60]);
  assert.deepEqual(
    loop.pings.map((p) => p.durMs),
    [30, 250, 40, 40]
  );
  assert.equal(loop.pings[3]?.timedOut, true);
});

test("pingOnce: a deadline hit on headers or on a stalled body flags timedOut", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/ok/api/health/ping") {
      res.end("ok");
    } else if (req.url === "/body/api/health/ping") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("o"); // headers and one byte now, the rest never
    }
    // "/head/...": no response at all
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.deepEqual(await pingOnce(`${base}/ok`, 1000), { timedOut: false });
  assert.deepEqual(await pingOnce(`${base}/head`, 150), { timedOut: true });
  assert.deepEqual(await pingOnce(`${base}/body`, 150), { timedOut: true });
  // A fast failure (nothing listening) is not a timeout.
  assert.deepEqual(await pingOnce("http://127.0.0.1:1", 1000), { timedOut: false });
});

test("startFailureReason: fixed codes survive; redacted text would not", () => {
  // The bug this guards against: the old code recorded redactSecrets(message).
  assert.notEqual(redactSecrets("server-boot-deadline"), "server-boot-deadline");
  assert.equal(startFailureReason(new StartError("server-boot-deadline")), "server-boot-deadline");
  assert.equal(startFailureReason(new StartError("server-spawn", "ENOENT x")), "server-spawn");
  assert.equal(startFailureReason(new StartError("server-exit-1")), "server-exit-1");
  assert.equal(startFailureReason(new Error("anything")), "server-start");
});

test("claimDataDir: never touches a folder it did not create", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "perf-m10-claim-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const owner = { label: "probe-r1-m10", startedAt: "2026-11-18T00:00:00.000Z", token: "t1" };
  const none = () => [];

  // Fresh: created, with an owner marker.
  const fresh = path.join(parent, "perf-m10", "probe-r1-m10");
  assert.equal(claimDataDir(fresh, owner, none), null);
  const marker = JSON.parse(fs.readFileSync(path.join(fresh, OWNER_MARKER), "utf8"));
  assert.equal(marker.label, "probe-r1-m10");
  assert.equal(marker.pid, process.pid);
  assert.equal(marker.token, "t1");

  // Existing (another run's): refused, contents left alone.
  const other = path.join(parent, "perf-m10", "probe-r2-m10");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "keep.txt"), "theirs");
  assert.equal(claimDataDir(other, owner, none), "data-dir-exists");
  assert.equal(fs.readFileSync(path.join(other, "keep.txt"), "utf8"), "theirs");
  assert.equal(fs.existsSync(path.join(other, OWNER_MARKER)), false);

  // In use by a live process: refused before anything is created.
  const busy = path.join(parent, "perf-m10", "probe-r3-m10");
  assert.equal(
    claimDataDir(busy, owner, (dirs) => (dirs[0] === busy ? [12345] : [])),
    "data-dir-in-use"
  );
  assert.equal(fs.existsSync(busy), false);
});

test("timedGet: status, header, bytes, body on request; timeout is a no-response", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/slow") {
      setTimeout(() => res.end("late"), 2000).unref();
      return;
    }
    res.writeHead(200, { "x-omniroute-catalog": "fresh", "content-type": "application/json" });
    res.end(JSON.stringify({ data: [1, 2, 3] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const got = await timedGet(`${base}/v1/models`, 5000, true);
  assert.equal(got.status, 200);
  assert.equal(got.catalogHeader, "fresh");
  assert.equal(got.bytes, got.body?.length);
  assert.ok((got.ttfbMs as number) <= got.ms);
  assert.equal(JSON.parse((got.body as Buffer).toString()).data.length, 3);
  const noBody = await timedGet(`${base}/v1/models`, 5000);
  assert.equal(noBody.body, undefined);
  const slow = await timedGet(`${base}/slow`, 150);
  assert.equal(slow.status, null);
  assert.equal(slow.error, "timeout");
  assert.equal(sampleInvalidReason(slow), "no-response(timeout)");
});
