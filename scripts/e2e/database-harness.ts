import { Client } from 'pg';

import { quotePostgresIdentifier, validateDatabaseEndpoints } from './database-safety.js';

const databaseNamePattern = /^spott_ci_[a-f0-9]{32}_test$/u;
const tokenHashPattern = /^[a-f0-9]{64}$/u;

export type DatabaseRegistryState = 'creating' | 'ready' | 'deleting' | 'quarantined';

export interface DatabaseRegistryRow {
  databaseName: string;
  tokenHash: string;
  state: DatabaseRegistryState;
}

export interface DatabaseMarker {
  databaseName: string;
  tokenHash: string;
}

export type DatabaseOwnershipCheckpoint =
  | 'after_registry_created'
  | 'after_database_created'
  | 'after_target_marked'
  | 'after_registry_ready'
  | 'after_cleanup_marked'
  | 'after_database_dropped';

export interface DatabaseOwnershipAdapter {
  withAdminLock<T>(databaseName: string, operation: () => Promise<T>): Promise<T>;
  readRegistry(databaseName: string): Promise<DatabaseRegistryRow | undefined>;
  targetExists(databaseName: string): Promise<boolean>;
  insertCreating(row: DatabaseRegistryRow): Promise<void>;
  createTarget(databaseName: string): Promise<void>;
  readMarker(databaseName: string): Promise<DatabaseMarker | undefined>;
  writeMarker(marker: DatabaseMarker): Promise<void>;
  markReady(databaseName: string, tokenHash: string): Promise<void>;
  markDeleting(databaseName: string, tokenHash: string): Promise<void>;
  quarantine(databaseName: string, tokenHash: string): Promise<void>;
  dropTarget(databaseName: string): Promise<void>;
  deleteRegistry(databaseName: string, tokenHash: string): Promise<void>;
}

export interface DatabaseOwnershipCoordinatorInput {
  adapter: DatabaseOwnershipAdapter;
  databaseName: string;
  tokenHash: string;
  checkpoint?: (checkpoint: DatabaseOwnershipCheckpoint) => void | Promise<void>;
}

export interface DatabaseProvisionResult {
  status: 'created' | 'resumed' | 'ready';
  databaseName: string;
}

export interface DatabaseCleanupResult {
  status: 'deleted' | 'resumed' | 'absent';
  databaseName: string;
}

export interface DatabaseOwnershipProof {
  databaseName: string;
}

function error(code: string, message: string): Error {
  return new Error(`${code}: ${message}`);
}

function isCreateRace(value: unknown): boolean {
  return value instanceof Error && value.message.includes('DATABASE_ALREADY_EXISTS');
}

export class DatabaseOwnershipCoordinator {
  private readonly adapter: DatabaseOwnershipAdapter;
  private readonly databaseName: string;
  private readonly tokenHash: string;
  private readonly checkpoint: (checkpoint: DatabaseOwnershipCheckpoint) => void | Promise<void>;

  constructor({
    adapter,
    databaseName,
    tokenHash,
    checkpoint = () => undefined,
  }: DatabaseOwnershipCoordinatorInput) {
    if (!databaseNamePattern.test(databaseName)) {
      throw error('DATABASE_NAME_NOT_OWNED', 'database name is outside the current run namespace');
    }
    if (!tokenHashPattern.test(tokenHash)) {
      throw error('DATABASE_TOKEN_HASH_INVALID', 'ownership token hash is malformed');
    }
    this.adapter = adapter;
    this.databaseName = databaseName;
    this.tokenHash = tokenHash;
    this.checkpoint = checkpoint;
  }

