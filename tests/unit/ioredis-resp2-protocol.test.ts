import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// ioredis 6 speaks RESP3 by default, which changes the reply shapes the Redis-backed
// stores parse. Every client OmniRoute creates opts back into RESP2 (`protocol: 2`).
const ROOT = path.resolve(import.meta.dirname, "../..");
const CLIENT_SOURCES = [
  "src/lib/quota/redisQuotaStore.ts",
  "src/shared/utils/rateLimiter.ts",
  "open-sse/services/cache/redisVectorStore.ts",
  "src/lib/warmupScheduler/circuitBreakerFactory.ts",
];

for (const rel of CLIENT_SOURCES) {
  test(`${rel} creates its ioredis client with protocol: 2`, () => {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(source, /await import\("ioredis"\)/, "the file must still load ioredis");
    assert.match(source, /protocol: 2/, "the client must keep the RESP2 wire protocol");
  });
}

test("no other source file constructs an ioredis client", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) walk(full);
      } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
        const source = fs.readFileSync(full, "utf8");
        if (/import\("ioredis"\)|from "ioredis"/.test(source) && /\bnew \w+\(/.test(source)) {
          const rel = path.relative(ROOT, full).split(path.sep).join("/");
          if (!CLIENT_SOURCES.includes(rel)) offenders.push(rel);
        }
      }
    }
  };
  for (const dir of ["src", "open-sse", "bin"]) walk(path.join(ROOT, dir));
  assert.deepEqual(offenders, [], "a new ioredis client must be added to CLIENT_SOURCES");
});
