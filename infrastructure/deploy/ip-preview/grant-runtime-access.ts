import { Client } from 'pg';

const databaseURL = process.env.DATABASE_URL;
const runtimeRole = process.env.APP_DATABASE_USER;
const runtimePassword = process.env.APP_DATABASE_PASSWORD;

if (!databaseURL) throw new Error('DATABASE_URL is required');
if (!runtimeRole || !/^[a-z_][a-z0-9_]{0,62}$/u.test(runtimeRole)) {
  throw new Error('APP_DATABASE_USER must be a safe PostgreSQL role name');
}
if (!runtimePassword || !/^[a-f0-9]{48}$/u.test(runtimePassword)) {
  throw new Error('APP_DATABASE_PASSWORD must be a generated 48-character hexadecimal secret');
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const role = identifier(runtimeRole);
const client = new Client({ connectionString: databaseURL });
await client.connect();

try {
  await client.query('BEGIN');
  const roleExists = await client.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
    [runtimeRole],
  );
  if (roleExists.rows[0]?.exists) {
    await client.query(
      `ALTER ROLE ${role} WITH LOGIN PASSWORD ${literal(runtimePassword)} ` +
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
    );
  } else {
    await client.query(
      `CREATE ROLE ${role} WITH LOGIN PASSWORD ${literal(runtimePassword)} ` +
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
    );
  }

  const database = await client.query<{ database_name: string }>(
    'SELECT current_database() AS database_name',
  );
  const databaseName = database.rows[0]?.database_name;
  if (!databaseName) throw new Error('Unable to resolve the current database');
  await client.query(`GRANT CONNECT ON DATABASE ${identifier(databaseName)} TO ${role}`);
  await client.query(`REVOKE TEMPORARY ON DATABASE ${identifier(databaseName)} FROM PUBLIC`);
  await client.query(`REVOKE TEMPORARY ON DATABASE ${identifier(databaseName)} FROM ${role}`);

  const schemas = await client.query<{ schema_name: string }>(
    `SELECT nspname AS schema_name
       FROM pg_namespace
      WHERE nspname <> 'information_schema'
        AND nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      ORDER BY nspname`,
  );
  for (const schema of schemas.rows) {
    await client.query(`REVOKE CREATE ON SCHEMA ${identifier(schema.schema_name)} FROM PUBLIC`);
    await client.query(`REVOKE CREATE ON SCHEMA ${identifier(schema.schema_name)} FROM ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA ${identifier(schema.schema_name)} TO ${role}`);
  }

  const tables = await client.query<{ schema_name: string; table_name: string }>(
    `SELECT namespace.nspname AS schema_name, relation.relname AS table_name
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE relation.relkind IN ('r', 'p')
        AND NOT relation.relispartition
        AND namespace.nspname <> 'information_schema'
        AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      ORDER BY namespace.nspname, relation.relname`,
  );

  for (const table of tables.rows) {
    const qualified = `${identifier(table.schema_name)}.${identifier(table.table_name)}`;
    const protectedTable =
      (table.schema_name === 'public' && table.table_name === 'schema_migrations') ||
      table.table_name.includes('quarantine') ||
      (table.schema_name === 'media' &&
        table.table_name === 'account_merge_transfer_authorizations');
    if (protectedTable) {
      await client.query(`REVOKE ALL PRIVILEGES ON TABLE ${qualified} FROM ${role}`);
      continue;
    }

    const postgisReference = table.schema_name === 'public' && table.table_name === 'spatial_ref_sys';
    if (postgisReference) {
      await client.query(`GRANT SELECT ON TABLE ${qualified} TO ${role}`);
      await client.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE ${qualified} FROM ${role}`);
      continue;
    }

    const appendOnlyAudit = table.schema_name === 'admin' && table.table_name === 'audit_logs';
    const evidence = table.schema_name === 'safety' && table.table_name === 'evidence_assets';
    if (appendOnlyAudit || evidence) {
      await client.query(`GRANT SELECT, INSERT ON TABLE ${qualified} TO ${role}`);
      await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON TABLE ${qualified} FROM ${role}`);
    } else {
      await client.query(`GRANT SELECT, INSERT, DELETE ON TABLE ${qualified} TO ${role}`);
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name = $2
            AND column_name NOT IN ('current_owner_id', 'created_owner_id')
          ORDER BY ordinal_position`,
        [table.schema_name, table.table_name],
      );
      if (columns.rows.length > 0) {
        const updateColumns = columns.rows.map((column) => identifier(column.column_name)).join(', ');
        await client.query(`GRANT UPDATE (${updateColumns}) ON TABLE ${qualified} TO ${role}`);
      }
      await client.query(`REVOKE TRUNCATE ON TABLE ${qualified} FROM ${role}`);
      if (table.schema_name === 'media' && table.table_name === 'assets') {
        await client.query(
          `REVOKE UPDATE (${identifier('current_owner_id')}, ${identifier('created_owner_id')}) ` +
            `ON TABLE ${qualified} FROM ${role}`,
        );
      }
      if (table.schema_name === 'media' && table.table_name === 'mutation_receipts') {
        await client.query(
          `REVOKE UPDATE (${identifier('current_owner_id')}, ${identifier('created_owner_id')}) ` +
            `ON TABLE ${qualified} FROM ${role}`,
        );
      }
    }
  }

  const sequences = await client.query<{ schema_name: string; sequence_name: string }>(
    `SELECT sequence_schema AS schema_name, sequence_name
       FROM information_schema.sequences
      WHERE sequence_schema <> 'information_schema'
        AND sequence_schema NOT LIKE 'pg\\_%' ESCAPE '\\'
      ORDER BY sequence_schema, sequence_name`,
  );
  for (const sequence of sequences.rows) {
    await client.query(
      `GRANT USAGE, SELECT ON SEQUENCE ${identifier(sequence.schema_name)}.` +
        `${identifier(sequence.sequence_name)} TO ${role}`,
    );
  }

  for (const [schema, table] of [
    ['safety', 'evidence_assets'],
    ['admin', 'audit_logs'],
    ['admin', 'exports'],
  ] as const) {
    const policyName = identifier(`spott_runtime_${table}`);
    const qualified = `${identifier(schema)}.${identifier(table)}`;
    await client.query(`DROP POLICY IF EXISTS ${policyName} ON ${qualified}`);
    await client.query(
      `CREATE POLICY ${policyName} ON ${qualified} FOR ALL TO ${role} ` +
        'USING (true) WITH CHECK (true)',
    );
  }

  await client.query(`GRANT EXECUTE ON FUNCTION sync.record_change(
    uuid, text, text, uuid, sync.change_operation, bigint, text[], jsonb, text
  ) TO ${role}`);
  // Account merging requires a separately authenticated execution boundary.
  // The ordinary API role must never be able to manufacture a preview job and
  // use it to transfer immutable media ownership.
  await client.query(`REVOKE ALL ON FUNCTION media.apply_account_merge(uuid) FROM ${role}`);
  await client.query('COMMIT');
  console.info('least-privileged runtime database role reconciled');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