  async provision(): Promise<DatabaseProvisionResult> {
    return this.adapter.withAdminLock(this.databaseName, async () => {
      let registry = await this.adapter.readRegistry(this.databaseName);
      let exists = await this.adapter.targetExists(this.databaseName);
      let createdThisCall = false;

      if (!registry) {
        if (exists) {
          throw error('DATABASE_FOREIGN_TARGET', 'same-name target has no ownership registry row');
        }
        registry = {
          databaseName: this.databaseName,
          tokenHash: this.tokenHash,
          state: 'creating',
        };
        await this.adapter.insertCreating(registry);
        createdThisCall = true;
        await this.checkpoint('after_registry_created');
      } else {
        this.assertRegistryOwner(registry);
      }

      if (registry.state === 'quarantined') {
        throw error('DATABASE_QUARANTINED', 'database ownership state requires manual inspection');
      }
      if (registry.state === 'deleting') {
        throw error('DATABASE_HALF_CREATED', 'database is already being deleted');
      }

      if (registry.state === 'ready') {
        if (!exists) {
          await this.adapter.quarantine(this.databaseName, this.tokenHash);
          throw error('DATABASE_HALF_CREATED', 'ready registry exists without its target database');
        }
        const marker = await this.adapter.readMarker(this.databaseName);
        if (!marker) {
          await this.adapter.quarantine(this.databaseName, this.tokenHash);
          throw error('DATABASE_MARKER_MISSING', 'ready target has no ownership marker');
        }
        await this.assertMarkerOwner(marker);
        return { status: 'ready', databaseName: this.databaseName };
      }

      if (!exists) {
        try {
          await this.adapter.createTarget(this.databaseName);
        } catch (value) {
          if (isCreateRace(value)) {
            await this.adapter.quarantine(this.databaseName, this.tokenHash);
            throw error('DATABASE_CREATE_RACE', 'target appeared during CREATE DATABASE');
          }
          throw value;
        }
        exists = true;
        await this.checkpoint('after_database_created');
      }

      const marker = await this.adapter.readMarker(this.databaseName);
      if (marker) {
        await this.assertMarkerOwner(marker);
      } else {
        await this.adapter.writeMarker({
          databaseName: this.databaseName,
          tokenHash: this.tokenHash,
        });
        await this.checkpoint('after_target_marked');
      }
      await this.adapter.markReady(this.databaseName, this.tokenHash);
      await this.checkpoint('after_registry_ready');
      return {
        status: createdThisCall ? 'created' : 'resumed',
        databaseName: this.databaseName,
      };
    });
  }

  async verifyReady(): Promise<DatabaseOwnershipProof> {
    return this.adapter.withAdminLock(this.databaseName, async () => {
      const registry = await this.adapter.readRegistry(this.databaseName);
      const exists = await this.adapter.targetExists(this.databaseName);
      if (!registry || !exists) {
        throw error(
          'DATABASE_OWNERSHIP_PROOF_MISSING',
          'ready registry and target are both required',
        );
      }
      this.assertRegistryOwner(registry);
      if (registry.state !== 'ready') {
        throw error('DATABASE_OWNERSHIP_PROOF_NOT_READY', 'registry is not ready');
      }
      const marker = await this.adapter.readMarker(this.databaseName);
      if (!marker) {
        throw error('DATABASE_MARKER_MISSING', 'ready target has no ownership marker');
      }
      await this.assertMarkerOwner(marker);
      return { databaseName: this.databaseName };
    });
  }

  async cleanup(): Promise<DatabaseCleanupResult> {
    return this.adapter.withAdminLock(this.databaseName, async () => {
      const registry = await this.adapter.readRegistry(this.databaseName);
      const exists = await this.adapter.targetExists(this.databaseName);
      if (!registry) {
        if (exists) {
          throw error('DATABASE_FOREIGN_TARGET', 'target exists without an ownership registry row');
        }
        return { status: 'absent', databaseName: this.databaseName };
      }
      this.assertRegistryOwner(registry);
      if (registry.state === 'quarantined' || registry.state === 'creating') {
        throw error(
          'DATABASE_HALF_CREATED',
          'unsafe registry state cannot be cleaned automatically',
        );
      }
      if (registry.state === 'deleting') {
        if (exists) {
          const marker = await this.adapter.readMarker(this.databaseName);
          if (!marker) throw error('DATABASE_MARKER_MISSING', 'deleting target lost its marker');
          await this.assertMarkerOwner(marker);
          await this.adapter.dropTarget(this.databaseName);
          await this.checkpoint('after_database_dropped');
        }
        await this.adapter.deleteRegistry(this.databaseName, this.tokenHash);
        return { status: 'resumed', databaseName: this.databaseName };
      }
      if (!exists) {
        await this.adapter.quarantine(this.databaseName, this.tokenHash);
        throw error('DATABASE_HALF_CREATED', 'ready registry exists without target database');
      }
      const marker = await this.adapter.readMarker(this.databaseName);
      if (!marker) throw error('DATABASE_MARKER_MISSING', 'cleanup requires a target marker');
      await this.assertMarkerOwner(marker);
      await this.adapter.markDeleting(this.databaseName, this.tokenHash);
      await this.checkpoint('after_cleanup_marked');
      await this.adapter.dropTarget(this.databaseName);
      await this.checkpoint('after_database_dropped');
      await this.adapter.deleteRegistry(this.databaseName, this.tokenHash);
      return { status: 'deleted', databaseName: this.databaseName };
    });
  }

  private assertRegistryOwner(registry: DatabaseRegistryRow): void {
    if (registry.databaseName !== this.databaseName || registry.tokenHash !== this.tokenHash) {
      throw error('DATABASE_OWNERSHIP_MISMATCH', 'registry belongs to another run');
    }
  }

