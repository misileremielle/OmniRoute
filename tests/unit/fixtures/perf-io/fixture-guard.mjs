const patched = globalThis[Symbol.for("omniroute.perf.ioPreload.patched")];
if (patched !== 1) {
  process.stderr.write(`expected 1 patching instance, got ${patched}\n`);
  process.exit(20);
}
