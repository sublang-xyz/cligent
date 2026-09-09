// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const PRICING_URL = 'https://models.dev/api.json';
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 16 * 1024 * 1024;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The file to delete when the next estimate should retrieve current prices. */
export function getDefaultPricingCachePath(): string {
  const root =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches')
      : process.platform === 'win32'
        ? process.env.LOCALAPPDATA && isAbsolute(process.env.LOCALAPPDATA)
          ? process.env.LOCALAPPDATA
          : join(homedir(), 'AppData', 'Local')
        : process.env.XDG_CACHE_HOME && isAbsolute(process.env.XDG_CACHE_HOME)
          ? process.env.XDG_CACHE_HOME
          : join(homedir(), '.cache');
  return join(root, 'cligent', 'models-dev-v1.json');
}

interface CacheEntry {
  version: 1;
  fetchedAt: number;
  catalog: Record<string, unknown>;
}

export interface PricingCatalog {
  catalog: Record<string, unknown>;
  fetchedAt: string;
  stale: boolean;
}

function validCatalog(value: unknown): value is Record<string, unknown> {
  return (
    isObject(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every(
      (provider) => isObject(provider) && isObject(provider.models),
    )
  );
}

async function readCache(path: string): Promise<CacheEntry | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_BYTES) return undefined;
    const text = await readFile(path, 'utf8');
    if (Buffer.byteLength(text) > MAX_BYTES) return undefined;
    const entry: unknown = JSON.parse(text);
    if (
      !isObject(entry) ||
      entry.version !== 1 ||
      typeof entry.fetchedAt !== 'number' ||
      !Number.isSafeInteger(entry.fetchedAt) ||
      entry.fetchedAt < 0 ||
      entry.fetchedAt > Date.now() ||
      !validCatalog(entry.catalog)
    ) {
      return undefined;
    }
    return entry as unknown as CacheEntry;
  } catch {
    return undefined;
  }
}

async function retrieve(timeoutMs: number): Promise<CacheEntry | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolveTimeout) => {
    timer = setTimeout(() => {
      controller.abort();
      resolveTimeout(undefined);
    }, timeoutMs);
  });
  const request = async (): Promise<CacheEntry | undefined> => {
    try {
      const response = await fetch(PRICING_URL, { signal: controller.signal });
      if (!response.ok || !response.body) return undefined;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_BYTES) {
            controller.abort();
            return undefined;
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      const catalog: unknown = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      );
      if (!validCatalog(catalog)) return undefined;
      return { version: 1, fetchedAt: Date.now(), catalog };
    } catch {
      return undefined;
    }
  };
  try {
    return await Promise.race([request(), timeout]);
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

async function saveCache(path: string, entry: CacheEntry): Promise<void> {
  let temporary: string | undefined;
  try {
    temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 });
    await rename(temporary, path);
  } catch {
    // A read-only cache location does not discard prices retrieved for this call.
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
  }
}

// Only outstanding retrievals are shared. Every later call reads the disk again,
// so deleting a cache file always invalidates previously retrieved prices.
const pending = new Map<string, Promise<CacheEntry | undefined>>();

export async function loadPricingCatalog(
  cachePath: string | undefined,
  timeoutMs: number,
): Promise<PricingCatalog | undefined> {
  let path: string;
  try {
    path = resolve(cachePath ?? getDefaultPricingCachePath());
  } catch {
    return undefined;
  }
  const cached = await readCache(path);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return {
      catalog: cached.catalog,
      fetchedAt: new Date(cached.fetchedAt).toISOString(),
      stale: false,
    };
  }
  // Different deadlines must not inherit another caller's longer wait.
  const key = JSON.stringify([path, timeoutMs]);
  let refresh = pending.get(key);
  if (!refresh) {
    refresh = (async () => {
      const entry = await retrieve(timeoutMs);
      if (entry) await saveCache(path, entry);
      return entry;
    })();
    pending.set(key, refresh);
  }
  let fetched: CacheEntry | undefined;
  try {
    fetched = await refresh;
  } finally {
    if (pending.get(key) === refresh) pending.delete(key);
  }
  const entry = fetched ?? cached;
  return entry
    ? {
        catalog: entry.catalog,
        fetchedAt: new Date(entry.fetchedAt).toISOString(),
        stale: !fetched,
      }
    : undefined;
}
