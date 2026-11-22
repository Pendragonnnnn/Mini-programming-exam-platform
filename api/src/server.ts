import { createApp } from './app';
import { config } from './config';
import { migrate } from './db/migrate';
import { startJobs } from './jobs';

async function main() {
  await migrate();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[aegis-api] listening on :${config.port} · runner=${config.runner} · ai=${config.aiProvider} · seb=${config.sebRequired ? 'required' : 'off'}`);
  });
  startJobs();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
