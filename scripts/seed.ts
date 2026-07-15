import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { Client } from 'pg';

if (existsSync('.env')) process.loadEnvFile('.env');
const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error('DATABASE_URL is required');

const client = new Client({ connectionString: databaseURL });
await client.connect();
try {
  await client.query(await readFile(join(process.cwd(), 'database', 'seeds', 'development.sql'), 'utf8'));
  console.info('development seed applied');
} finally {
  await client.end();
}
