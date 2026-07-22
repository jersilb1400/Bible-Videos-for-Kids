import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import type { MouthShape } from "./types.js";

// ---------------------------------------------------------------------------
// Rig manifest types — match assets/manifest.v1.json
// ---------------------------------------------------------------------------

/** Voice/TTS settings attached to a rig. */
export interface RigVoice {
  providerVoiceId: string;
  rate: number;
  pitch: number;
}

/** Normalised anchor, expressed as fractions of the character's own viewBox. */
export interface RigAnchors {
  mouth: [number, number];
  ground: [number, number];
}

/** Per-mouth SVG path entries. Required: A–F + X. G/H optional. */
export type MouthMap = Partial<Record<MouthShape, string>>;

/** A character rig entry inside the manifest. */
export interface RigCharacterEntry {
  id: string;
  revision: string;
  body: string;
  eyes: { open: string; closed: string };
  mouths: MouthMap;
  poses: Record<string, string>;
  voice: RigVoice;
  anchors: RigAnchors;
}

/**
 * In-memory manifest returned by `loadManifest`. Carries `assetDir`, the
 * absolute directory the manifest file was loaded from. Manifest paths are
 * resolved relative to that directory.
 */
export interface RigManifest {
  schemaVersion: 1;
  characters: RigCharacterEntry[];
  backgrounds: Record<string, string>;
  /** Absolute directory the manifest file was loaded from. */
  readonly assetDir: string;
}

// ---------------------------------------------------------------------------
// Resolved rig types
// ---------------------------------------------------------------------------

/**
 * Wraps an absolute filesystem path verified to exist. Extends `String` so it
 * can be passed directly to APIs expecting a string; `pathname`/`exists`/
 * `isAbsolute` are convenience flags for tests.
 */
export interface ResolvedAsset extends String {
  readonly pathname: string;
  readonly exists: boolean;
  readonly isAbsolute: boolean;
}

export interface ResolvedEyes {
  open: ResolvedAsset;
  closed: ResolvedAsset;
}

export type ResolvedMouthMap = Partial<Record<MouthShape, ResolvedAsset>>;

/** A fully-resolved rig: every manifest path replaced with an absolute,
 * verified-to-exist filesystem path. */
