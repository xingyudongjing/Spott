import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error('DATABASE_URL is required');

const seedPath = fileURLToPath(new URL('../../../database/seeds/ip-preview.sql', import.meta.url));
const client = new Client({ connectionString: databaseURL });
await client.connect();
try {
  await client.query(await readFile(seedPath, 'utf8'));
  console.info('synthetic IP preview seed applied');
} finally {
  await client.end();
}
