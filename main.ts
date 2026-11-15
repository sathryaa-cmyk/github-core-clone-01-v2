// The entry process: bind the forge, tell the env where it lives, wait for the env to finish.
// The env (MAKEFUN_ENV_URL) owns port 8080, so this process always binds an ephemeral port and
// never picks one itself. The whole trial is: register once, poll /done until true, exit 0.
// main.ts knows nothing about the forge's surface; app.ts owns that.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}
if (!/^https?:\/\//.test(ENV_URL)) {
  process.stderr.write(`[entry] MAKEFUN_ENV_URL must be an http(s) URL, got ${JSON.stringify(ENV_URL)}\n`);
  process.exit(1);
}

/** One register or done request may take this long before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Retry waits start here and double up to RETRY_MAX_MS. */
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed tries: exponential from RETRY_FIRST_MS, capped. */
function backoffMs(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST {"port": N} to the env until it accepts. 200 is the normal answer; 409 means another
 * entry already registered first, which is not this process's to fix. 400/405 are contract
 * errors and end the program; anything else is retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(backoffMs(attempt));
  }
}

/** GET /done until the env answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(backoffMs(attempt));
  }
}

/** Bind, register, wait for done, close, exit 0: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  // listen(0) must land on a real TCP port; 0 here would mean the bind never happened.
  if (!Number.isInteger(address.port) || address.port <= 0 || address.port > 65535) {
    throw new Error(`the server bound an invalid port: ${String(address.port)}`);
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