  private async assertMarkerOwner(marker: DatabaseMarker): Promise<void> {
    if (marker.databaseName !== this.databaseName || marker.tokenHash !== this.tokenHash) {
      await this.adapter.quarantine(this.databaseName, this.tokenHash);
      throw error('DATABASE_MARKER_MISMATCH', 'target marker belongs to another run');
    }
  }
}

export interface PostgresDatabaseOwnershipAdapterInput {
  adminURL: string;
  targetURL: string;
}

export class PostgresDatabaseOwnershipAdapter implements DatabaseOwnershipAdapter {
  private readonly adminURL: string;
  private readonly targetURL: string;
  private activeAdmin: Client | undefined;

  constructor({ adminURL, targetURL }: PostgresDatabaseOwnershipAdapterInput) {
    this.adminURL = adminURL;
    this.targetURL = targetURL;
  }

  async withAdminLock<T>(databaseName: string, operation: () => Promise<T>): Promise<T> {
    if (this.activeAdmin) {
      throw error('DATABASE_ADAPTER_REENTRANT', 'admin lock adapter is already active');
    }
    const admin = new Client({
      connectionString: this.adminURL,
      application_name: 'spott-ci-database-owner',
    });
    await admin.connect();
    let locked = false;
    try {
      await admin.query('CREATE SCHEMA IF NOT EXISTS spott_ci');
      await admin.query(`
        CREATE TABLE IF NOT EXISTS spott_ci.database_runs (
          database_name text PRIMARY KEY,
          token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
          state text NOT NULL CHECK (state IN ('creating', 'ready', 'deleting', 'quarantined')),
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )
      `);
      await admin.query('SELECT pg_advisory_lock(hashtextextended($1, 86720260717))', [
        databaseName,
      ]);
      locked = true;
      this.activeAdmin = admin;
      return await operation();
    } finally {
      this.activeAdmin = undefined;
      if (locked) {
        await admin.query('SELECT pg_advisory_unlock(hashtextextended($1, 86720260717))', [
          databaseName,
        ]);
      }
      await admin.end();
    }
  }

  async readRegistry(databaseName: string): Promise<DatabaseRegistryRow | undefined> {
    const result = await this.admin().query<{
      database_name: string;
      token_hash: string;
      state: string;
    }>(
      `SELECT database_name, token_hash, state
       FROM spott_ci.database_runs
       WHERE database_name = $1`,
      [databaseName],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (
      row.database_name !== databaseName ||
      !tokenHashPattern.test(row.token_hash) ||
      !new Set<DatabaseRegistryState>(['creating', 'ready', 'deleting', 'quarantined']).has(
        row.state as DatabaseRegistryState,
      )
    ) {
      throw error('DATABASE_REGISTRY_INVALID', 'registry row violates the ownership schema');
    }
    return {
      databaseName: row.database_name,
      tokenHash: row.token_hash,
      state: row.state as DatabaseRegistryState,
    };
  }

  async targetExists(databaseName: string): Promise<boolean> {
    const result = await this.admin().query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [databaseName],
    );
    return result.rows[0]?.exists === true;
  }

  async insertCreating(row: DatabaseRegistryRow): Promise<void> {
    if (row.state !== 'creating') {
      throw error('DATABASE_REGISTRY_INVALID', 'new registry row must start in creating state');
    }
    await this.admin().query(
      `INSERT INTO spott_ci.database_runs(database_name, token_hash, state)
       VALUES ($1, $2, 'creating')`,
      [row.databaseName, row.tokenHash],
    );
  }

  async createTarget(databaseName: string): Promise<void> {
    try {
      await this.admin().query(
        `CREATE DATABASE ${quotePostgresIdentifier(databaseName)} TEMPLATE template0`,
      );
    } catch (value) {
      if (
        value !== null &&
        typeof value === 'object' &&
        'code' in value &&
        value.code === '42P04'
      ) {
        throw error('DATABASE_ALREADY_EXISTS', 'target appeared while it was being created');
      }
      throw value;
    }
  }

  async readMarker(databaseName: string): Promise<DatabaseMarker | undefined> {
    return this.withTarget(async (target) => {
      const table = await target.query<{ exists: boolean }>(
        "SELECT to_regclass('spott_ci.database_marker') IS NOT NULL AS exists",
      );
      if (table.rows[0]?.exists !== true) return undefined;
      const result = await target.query<{
        database_name: string;
        token_hash: string;
      }>(
        `SELECT database_name, token_hash
         FROM spott_ci.database_marker
         WHERE singleton = true`,
      );
      if (result.rows.length === 0) return undefined;
      if (result.rows.length !== 1) {
        throw error('DATABASE_MARKER_INVALID', 'target contains multiple ownership markers');
      }
      const marker = result.rows[0];
      if (
        !marker ||
        marker.database_name !== databaseName ||
        !tokenHashPattern.test(marker.token_hash)
      ) {
        throw error('DATABASE_MARKER_INVALID', 'target marker violates the ownership schema');
      }
      return { databaseName: marker.database_name, tokenHash: marker.token_hash };
    });
  }