export interface ResolvedRig {
  characterId: string;
  revision: string;
  body: ResolvedAsset;
  eyes: ResolvedEyes;
  mouths: ResolvedMouthMap;
  poses: Record<string, ResolvedAsset>;
  voice: RigVoice;
  anchors: RigAnchors;
  /** Resolved background SVG paths keyed by setting, when present. */
  backgrounds: Record<string, ResolvedAsset>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Required visemes for every character rig. G/H are optional in the schema. */
const REQUIRED_MOUTHS: MouthShape[] = ["A", "B", "C", "D", "E", "F", "X"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class AssetError extends Error {}

function makeAsset(abs: string): ResolvedAsset {
  const str = new String(abs) as ResolvedAsset;
  Object.defineProperty(str, "pathname", { value: abs, enumerable: true });
  Object.defineProperty(str, "isAbsolute", { value: isAbsolute(abs), enumerable: true });
  Object.defineProperty(str, "exists", { value: existsSync(abs), enumerable: true });
  return str;
}

/**
 * Resolve a manifest-relative path against `assetDir`, enforcing:
 *   - relative (no absolute paths embedded in the manifest)
 *   - no null bytes
 *   - stays inside `assetDir` after normalisation (no path traversal via `..`)
 *   - file exists and is a regular file
 */
function resolveAsset(manifestPath: string, assetDir: string): string {
  if (isAbsolute(manifestPath)) {
    throw new AssetError(
      `manifest path must be relative, got absolute: ${manifestPath}`,
    );
  }
  if (manifestPath.includes("\0")) {
    throw new AssetError(`manifest path contains null byte: ${manifestPath}`);
  }
  // Explicit ../ in the raw path is always rejected — gives the test a
  // deterministic contract even when normalisation would still be in-tree.
  if (manifestPath.includes("../")) {
    throw new AssetError(
      `path traversal rejected: "../" appears in "${manifestPath}"`,
    );
  }
  const abs = normalize(join(assetDir, manifestPath));
  if (abs !== assetDir && !abs.startsWith(assetDir + sep)) {
    throw new AssetError(
      `path traversal rejected: "${manifestPath}" resolves outside ${assetDir}`,
    );
  }
  if (!existsSync(abs)) {
    throw new AssetError(`file not found: ${abs} (manifest path: "${manifestPath}")`);
  }
  const st = statSync(abs);
  if (!st.isFile()) {
    throw new AssetError(`not a regular file: ${abs}`);
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** On-disk shape of the manifest file (everything except the derived assetDir). */
type ManifestFileShape = Omit<RigManifest, "assetDir">;

/**
 * Load and validate a rig manifest JSON file. The manifest's enclosing
 * directory is captured as `assetDir` and becomes the root for resolving
 * every relative path inside the manifest.
 */
export function loadManifest(path: string): RigManifest {
  if (!existsSync(path)) {
    throw new AssetError(`manifest not found: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AssetError(`manifest is not valid JSON: ${(err as Error).message}`);
  }
  assertManifestShape(parsed);
  return { ...(parsed as ManifestFileShape), assetDir: dirname(path) };
}

function assertManifestShape(parsed: unknown): asserts parsed is ManifestFileShape {
  if (typeof parsed !== "object" || parsed === null) {
    throw new AssetError("manifest root is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    throw new AssetError(
      `unsupported manifest schemaVersion: ${obj.schemaVersion} (expected 1)`,
    );
  }
  if (!Array.isArray(obj.characters) || obj.characters.length === 0) {
    throw new AssetError("manifest.characters must be a non-empty array");
  }
  for (let i = 0; i < obj.characters.length; i++) {
    assertCharShape(
      (obj.characters as unknown[])[i] as Record<string, unknown>,
      i,
    );
  }
  if (typeof obj.backgrounds !== "object" || obj.backgrounds === null) {
    throw new AssetError("manifest.backgrounds must be an object");
  }
}

function assertCharShape(c: Record<string, unknown>, idx: number): void {
  if (typeof c.id !== "string" || c.id.length === 0) {
    throw new AssetError(`characters[${idx}].id must be a non-empty string`);
  }
  if (typeof c.revision !== "string") {
    throw new AssetError(`characters[${idx}].revision must be a string`);
  }
  if (typeof c.body !== "string" || c.body.length === 0) {
    throw new AssetError(`characters[${idx}].body must be a non-empty string`);
  }
  const eyes = c.eyes as Record<string, unknown> | undefined;
  if (
    typeof eyes !== "object" || eyes === null ||
    typeof eyes.open !== "string" ||
    typeof eyes.closed !== "string"
  ) {
    throw new AssetError(`characters[${idx}].eyes must be {open, closed}`);
  }
  const mouths = c.mouths as Record<string, unknown> | undefined;
  if (typeof mouths !== "object" || mouths === null) {
    throw new AssetError(`characters[${idx}].mouths must be an object`);
  }
  for (const shape of REQUIRED_MOUTHS) {
    if (typeof mouths[shape] !== "string" || (mouths[shape] as string).length === 0) {
      throw new AssetError(`characters[${idx}] missing required mouth: ${shape}`);
    }
  }
  for (const opt of ["G", "H"] as const) {
    if (opt in mouths && typeof mouths[opt] !== "string") {
      throw new AssetError(`characters[${idx}].mouths.${opt} must be a string`);
    }
  }
  if (typeof c.poses !== "object" || c.poses === null) {
    throw new AssetError(`characters[${idx}].poses must be an object`);
  }
  const voice = c.voice as Record<string, unknown> | undefined;
  if (
    typeof voice !== "object" || voice === null ||
    typeof voice.providerVoiceId !== "string" ||
    typeof voice.rate !== "number" ||
    typeof voice.pitch !== "number"
  ) {
    throw new AssetError(
      `characters[${idx}].voice must be {providerVoiceId, rate, pitch}`,
    );
  }
  const anchors = c.anchors as Record<string, unknown> | undefined;
  if (typeof anchors !== "object" || anchors === null) {
    throw new AssetError(`characters[${idx}].anchors must be an object`);
  }
  for (const key of ["mouth", "ground"] as const) {
    const a = anchors[key];
    if (
      !Array.isArray(a) || a.length !== 2 ||
      typeof a[0] !== "number" || typeof a[1] !== "number"
    ) {
      throw new AssetError(
        `characters[${idx}].anchors.${key} must be [number, number]`,
      );
    }
  }
}

/**
 * Resolve a single character rig: converts every relative path in the manifest
 * into an absolute filesystem path, verifies every required file exists, and
 * rejects path traversal. Throws on missing character or missing file.
 */
export function resolveRig(manifest: RigManifest, characterId: string): ResolvedRig {
  const entry = manifest.characters.find((c) => c.id === characterId);
  if (!entry) {
    throw new AssetError(
      `no character with id "${characterId}" in manifest (have: ${manifest.characters.map((c) => c.id).join(", ")})`,
    );
  }
  const dir = manifest.assetDir;
  if (!dir || dir.length === 0) {
    throw new AssetError("manifest.assetDir is empty; cannot resolve paths");
  }

  const body = makeAsset(resolveAsset(entry.body, dir));
  const eyes: ResolvedEyes = {
    open: makeAsset(resolveAsset(entry.eyes.open, dir)),
    closed: makeAsset(resolveAsset(entry.eyes.closed, dir)),
  };
  const mouths: ResolvedMouthMap = {};
  for (const shape of Object.keys(entry.mouths) as MouthShape[]) {
    const p = entry.mouths[shape]!;
    mouths[shape] = makeAsset(resolveAsset(p, dir));
  }
  for (const shape of REQUIRED_MOUTHS) {
    if (!mouths[shape]) {
      throw new AssetError(
        `missing required mouth "${shape}" for character "${characterId}"`,
      );
    }
  }
  const poses: Record<string, ResolvedAsset> = {};
  for (const [key, value] of Object.entries(entry.poses)) {
    poses[key] = makeAsset(resolveAsset(value, dir));
  }
  const backgrounds: Record<string, ResolvedAsset> = {};
  for (const [key, value] of Object.entries(manifest.backgrounds)) {
    backgrounds[key] = makeAsset(resolveAsset(value, dir));
  }
  return {
    characterId: entry.id,
    revision: entry.revision,
    body,
    eyes,
    mouths,
    poses,
    voice: entry.voice,
    anchors: entry.anchors,
    backgrounds,
  };
}
