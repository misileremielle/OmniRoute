import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ruleIdOf, runOxlintJson } from "../../scripts/quality/oxlint-report.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

type Fixture = { code: string; filePath: string };

/**
 * Lint the fixtures with the repository's own .oxlintrc.json and return the
 * `no-restricted-imports` guidance per fixture, in order. Oxlint puts the configured message of a
 * restriction in `help`; `message` only names the import.
 *
 * Oxlint lints files, not text, and resolves the config's `files` globs from the config's
 * directory. So the fixtures are written at their repo-relative paths inside a scratch tree that
 * holds a copy of the config (and a node_modules link, for the config's JS plugin). The files
 * are passed explicitly: the scratch tree is never walked.
 */
function restrictedImportMessages(fixtures: Fixture[]): string[][] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-lint-boundaries-"));
  try {
    fs.copyFileSync(path.join(ROOT, ".oxlintrc.json"), path.join(dir, ".oxlintrc.json"));
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
    const files = fixtures.map((fixture, index) => {
      const parsed = path.parse(fixture.filePath);
      const file = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
      fs.mkdirSync(path.join(dir, parsed.dir), { recursive: true });
      fs.writeFileSync(path.join(dir, file), `${fixture.code}\n`);
      return file;
    });
    const { report } = runOxlintJson(files, { cwd: dir });
    assert.equal(report.number_of_files, files.length, "every fixture must be linted");
    return files.map((file) =>
      report.diagnostics
        .filter((d) => d.filename === file && ruleIdOf(d) === "no-restricted-imports")
        .map((d) => String(d.help))
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("G14 rejects localDb barrel imports outside src/lib/db", () => {
  const cases = [
    {
      code: 'import { getSettings } from "@/lib/localDb";\nvoid getSettings;',
      filePath: "src/lib/example.ts",
    },
    {
      code: 'import { getSettings } from "@/lib/localDb.ts";\nvoid getSettings;',
      filePath: "src/shared/example.ts",
    },
    {
      code: 'import { getSettings } from "../localDb";\nvoid getSettings;',
      filePath: "src/lib/feature/example.ts",
    },
    {
      code: 'import { getSettings } from "../../lib/localDb.ts";\nvoid getSettings;',
      filePath: "src/app/example.ts",
    },
  ];

  const results = restrictedImportMessages(cases);
  cases.forEach((fixture, index) => {
    assert.equal(results[index].length, 1, `expected ${fixture.code} to be rejected`);
    assert.match(results[index][0], /domain module from `@\/lib\/db\//);
  });
});

test("G14 rejects executor implementation imports from src/app", () => {
  const importPaths = ["@omniroute/open-sse/executors/default.ts", "open-sse/executors/default.ts"];
  const cases = [
    ...importPaths.map((importPath) => ({
      code: `import { DefaultExecutor } from "${importPath}";\nvoid DefaultExecutor;`,
      filePath: "src/app/api/example/route.ts",
    })),
    // Oxlint also applies the rule to dynamic imports, which ESLint's rule never saw.
    {
      code: 'export const load = () => import("@omniroute/open-sse/executors/default.ts");',
      filePath: "src/app/api/example/dynamic.ts",
    },
  ];

  const results = restrictedImportMessages(cases);
  cases.forEach((fixture, index) => {
    assert.equal(results[index].length, 1, `expected ${fixture.code} to be rejected from src/app`);
    assert.match(results[index][0], /handler or service boundary/);
  });
});

test("G14 allows imports through the intended boundaries", () => {
  const cases = [
    {
      code: 'import { getSettings } from "@/lib/localDb";\nvoid getSettings;',
      filePath: "src/lib/db/example.ts",
    },
    {
      code: 'import { DefaultExecutor } from "@omniroute/open-sse/executors/default.ts";\nvoid DefaultExecutor;',
      filePath: "src/sse/handlers/example.ts",
    },
    {
      code: 'import { handleChat } from "@omniroute/open-sse/handlers/chat";\nvoid handleChat;',
      filePath: "src/app/api/example/route.ts",
    },
  ];

  for (const messages of restrictedImportMessages(cases)) assert.deepEqual(messages, []);
});
