import { accessSync, constants as fsConstants, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSecretEnvelope, parseSecretKeyring } from './secretEnvelope.mjs';
import {
  createLegacyMandateMigrationManifest,
  migrateLegacyMandates,
} from './mandateMigration.mjs';
import { createSafeLogger } from './safeLogger.mjs';

class MigrationCliError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'MigrationCliError';
    this.code = code;
  }
}

function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new MigrationCliError('MANDATE_MIGRATION_INVALID_ARGS');
  let db;
  let manifestPath;
  let quarantineInvalid = false;
  let rotate = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') db = argv[++index];
    else if (arg === '--manifest') manifestPath = argv[++index];
    else if (arg === '--quarantine-invalid') quarantineInvalid = true;
    else if (arg === '--rotate') rotate = true;
    else throw new MigrationCliError('MANDATE_MIGRATION_INVALID_ARGS');
  }
  if (typeof db !== 'string' || !db || db.startsWith('-')) {
    throw new MigrationCliError('MANDATE_MIGRATION_INVALID_ARGS');
  }
  if (quarantineInvalid && !manifestPath) {
    throw new MigrationCliError('MANDATE_MIGRATION_MANIFEST_REQUIRED');
  }
  return { db, manifestPath, quarantineInvalid, rotate };
}

function readManifest(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new MigrationCliError('MANDATE_MIGRATION_MANIFEST_INVALID');
  }
}

function validateDatabasePath(path) {
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new MigrationCliError('MANDATE_MIGRATION_DB_NOT_FOUND');
    }
    throw new MigrationCliError('MANDATE_MIGRATION_DB_UNREADABLE');
  }
  if (!stats.isFile()) throw new MigrationCliError('MANDATE_MIGRATION_DB_NOT_REGULAR');
  try {
    accessSync(path, fsConstants.R_OK);
  } catch {
    throw new MigrationCliError('MANDATE_MIGRATION_DB_UNREADABLE');
  }
}

function resultCode(result) {
  if (result?.rotated) return 'MANDATE_MIGRATION_ROTATED';
  if (result?.alreadyMigrated) return 'MANDATE_MIGRATION_ALREADY_COMPLETE';
  if (result?.notNeeded) return 'MANDATE_MIGRATION_NOT_NEEDED';
  if (result?.resumedCleanup) return 'MANDATE_MIGRATION_CLEANUP_RESUMED';
  return 'MANDATE_MIGRATION_COMPLETE';
}

function writeJsonLine(target, value) {
  const line = `${JSON.stringify(value)}\n`;
  try {
    if (typeof target === 'function') target(line);
    else target?.write?.(line);
  } catch {
    // CLI output is observational only; never turn a successful migration into a second failure.
  }
}

/** Import-safe offline wrapper around mandateMigration.mjs; no migration policy is duplicated. */
export async function runMigration(
  argv = process.argv.slice(2),
  env = process.env,
  {
    logger = createSafeLogger({ sink: () => {} }),
    migration = { createLegacyMandateMigrationManifest, migrateLegacyMandates },
    config,
    output = null,
  } = {},
) {
  let args;
  try {
    args = parseArgs(argv);
    validateDatabasePath(args.db);
    const rawKeyring = env?.RELAYER_SESSION_KEY_ENCRYPTION_KEYS;
    const sessionKeyCipher = createSecretEnvelope(parseSecretKeyring(rawKeyring));
    const manifest = args.manifestPath ? readManifest(args.manifestPath) : undefined;
    const migrationEnv = { ...env, RELAYER_OFFLINE_KEY_MIGRATION: '1' };
    const options = {
      env: migrationEnv,
      sessionKeyCipher,
      config,
      ...(args.quarantineInvalid ? { quarantineInvalid: true, manifest } : {}),
      ...(args.rotate ? { rotate: true } : {}),
    };
    const result = migration.migrateLegacyMandates(args.db, options);
    const resultOutput = {
      code: resultCode(result),
      migrated: Number.isSafeInteger(result?.migrated) ? result.migrated : 0,
      quarantined: Number.isSafeInteger(result?.quarantined) ? result.quarantined : 0,
    };
    logger.info(resultOutput.code, resultOutput);
    writeJsonLine(output?.stdout, resultOutput);
    return resultOutput;
  } catch (error) {
    const code = error instanceof MigrationCliError ? error.code : 'MANDATE_MIGRATION_FAILED';
    logger.error(code, {});
    writeJsonLine(output?.stderr, { code });
    const failure = new MigrationCliError(code);
    failure.cause = undefined;
    throw failure;
  }
}

export const main = runMigration;
export { MigrationCliError, parseArgs };

const invokedDirectly = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  void runMigration(undefined, undefined, {
    output: { stdout: process.stdout, stderr: process.stderr },
  }).catch(() => { process.exitCode = 1; });
}
