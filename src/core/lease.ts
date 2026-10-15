import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { LEASE_SCHEMA_VERSION, leaseSchema, type Lease } from '../contracts/journal.js';
import { canonicalize, sha256Hex } from './canonical.js';
import { parseDocument } from './documents.js';

export type LeaseFailure = 'LEASE_HELD' | 'LEASE_STALE_REQUIRES_RECOVERY' | 'LEASE_CORRUPT' | 'LEASE_NOT_OWNED';

export type LeaseResult =
  | { acquired: true; path: string; lease: Lease }
  | { acquired: false; reasonCode: LeaseFailure; holder?: { owner: string; runId: string; expiresAt: string } };

/** Scope key binds target and component scope, e.g. "<environmentId>|function|<uniqueName>". */
export function leasePath(directory: string, scopeKey: string): string {
  return join(directory, `${sha256Hex(scopeKey)}.lease.json`);
}

async function readLease(path: string): Promise<Lease | undefined> {
  try {
    const parsed = parseDocument<Lease>(await readFile(path, 'utf8'), leaseSchema, LEASE_SCHEMA_VERSION, 'lease');
    return parsed.value;
  } catch {
    return undefined;
  }
}

/**
 * Single-writer lease using exclusive file creation. An expired lease is reported, never silently taken
 * over: recovery requires an explicit call naming the stale run. A local lease cannot exclude humans
 * using native editors, so it never replaces server-side concurrency checks.
 */
export async function acquireLease(
  directory: string,
  scopeKey: string,
  owner: string,
  runId: string,
  ttlSeconds: number,
  now: Date = new Date(),
): Promise<LeaseResult> {
  const path = leasePath(directory, scopeKey);
  const lease: Lease = {
    schemaVersion: LEASE_SCHEMA_VERSION,
    scopeKey,
    owner,
    runId,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(`${canonicalize(lease)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { acquired: true, path, lease };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  const existing = await readLease(path);
  if (existing === undefined) {
    return { acquired: false, reasonCode: 'LEASE_CORRUPT' };
  }
  const holder = { owner: existing.owner, runId: existing.runId, expiresAt: existing.expiresAt };
  if (Date.parse(existing.expiresAt) <= now.getTime()) {
    return { acquired: false, reasonCode: 'LEASE_STALE_REQUIRES_RECOVERY', holder };
  }
  return { acquired: false, reasonCode: 'LEASE_HELD', holder };
}

export async function releaseLease(directory: string, scopeKey: string, runId: string): Promise<{ released: boolean; reasonCode?: LeaseFailure }> {
  const path = leasePath(directory, scopeKey);
  const existing = await readLease(path);
  if (existing === undefined) {
    return { released: false, reasonCode: 'LEASE_CORRUPT' };
  }
  if (existing.runId !== runId) {
    return { released: false, reasonCode: 'LEASE_NOT_OWNED' };
  }
  await unlink(path);
  return { released: true };
}

/** Explicit stale-lease recovery: only removes an expired lease held by the named stale run. */
export async function recoverStaleLease(
  directory: string,
  scopeKey: string,
  staleRunId: string,
  now: Date = new Date(),
): Promise<{ recovered: boolean; reasonCode?: LeaseFailure }> {
  const path = leasePath(directory, scopeKey);
  const existing = await readLease(path);
  if (existing === undefined) {
    return { recovered: false, reasonCode: 'LEASE_CORRUPT' };
  }
  if (existing.runId !== staleRunId) {
    return { recovered: false, reasonCode: 'LEASE_NOT_OWNED' };
  }
  if (Date.parse(existing.expiresAt) > now.getTime()) {
    return { recovered: false, reasonCode: 'LEASE_HELD' };
  }
  await unlink(path);
  return { recovered: true };
}
