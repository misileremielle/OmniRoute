import assert from "node:assert/strict";
import test from "node:test";

const { createConcurrencyLimit } = await import("../../src/shared/utils/concurrencyLimit.ts");

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("never runs more than the limit at once and starts waiters in order", async () => {
  const run = createConcurrencyLimit(2);
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const started: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const results = gates.map((gate, index) =>
    run(async () => {
      started.push(index);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate.promise;
      inFlight -= 1;
      return index;
    })
  );
  await Promise.resolve();
  assert.deepEqual(started, [0, 1]);
  gates[1].resolve();
  await results[1];
  await Promise.resolve();
  assert.deepEqual(started, [0, 1, 2]);
  gates[0].resolve();
  gates[2].resolve();
  gates[3].resolve();
  assert.deepEqual(await Promise.all(results), [0, 1, 2, 3]);
  assert.equal(peak, 2);
});

test("a failing or throwing task releases its slot and rejects only its own promise", async () => {
  const run = createConcurrencyLimit(1);
  const failed = run(async () => {
    throw new Error("upstream down");
  });
  const thrown = run(() => {
    throw new Error("sync throw");
  });
  const ok = run(async () => "next");
  await assert.rejects(failed, /upstream down/);
  await assert.rejects(thrown, /sync throw/);
  assert.equal(await ok, "next");
});
