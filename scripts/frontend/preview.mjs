import { startPreview } from './server.mjs';

const preview = await startPreview({ port: Number(process.env.FRONTEND_PREVIEW_PORT ?? 1338) });
console.log(`Isolated frontend preview: ${preview.url}`);
console.log('Synthetic data only. No database, credentials, GitHub, or email connections.');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await preview.close(); process.exit(0); });
