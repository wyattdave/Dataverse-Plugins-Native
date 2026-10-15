import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { diag, sortDiagnostics, type Diagnostic } from '../contracts/common.js';
import { JOURNAL_SCHEMA_VERSION, journalSchema, type Journal, type JournalEntry } from '../contracts/journal.js';
import { canonicalize } from './canonical.js';
import { parseDocument, readTextFile } from './documents.js';
import { checkJournalIntegrity, computeEntriesSha256 } from './reconcile.js';

/**
 * Same-directory atomic replacement: write a private temp file, flush it durably, then rename.
 * Directory fsync is attempted where the platform supports it.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  try {
    const dirHandle = await open(dir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Directory fsync is unsupported on some platforms (for example Windows).
  }
}

export async function writeJournal(path: string, journal: Omit<Journal, 'entriesSha256'>): Promise<Journal> {
  const complete: Journal = { ...journal, entriesSha256: computeEntriesSha256(journal.entries) };
  await writeFileAtomic(path, `${canonicalize(complete)}\n`);
  return complete;
}

export interface JournalRead {
  journal: Journal | undefined;
  diagnostics: Diagnostic[];
}

/** Strict read with integrity verification; a corrupt journal is never used for continuation. */
export async function readJournal(path: string): Promise<JournalRead> {
  const loaded = await readTextFile(path, 'journal');
  if (loaded.text === undefined) {
    return { journal: undefined, diagnostics: loaded.diagnostics };
  }
  return parseJournalText(loaded.text);
}

/** Strict parse plus integrity verification of journal text from any source (file or UI). */
export function parseJournalText(text: string): JournalRead {
  const parsed = parseDocument<Journal>(text, journalSchema, JOURNAL_SCHEMA_VERSION, 'journal');
  if (parsed.value === undefined) {
    return {
      journal: undefined,
      diagnostics: sortDiagnostics([
        diag('JOURNAL_CORRUPT', 'error', 'integrity', 'Journal failed strict parsing or schema validation.'),
        ...parsed.diagnostics,
      ]),
    };
  }
  const integrity = checkJournalIntegrity(parsed.value);
  return integrity.length > 0 ? { journal: undefined, diagnostics: sortDiagnostics(integrity) } : { journal: parsed.value, diagnostics: [] };
}

/** Appends one entry durably; refuses to continue from a corrupt or invalid journal. */
export async function appendJournalEntry(path: string, entry: Omit<JournalEntry, 'sequence'>): Promise<Journal> {
  const current = await readJournal(path);
  if (current.journal === undefined) {
    throw new Error(`Refusing to append: ${current.diagnostics.map((d) => d.code).join(', ')}`);
  }
  const next: JournalEntry = { ...entry, sequence: current.journal.entries.length + 1 };
  const candidate = { ...current.journal, entries: [...current.journal.entries, next] };
  const integrity = checkJournalIntegrity({ ...candidate, entriesSha256: computeEntriesSha256(candidate.entries) });
  if (integrity.length > 0) {
    throw new Error(`Refusing to append: ${integrity.map((d) => d.code).join(', ')}`);
  }
  const { entriesSha256: _old, ...rest } = candidate;
  return writeJournal(path, rest);
}
