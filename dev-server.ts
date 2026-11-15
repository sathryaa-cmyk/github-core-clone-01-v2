// Local dev runner: start the forge on a fixed port for grading with the kit's sdk/run.ts.
// Not part of the trial entry point (main.ts is). Token comes from MAKEFUN_SHOP_TOKEN.

import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 18080);
const server = createApp();
server.listen(port, () => {
  process.stdout.write(`[dev] forge listening on http://127.0.0.1:${port}\n`);
});
