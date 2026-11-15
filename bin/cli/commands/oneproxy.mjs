import { apiFetch } from "../api.mjs";
import { emit } from "../output.mjs";
import { t } from "../i18n.mjs";

function fmtTs(v) {
  if (!v) return "-";
  return new Date(typeof v === "number" ? v * 1000 : v).toLocaleString();
}

// The legacy /api/settings/oneproxy routes are 308 redirects to the free-proxy API,
// and apiFetch refuses redirects when it carries the local CLI token, so these
// commands call /api/settings/free-proxies directly.
async function getJson(path, init) {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    process.stderr.write(`Error: ${res.status}\n`);
    process.exit(1);
  }
  return res.json();
}

const proxySchema = [
  { key: "host", header: "Host", width: 35 },
  { key: "type", header: "Type", width: 8 },
  { key: "region", header: "Region" },
  { key: "latencyMs", header: "Latency", formatter: (v) => (v ? `${v}ms` : "-") },
  {
    key: "successRate",
    header: "Success%",
    formatter: (v) => (v ? `${(v * 100).toFixed(0)}%` : "-"),
  },
  { key: "lastUsed", header: "Last Used", formatter: fmtTs },
  { key: "state", header: "State" },
];

export function registerOneProxy(program) {
  const op = program.command("oneproxy").description(t("oneproxy.description"));

  op.command("status").action(async (opts, cmd) => {
    emit(await getJson("/api/settings/free-proxies/stats"), cmd.optsWithGlobals());
  });

  op.command("stats").action(async (opts, cmd) => {
    emit(await getJson("/api/settings/free-proxies/stats"), cmd.optsWithGlobals());
  });

  op.command("fetch")
    .description(t("oneproxy.fetch.description"))
    .option("--count <n>", t("oneproxy.fetch.count"), (v) => Number.parseInt(v, 10), 1)
    .option("--type <t>", t("oneproxy.fetch.type"), "http")
    .action(async (opts, cmd) => {
      const params = new URLSearchParams();
      if (opts.count) params.set("limit", String(opts.count));
      if (opts.type) params.set("protocol", opts.type);
      const body = await getJson(`/api/settings/free-proxies?${params}`);
      const data = body.data ?? body;
      emit(data.proxies ?? data, cmd.optsWithGlobals(), proxySchema);
    });

  op.command("rotate")
    .description(t("oneproxy.rotate.description"))
    .action(async (opts, cmd) => {
      const data = await getJson("/api/settings/free-proxies/sync", { method: "POST", body: {} });
      emit(data, cmd.optsWithGlobals());
    });

  const config = op.command("config").description(t("oneproxy.config.description"));

  config.command("show").action(async (opts, cmd) => {
    const res = await apiFetch("/api/settings/oneproxy");
    if (!res.ok) {
      process.stderr.write(`Error: ${res.status}\n`);
      process.exit(1);
    }
    emit(await res.json(), cmd.optsWithGlobals());
  });

  config
    .command("set")
    .option("--enabled <b>", t("oneproxy.config.enabled"), (v) => v === "true")
    .option("--pool-size <n>", t("oneproxy.config.poolSize"), parseInt)
    .option("--provider-source <url>", t("oneproxy.config.providerSource"))
    .option("--rotation-policy <p>", t("oneproxy.config.rotationPolicy"))
    .action(async (opts, cmd) => {
      const body = {};
      for (const k of ["enabled", "poolSize", "providerSource", "rotationPolicy"]) {
        if (opts[k] !== undefined) body[k] = opts[k];
      }
      const res = await apiFetch("/api/settings/oneproxy", { method: "PUT", body });
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      emit(await res.json(), cmd.optsWithGlobals());
    });

  op.command("pool")
    .description(t("oneproxy.pool.description"))
    .action(async (opts, cmd) => {
      const res = await apiFetch("/api/settings/oneproxy?include=pool");
      if (!res.ok) {
        process.stderr.write(`Error: ${res.status}\n`);
        process.exit(1);
      }
      const data = await res.json();
      emit(data.pool ?? data, cmd.optsWithGlobals(), proxySchema);
    });
}
