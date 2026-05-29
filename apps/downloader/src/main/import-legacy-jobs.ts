import fsp from 'node:fs/promises';
import path from 'node:path';
import { database } from '../infra/db/database.ts';

async function main(): Promise<void> {
  const jobsDir = path.resolve(process.cwd(), process.argv[2] || 'downloads/.jobs');
  const entries = await fsp.readdir(jobsDir, { withFileTypes: true });
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(jobsDir, entry.name);
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const record = JSON.parse(raw) as Record<string, unknown>;
      const id = String(record.id || '');
      if (id && database.getJobIncludingDeleted(id)) {
        skipped += 1;
        continue;
      }
      database.importHistoricalJob(record, `imported from ${path.relative(process.cwd(), filePath)}`);
      imported += 1;
    } catch (err) {
      failed += 1;
      console.error(`[legacy-import] failed ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(JSON.stringify({ jobsDir, imported, skipped, failed }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exitCode = 1;
});