  async writeMarker(marker: DatabaseMarker): Promise<void> {
    await this.withTarget(async (target) => {
      await target.query('BEGIN');
      try {
        await target.query('CREATE SCHEMA IF NOT EXISTS spott_ci');
        await target.query(`
          CREATE TABLE IF NOT EXISTS spott_ci.database_marker (
            singleton boolean PRIMARY KEY CHECK (singleton = true),
            database_name text NOT NULL,
            token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
            created_at timestamptz NOT NULL DEFAULT clock_timestamp()
          )
        `);
        await target.query(
          `INSERT INTO spott_ci.database_marker(singleton, database_name, token_hash)
           VALUES (true, $1, $2)`,
          [marker.databaseName, marker.tokenHash],
        );
        await target.query('COMMIT');
      } catch (value) {
        try {
          await target.query('ROLLBACK');
        } catch {
          throw error(
            'DATABASE_MARKER_ROLLBACK_FAILED',
            'target marker transaction could not roll back',
          );
        }
        throw value;
      }
    });
  }

  async markReady(databaseName: string, tokenHash: string): Promise<void> {
    await this.transition(databaseName, tokenHash, 'creating', 'ready');
  }

  async markDeleting(databaseName: string, tokenHash: string): Promise<void> {
    await this.transition(databaseName, tokenHash, 'ready', 'deleting');
  }

  async quarantine(databaseName: string, tokenHash: string): Promise<void> {
    const result = await this.admin().query(
      `UPDATE spott_ci.database_runs
       SET state = 'quarantined', updated_at = clock_timestamp()
       WHERE database_name = $1 AND token_hash = $2`,
      [databaseName, tokenHash],
    );
    if (result.rowCount !== 1) {
      throw error('DATABASE_REGISTRY_TRANSITION_FAILED', 'registry could not be quarantined');
    }
  }

  async dropTarget(databaseName: string): Promise<void> {
    await this.admin().query(`DROP DATABASE ${quotePostgresIdentifier(databaseName)}`);
  }

  async deleteRegistry(databaseName: string, tokenHash: string): Promise<void> {
    const result = await this.admin().query(
      `DELETE FROM spott_ci.database_runs
       WHERE database_name = $1 AND token_hash = $2 AND state = 'deleting'`,
      [databaseName, tokenHash],
    );
    if (result.rowCount !== 1) {
      throw error('DATABASE_REGISTRY_TRANSITION_FAILED', 'deleting registry row was not removed');
    }
  }

  private admin(): Client {
    if (!this.activeAdmin) {
      throw error('DATABASE_ADMIN_LOCK_REQUIRED', 'adapter operation requires the admin lock');
    }
    return this.activeAdmin;
  }

  private async transition(
    databaseName: string,
    tokenHash: string,
    from: DatabaseRegistryState,
    to: DatabaseRegistryState,
  ): Promise<void> {
    const result = await this.admin().query(
      `UPDATE spott_ci.database_runs
       SET state = $4, updated_at = clock_timestamp()
       WHERE database_name = $1 AND token_hash = $2 AND state = $3`,
      [databaseName, tokenHash, from, to],
    );
    if (result.rowCount !== 1) {
      throw error('DATABASE_REGISTRY_TRANSITION_FAILED', `registry did not transition to ${to}`);
    }
  }

  private async withTarget<T>(operation: (target: Client) => Promise<T>): Promise<T> {
    const target = new Client({
      connectionString: this.targetURL,
      application_name: 'spott-ci-database-marker',
    });
    await target.connect();
    try {
      return await operation(target);
    } finally {
      await target.end();
    }
  }
}

export interface CreatePostgresDatabaseOwnershipCoordinatorInput {
  adminURL: string;
  targetURL: string;
  runId: string;
  runToken: string;
  checkpoint?: (checkpoint: DatabaseOwnershipCheckpoint) => void | Promise<void>;
}

export function createPostgresDatabaseOwnershipCoordinator({
  adminURL,
  targetURL,
  runId,
  runToken,
  checkpoint,
}: CreatePostgresDatabaseOwnershipCoordinatorInput): DatabaseOwnershipCoordinator {
  const validated = validateDatabaseEndpoints({ adminURL, targetURL, runId, runToken });
  return new DatabaseOwnershipCoordinator({
    adapter: new PostgresDatabaseOwnershipAdapter({ adminURL, targetURL }),
    databaseName: validated.databaseName,
    tokenHash: validated.tokenHash,
    ...(checkpoint ? { checkpoint } : {}),
  });
}
