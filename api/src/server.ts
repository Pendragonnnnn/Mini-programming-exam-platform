import { createApp } from './app';
import { config } from './config';
import { ensureDemo } from './services/demo';
import { migrate } from './db/migrate';
import { startJobs } from './jobs';

async function main() {
  await migrate();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[aegis-api] listening on :${config.port} · runner=${config.runner} · ai=${config.aiProvider} · seb=${config.sebRequired ? 'required' : 'off'}${config.demoMode ? ' · DEMO MODE' : ''}`);
    if (config.demoMode) {
      console.warn('[aegis-api] DEMO MODE is ON (DEMO_MODE=true, NODE_ENV=development): demo_teacher / DemoTeacher123 and demo_student / DemoStudent123 can sign in. Never use this in production.');
      ensureDemo().catch((e) => console.error('[demo] setup failed:', e.message));
    } else if (config.demoRequested) {
      console.warn('[aegis-api] DEMO_MODE=true is IGNORED because NODE_ENV is not "development". Demo accounts stay disabled.');
    }
  });
  startJobs();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
