import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { log } from "./logger.js";
import { config } from "./config.js";
import type { Scene, Character } from "./types.js";

/**
 * Local asset library — the free "search existing assets" layer fal.ai
 * doesn't provide. Every generated keyframe is fingerprinted by its semantic
 * content (characters + setting + visual gist) and cached to disk with a
 * manifest. Before paying for a new generation, the pipeline checks here
 * first. Recurring characters/settings (Noah, the ark, a desert daytime
 * scene) get generated once and reused across every future episode.
 *
 * This is NOT a perceptual/embedding search — it's a deterministic
 * fingerprint match. Two scenes match only if they share the same
 * characters, the same setting, and near-identical visual description.
 * That's intentional: cheap, offline, zero false-positive risk of serving
 * the wrong character's face into a new episode.
 */

interface AssetEntry {
  /** Fingerprint key this entry was stored under. */
  key: string;
  /** Absolute path to the cached image, relative to the library root at rest. */
  file: string;
  /** Original prompt used to generate it (for debugging / future re-ranking). */
  prompt: string;
  /** Which characters appear (for filtering / stats). */
  characters: string[];
  setting: string;
  /** Which provider generated it. */
  provider: string;
  /** ISO timestamp. */
  createdAt: string;
  /** How many times this asset has been reused (cost saved tracking). */
  reuseCount: number;
}

interface LibraryManifest {
  version: 1;
  entries: Record<string, AssetEntry>;
}

const LIBRARY_DIR = resolve(process.cwd(), config.outputDir, "_asset-library");
const MANIFEST_PATH = resolve(LIBRARY_DIR, "manifest.json");
const ASSETS_DIR = resolve(LIBRARY_DIR, "assets");

function ensureDirs(): void {
  mkdirSync(ASSETS_DIR, { recursive: true });
}

function loadManifest(): LibraryManifest {
  ensureDirs();
  if (!existsSync(MANIFEST_PATH)) return { version: 1, entries: {} };
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as LibraryManifest;
  } catch {
    log.warn("Asset library manifest corrupted — starting fresh.");
    return { version: 1, entries: {} };
  }
}

function saveManifest(m: LibraryManifest): void {
  ensureDirs();
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

/**
 * Build a stable fingerprint for a scene: sorted character names + setting +
 * a normalized visual description. Whitespace/case/punctuation differences
 * are ignored so paraphrased prompts across episodes still hit the cache.
 */
export function fingerprintScene(scene: Scene, characters: Character[]): string {
  const cast = characters
    .filter((c) => scene.characters.includes(c.name))
    .map((c) => c.name)
    .sort()
    .join("+");
  const normalizedVisual = scene.visual
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .sort() // bag-of-words — order-independent match
    .join(" ");
  const hash = createHash("sha256")
    .update(`${cast}|${scene.setting}|${normalizedVisual}`)
    .digest("hex")
    .slice(0, 16);
  return `${cast || "none"}-${scene.setting}-${hash}`;
}

/**
 * Look up an existing asset by fingerprint. Returns the local file path if
 * found (and copies it into the current production's images dir), or null
 * on a cache miss.
 */
export function lookupAsset(fingerprint: string, destPath: string): string | null {
  const manifest = loadManifest();
  const entry = manifest.entries[fingerprint];
  if (!entry) return null;
  if (!existsSync(entry.file)) {
    // Stale entry — the cached file was deleted. Drop it.
    delete manifest.entries[fingerprint];
    saveManifest(manifest);
    return null;
  }
  copyFileSync(entry.file, destPath);
  entry.reuseCount += 1;
  saveManifest(manifest);
  log.info(`  ♻ Asset library hit: ${fingerprint.slice(0, 24)}… (reused ${entry.reuseCount}×)`);
  return destPath;
}

/**
 * Store a freshly generated asset in the library, keyed by fingerprint.
 */
export function storeAsset(
  fingerprint: string,
  sourceFile: string,
  meta: { prompt: string; characters: string[]; setting: string; provider: string },
): void {
  ensureDirs();
  const manifest = loadManifest();
  const ext = sourceFile.slice(sourceFile.lastIndexOf("."));
  const libraryFile = resolve(ASSETS_DIR, `${fingerprint}${ext}`);
  copyFileSync(sourceFile, libraryFile);
  manifest.entries[fingerprint] = {
    key: fingerprint,
    file: libraryFile,
    prompt: meta.prompt,
    characters: meta.characters,
    setting: meta.setting,
    provider: meta.provider,
    createdAt: new Date().toISOString(),
    reuseCount: 0,
  };
  saveManifest(manifest);
}

/** Library-wide stats for the Backlot board / cost reporting. */
export function libraryStats(): { totalAssets: number; totalReuses: number; savedEstimate: number } {
  const manifest = loadManifest();
  const entries = Object.values(manifest.entries);
  const totalReuses = entries.reduce((sum, e) => sum + e.reuseCount, 0);
  // Rough savings estimate — uses the same $0.04/image fal Flux baseline as quality.ts.
  const savedEstimate = totalReuses * 0.04;
  return { totalAssets: entries.length, totalReuses, savedEstimate };
}
