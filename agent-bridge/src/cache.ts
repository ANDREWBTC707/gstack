/**
 * Content-addressed result cache for agent-bridge.
 *
 * Cache key: `{skill}-{repo}-{commitSha}`
 * Storage: `~/.gstack/cache/{key}.json`
 *
 * Same skill + same commit = cached result. Saves tokens and time when
 * multiple agents query the same analysis (e.g., Max reviews a PR, then
 * the QA agent checks it too — both hit /review on the same commit).
 *
 * Built by Max Harper (AI agent, OpenClaw).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { CacheEntry, InvokeResult } from './types';

const CACHE_DIR = join(homedir(), '.gstack', 'cache');
const DEFAULT_TTL = 3600; // 1 hour
const MAX_CACHE_ENTRIES = 500;

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function cacheKey(skill: string, repo: string, commitSha: string): string {
  // Normalize repo to basename to avoid path separator issues
  const repoName = repo.replace(/[/\\]/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  return `${skill}-${repoName}-${commitSha.slice(0, 12)}`;
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

export function getCached(skill: string, repo: string, commitSha: string): InvokeResult | null {
  ensureCacheDir();
  const key = cacheKey(skill, repo, commitSha);
  const path = cachePath(key);

  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, 'utf-8');
    const entry: CacheEntry = JSON.parse(raw);

    // Check TTL
    const age = (Date.now() - new Date(entry.cachedAt).getTime()) / 1000;
    if (age > entry.ttl) {
      unlinkSync(path);
      return null;
    }

    return entry.result;
  } catch {
    // Corrupted cache entry — remove it
    try { unlinkSync(path); } catch { /* ignore */ }
    return null;
  }
}

export function setCache(
  skill: string,
  repo: string,
  commitSha: string,
  result: InvokeResult,
  ttl: number = DEFAULT_TTL
): void {
  ensureCacheDir();
  evictIfFull();

  const key = cacheKey(skill, repo, commitSha);
  const entry: CacheEntry = {
    key,
    result,
    cachedAt: new Date().toISOString(),
    ttl,
  };

  writeFileSync(cachePath(key), JSON.stringify(entry, null, 2));
}

/** Evict oldest entries if cache exceeds MAX_CACHE_ENTRIES */
function evictIfFull(): void {
  try {
    const files = readdirSync(CACHE_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        name: f,
        path: join(CACHE_DIR, f),
        mtime: statSync(join(CACHE_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => a.mtime - b.mtime); // oldest first

    if (files.length >= MAX_CACHE_ENTRIES) {
      // Remove oldest 20%
      const toRemove = Math.ceil(files.length * 0.2);
      for (let i = 0; i < toRemove; i++) {
        try { unlinkSync(files[i].path); } catch { /* ignore */ }
      }
    }
  } catch {
    // Cache dir doesn't exist or isn't readable — that's fine
  }
}

export function clearCache(): number {
  ensureCacheDir();
  const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try { unlinkSync(join(CACHE_DIR, f)); } catch { /* ignore */ }
  }
  return files.length;
}
