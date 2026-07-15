import process from 'node:process';
import { loadConfig } from './config.js';
import { WorkerDatabase } from './database.js';
import { jobNames, WorkerJobs, type JobName, type JobResult } from './jobs.js';

if (process.env.NODE_ENV !== 'production' && !process.env.DATABASE_URL) {
  try { process.loadEnvFile('.env'); } catch { /* Environment may be injected by the process manager. */ }
}

const config = loadConfig();
const database = new WorkerDatabase(config.DATABASE_URL);
const jobs = new WorkerJobs(database, config);
let stopping = false;

async function recordRun(name: JobName, work: () => Promise<JobResult>): Promise<JobResult> {
  const started = performance.now();
  const run = await database.query<{ id: string }>(
    `INSERT INTO admin.worker_runs(worker_id,job_name) VALUES ($1,$2) RETURNING id`,
    [config.WORKER_ID, name],
  );
  const id = run.rows[0]!.id;
  try {
    const result = await work();
    await database.query(
      `UPDATE admin.worker_runs SET finished_at = clock_timestamp(), status = 'succeeded',
         processed_count = $2, duration_ms = $3, metadata = $4 WHERE id = $1`,
      [id, result.processed, Math.round(performance.now() - started), result.metadata ?? {}],
    );
    return result;
  } catch (error) {
    await database.query(
      `UPDATE admin.worker_runs SET finished_at = clock_timestamp(), status = 'failed',
         duration_ms = $2, error_code = $3 WHERE id = $1`,
      [id, Math.round(performance.now() - started), error instanceof Error ? error.name : 'UNKNOWN'],
    );
    throw error;
  }
}

async function cycle(): Promise<number> {
  let total = 0;
  for (const name of jobNames) {
    if (stopping) break;
    const method = jobs[name].bind(jobs);
    const result = await recordRun(name, method);
    total += result.processed;
    if (result.processed > 0) console.info(JSON.stringify({ event: 'worker.job', job: name, ...result }));
  }
  return total;
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.info(JSON.stringify({ event: 'worker.shutdown', signal }));
  await database.close();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

if (process.argv.includes('--once')) {
  await cycle();
  await shutdown('once');
} else {
  console.info(JSON.stringify({ event: 'worker.started', workerId: config.WORKER_ID }));
  while (!stopping) {
    try {
      const processed = await cycle();
      if (processed === 0) await new Promise((resolve) => setTimeout(resolve, config.WORKER_POLL_MS));
    } catch (error) {
      console.error(JSON.stringify({ event: 'worker.cycle_failed', message: error instanceof Error ? error.message : 'unknown' }));
      await new Promise((resolve) => setTimeout(resolve, Math.max(config.WORKER_POLL_MS, 2_000)));
    }
  }
}
