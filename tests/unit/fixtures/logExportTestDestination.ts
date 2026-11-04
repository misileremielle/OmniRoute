import fs from "node:fs";
import dns from "node:dns";
import v8 from "node:v8";
import path from "node:path";

// A child-visible fetch fixture for the existing BigQuery runner tests. No network.
export function installBigQueryFetchFixture(config: Record<string, unknown>) {
  if (config.network) {
    // Never resolve a real host: all fixture names map to loopback, including RED.
    dns.lookup = ((
      _hostname: string,
      options: { all?: boolean },
      callback: (...args: unknown[]) => void
    ) => {
      if (options?.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
      else callback(null, "127.0.0.1", 4);
    }) as unknown as typeof dns.lookup;
    return;
  }
  if (config.memoryOutput) {
    v8.setFlagsFromString("--trace-gc-nvp");
    const timer = setInterval(
      () =>
        fs.appendFileSync(
          String(config.memoryOutput),
          `${JSON.stringify({ ...process.memoryUsage(), maxRSS: process.resourceUsage().maxRSS })}\n`
        ),
      5
    );
    timer.unref();
    return;
  }
  const output = path.join(String(process.env.DATA_DIR), "bigquery-batches.jsonl");
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "stub-token", expires_in: 3600 });
    }
    if (href.endsWith("/insertAll")) {
      if (config.fixtureFailInsert)
        return Response.json({ error: { message: "backend error" } }, { status: 500 });
      if (config.fixtureInsertDelayMs)
        await new Promise((resolve) => setTimeout(resolve, Number(config.fixtureInsertDelayMs)));
      fs.appendFileSync(output, `${String(init?.body)}\n`);
    }
    return Response.json({});
  }) as typeof fetch;
}
