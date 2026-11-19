import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Descriptor, validateDescriptor } from './protocol';

export const runtimeDirectory = path.join(homedir(), '.vscode-pi-bridge', 'runtime');

/** Checks discovery directories before sharing credentials; an existing symlink or broad permissions is not repaired silently. */
export async function secureDirectory(create: boolean) {
  for (const directory of [path.dirname(runtimeDirectory), runtimeDirectory]) {
    if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('Bridge runtime directories must be owner-only real directories (0700).');
  }
}
export async function readDescriptor(filename: string): Promise<Descriptor> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 32768) throw new Error('Unsafe runtime descriptor');
    const descriptor: unknown = JSON.parse(await file.readFile('utf8'));
    validateDescriptor(descriptor);
    if (path.basename(filename) !== `${descriptor.runtimeId}.json`) throw new Error('Descriptor identity mismatch');
    return descriptor;
  } finally { await file.close(); }
}
export async function discover(): Promise<Descriptor[]> {
  try { await secureDirectory(false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const candidates: Descriptor[] = [];
  for (const filename of await readdir(runtimeDirectory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(filename)) continue;
    try {
      const descriptor = await readDescriptor(path.join(runtimeDirectory, filename));
      process.kill(descriptor.pid, 0);
      candidates.push(descriptor);
    } catch { /* Stale or unsafe descriptors are never pairing candidates. */ }
  }
  return candidates;
}
