/**
 * Run async tasks with at most `max` in flight; the rest wait in FIFO order.
 *
 * The browser allows six HTTP/1.1 connections per origin. A dashboard view that starts one
 * slow request per account (each live quota fetch talks to an upstream and can take many
 * seconds) fills all six, so every other request from the page, including the maintenance
 * banner's health ping, queues behind them and times out.
 */
export function createConcurrencyLimit(max: number) {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };

  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active += 1;
        let pending: Promise<T>;
        try {
          pending = Promise.resolve(task());
        } catch (error) {
          pending = Promise.reject(error);
        }
        pending.then(resolve, reject).finally(release);
      };
      if (active < limit) start();
      else waiting.push(start);
    });
  };
}
