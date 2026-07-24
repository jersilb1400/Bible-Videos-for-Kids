import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { loadManifest } from "../assets.js";
import type { RigManifest } from "../assets.js";
import type { MouthShape } from "../types.js";
import {
  CharacterPackManifestSchema,
  type CharacterPackEntry,
  type CharacterPackManifest,
  type LoadedCharacterPackManifest,
  type AnimationClip,
  type Bone,
  type EyebrowShape,
  type HandShape,
  type VoiceIdentity,
} from "./types.js";
import { migrateV1ToV2 } from "./migrate.js";

// ---------------------------------------------------------------------------
// Resolved-asset types
// ---------------------------------------------------------------------------
// Mirrors `ResolvedAsset` from assets.ts: a string subclass carrying absolute
// path flags, so a resolved path can be passed directly to APIs expecting a
// string while tests can inspect `.pathname`, `.exists`, `.isAbsolute`.
// ---------------------------------------------------------------------------

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

export type ResolvedStoryboardMap = Record<string, ResolvedAsset>;

/** Resolved eyebrow shapes (shape → absolute SVG path). */
export type ResolvedEyebrows = Partial<Record<EyebrowShape, ResolvedAsset>>;

/** Resolved hand shapes keyed by side then shape. */
export type ResolvedHands = Partial<Record<"left" | "right", Partial<Record<HandShape, ResolvedAsset>>>>;

/** A fully-resolved character pack (all paths absolute + verified). */
export interface ResolvedCharacterPack {
  readonly id: string;
  readonly revision: string;
  readonly body: ResolvedAsset;
  readonly eyes: ResolvedEyes;
  readonly mouths: ResolvedMouthMap;
  readonly poses: ResolvedStoryboardMap;
  readonly voice: VoiceIdentity;
  readonly anchors: { mouth: [number, number]; ground: [number, number] };
  readonly backgrounds: ResolvedStoryboardMap;
  readonly skeleton?: { bones: Bone[] };
  readonly mesh?: { enabled: boolean };
  readonly eyebrows?: { shapes: ResolvedEyebrows };
  readonly hands?: { shapes: ResolvedHands };
  readonly emotionEyebrows?: Record<string, EyebrowShape>;
  readonly clips: AnimationClip[];
}

// ---------------------------------------------------------------------------
// Helpers (kept private to the module)
// ---------------------------------------------------------------------------

class PackError extends Error {}

function makeAsset(abs: string): ResolvedAsset {
  const str = new String(abs) as ResolvedAsset;
  Object.defineProperty(str, "pathname", { value: abs, enumerable: true });
  Object.defineProperty(str, "isAbsolute", { value: isAbsolute(abs), enumerable: true });
  Object.defineProperty(str, "exists", { value: existsSync(abs), enumerable: true });
  return str;
}

/**
 * Choose a manifest-relative path against `assetDir`, enforcing:
 *   - relative (no absolute paths embedded in the manifest)
 *   - no null bytes
 *   - stays inside `assetDir` after normalisation (no path traversal via `..`)
 *   - file exists and is a regular file
 */
function resolveAsset(manifestPath: string, assetDir: string): string {
  if (isAbsolute(manifestPath)) {
    throw new PackError(
      `manifest path must be relative, got absolute: ${manifestPath}`,
    );
  }
  if (manifestPath.includes("\0")) {
    throw new PackError(`manifest path contains null byte: ${manifestPath}`);
  }
  if (manifestPath.includes("../")) {
    throw new PackError(
      `path traversal rejected: "../" appears in "${manifestPath}"`,
    );
  }
  const abs = normalize(join(assetDir, manifestPath));
  if (abs !== assetDir && !abs.startsWith(assetDir + sep)) {
    throw new PackError(
      `path traversal rejected: "${manifestPath}" resolves outside ${assetDir}`,
    );
  }
  if (!existsSync(abs)) {
    throw new PackError(`file not found: ${abs} (manifest path: "${manifestPath}")`);
  }
  const st = statSync(abs);
  if (!st.isFile()) {
    throw new PackError(`not a regular file: ${abs}`);
  }
  return abs;
}

const REQUIRED_MOUTHS: MouthShape[] = ["A", "B", "C", "D", "E", "F", "X"];

// ---------------------------------------------------------------------------
// CharacterPack — the public class
// ---------------------------------------------------------------------------

/**
 * Loads and resolves a Character Pack v2 manifest.
 *
 * The class accepts either a v2 manifest file (parsed against
 * `CharacterPackManifestSchema`) or a v1 `RigManifest` (which is migrated on
 * the fly via `migrateV1ToV2`). Once constructed, call `resolve(characterId)`
 * to get a fully-resolved pack with verified asset paths, or use the query
 * methods (`availablePoses`, `availableExpressions`, `availableClips`,
 * `availableVisemes`) to introspect a character's capabilities.
 */
export class CharacterPack {
  private readonly manifest: LoadedCharacterPackManifest;

  private constructor(manifest: LoadedCharacterPackManifest) {
    this.manifest = manifest;
  }

  // ── Loaders ──────────────────────────────────────────────────────────────

  /**
   * Load a v2 Character Pack manifest from a JSON file path. The manifest's
   * enclosing directory becomes the asset root for resolving all relative
   * paths. v2 manifests are validated against `CharacterPackManifestSchema`.
   */
  static fromV2File(path: string): CharacterPack {
    if (!existsSync(path)) {
      throw new PackError(`character pack manifest not found: ${path}`);
    }
    const raw = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new PackError(`character pack manifest is not valid JSON: ${(err as Error).message}`);
    }
    const validated = CharacterPackManifestSchema.parse(parsed);
    return new CharacterPack({ ...validated, assetDir: dirname(path) });
  }

  /**
   * Load a v2 manifest from an already-loaded v2 JSON object. The caller
   * supplies the `assetDir` that relative paths resolve against.
   */
  static fromV2Object(manifest: CharacterPackManifest, assetDir: string): CharacterPack {
    const validated = CharacterPackManifestSchema.parse(manifest);
    return new CharacterPack({ ...validated, assetDir });
  }

  /**
   * Load a v1 `RigManifest` file and migrate it to v2 on the fly. The v1
   * `assetDir` is preserved as the asset root. Use this for backward
   * compatibility — existing v1 manifests load without modification.
   */
  static fromV1File(path: string): CharacterPack {
    const v1: RigManifest = loadManifest(path);
    const v2 = migrateV1ToV2(v1);
    return new CharacterPack({ ...v2, assetDir: v1.assetDir });
  }

  /**
   * Build a CharacterPack from an already-loaded v1 `RigManifest` (e.g. one
   * obtained from `loadManifest` elsewhere). The v1 `assetDir` is reused.
   */
  static fromV1Manifest(v1: RigManifest): CharacterPack {
    const v2 = migrateV1ToV2(v1);
    return new CharacterPack({ ...v2, assetDir: v1.assetDir });
  }

  // ── Manifest accessors ───────────────────────────────────────────────────

  /** The schema version (always 2 for this class). */
  get schemaVersion(): 2 {
    return this.manifest.schemaVersion;
  }

  /** The raw validated manifest (with `assetDir` attached). */
  get raw(): LoadedCharacterPackManifest {
    return this.manifest;
  }

  /** Character ids available in this pack. */
  availableCharacterIds(): string[] {
    return this.manifest.characters.map((c) => c.id);
  }

  /** Lookup a raw character entry by id. Throws if not found. */
  getEntry(characterId: string): CharacterPackEntry {
    const entry = this.manifest.characters.find((c) => c.id === characterId);
    if (!entry) {
      throw new PackError(
        `no character with id "${characterId}" in pack (have: ${this.availableCharacterIds().join(", ")})`,
      );
    }
    return entry;
  }

  // ── Query methods ────────────────────────────────────────────────────────

  /**
   * Return the list of pose keys the character can produce.
   * Always includes "neutral" if present; otherwise whatever is in `poses`.
   */
  availablePoses(characterId: string): string[] {
    const entry = this.getEntry(characterId);
    return Object.keys(entry.poses);
  }

  /**
   * Return the named expression layers the character supports.
   * Currently: ["eyebrows", "hands", "mouths", "eyes"] minus missing layers.
   */
  availableExpressions(characterId: string): string[] {
    const entry = this.getEntry(characterId);
    const layers: string[] = ["mouths", "eyes"];
    if (entry.eyebrows) layers.push("eyebrows");
    if (entry.hands) layers.push("hands");
    return layers;
  }

  /**
   * Return the names of animation clips available for the character.
   * (e.g. ["walk", "wave", "point", "pray", "sit", "laugh", "cry", "react"])
   */
  availableClips(characterId: string): string[] {
    const entry = this.getEntry(characterId);
    return entry.clips.map((c) => c.name);
  }

  /**
   * Return the viseme labels the character has mouth SVGs for.
   * Always includes the required set (A–F + X); may include G/H if present.
   */
  availableVisemes(characterId: string): MouthShape[] {
    const entry = this.getEntry(characterId);
    return Object.keys(entry.mouths) as MouthShape[];
  }

  /**
   * Return the eyebrow shapes the character can produce.
   * Empty if the character has no eyebrow layer.
   */
  availableEyebrowShapes(characterId: string): EyebrowShape[] {
    const entry = this.getEntry(characterId);
    if (!entry.eyebrows) return [];
    return Object.keys(entry.eyebrows.shapes) as EyebrowShape[];
  }

  /**
   * Return the hand shapes the character can produce, aggregated across
   * both sides. Empty if the character has no hand layer.
   */
  availableHandShapes(characterId: string): HandShape[] {
    const entry = this.getEntry(characterId);
    if (!entry.hands) return [];
    const shapes = new Set<HandShape>();
    for (const side of Object.keys(entry.hands.shapes) as ("left" | "right")[]) {
      const sideMap = entry.hands.shapes[side];
      if (sideMap) {
        for (const k of Object.keys(sideMap) as HandShape[]) {
          shapes.add(k);
        }
      }
    }
    return [...shapes];
  }

  /**
   * Look up a specific animation clip by name. Returns undefined if not found.
   */
  getClip(characterId: string, clipName: string): AnimationClip | undefined {
    const entry = this.getEntry(characterId);
    return entry.clips.find((c) => c.name === clipName);
  }

  /**
   * Resolve the eyebrow shape for a given emotion. Falls back to "normal"
   * when the character has no emotion→eyebrow mapping or no entry for the
   * given emotion.
   */
  eyebrowForEmotion(characterId: string, emotion: string): EyebrowShape {
    const entry = this.getEntry(characterId);
    if (!entry.emotionEyebrows) return "normal";
    return entry.emotionEyebrows[emotion] ?? "normal";
  }

  /**
   * Resolve the voice parameters for a given emotion, merging base rate/pitch
   * with any per-emotion overrides. Returns the effective rate + pitch + ssml.
   */
  voiceForEmotion(
    characterId: string,
    emotion: string,
  ): { providerVoiceId: string; rate: number; pitch: number; ssml: boolean; ssmlTag?: string } {
    const entry = this.getEntry(characterId);
    const v = entry.voice;
    const o = v.emotionOverrides[emotion];
    return {
      providerVoiceId: v.providerVoiceId,
      rate: o?.rate ?? v.rate,
      pitch: o?.pitch ?? v.pitch,
      ssml: v.ssml,
      ssmlTag: o?.ssmlTag,
    };
  }

  // ── Asset resolution ─────────────────────────────────────────────────────

  /**
   * Resolve a single character: convert every relative path in the entry
   * to an absolute, verified-to-exist filesystem path. Throws on missing
   * character or missing file.
   */
  resolve(characterId: string): ResolvedCharacterPack {
    const entry = this.getEntry(characterId);
    const dir = this.manifest.assetDir;
    if (!dir || dir.length === 0) {
      throw new PackError("manifest.assetDir is empty; cannot resolve paths");
    }

    // Body
    const body = makeAsset(resolveAsset(entry.body, dir));

    // Eyes
    const eyes: ResolvedEyes = {
      open: makeAsset(resolveAsset(entry.eyes.open, dir)),
      closed: makeAsset(resolveAsset(entry.eyes.closed, dir)),
    };

    // Mouths
    const mouths: ResolvedMouthMap = {};
    for (const shape of Object.keys(entry.mouths) as MouthShape[]) {
      const rel = entry.mouths[shape];
      if (rel) mouths[shape] = makeAsset(resolveAsset(rel, dir));
    }
    for (const shape of REQUIRED_MOUTHS) {
      if (!mouths[shape]) {
        throw new PackError(
          `missing required mouth "${shape}" for character "${characterId}"`,
        );
      }
    }

    // Poses
    const poses: ResolvedStoryboardMap = {};
    for (const [key, value] of Object.entries(entry.poses)) {
      poses[key] = makeAsset(resolveAsset(value, dir));
    }

    // Backgrounds (manifest-level, shared across characters)
    const backgrounds: ResolvedStoryboardMap = {};
    for (const [key, value] of Object.entries(this.manifest.backgrounds)) {
      backgrounds[key] = makeAsset(resolveAsset(value, dir));
    }

    // Eyebrows (optional)
    let eyebrows: { shapes: ResolvedEyebrows } | undefined;
    if (entry.eyebrows) {
      const shapes: ResolvedEyebrows = {};
      for (const [k, v] of Object.entries(entry.eyebrows.shapes)) {
        const shape = k as EyebrowShape;
        if (v && v.length > 0) {
          shapes[shape] = makeAsset(resolveAsset(v, dir));
        }
      }
      eyebrows = { shapes };
    }

    // Hands (optional)
    let hands: { shapes: ResolvedHands } | undefined;
    if (entry.hands) {
      const shapes: ResolvedHands = {};
      for (const [sideKey, sideMap] of Object.entries(entry.hands.shapes)) {
        const side = sideKey as "left" | "right";
        const resolvedSide: Partial<Record<HandShape, ResolvedAsset>> = {};
        for (const [shapeKey, relPath] of Object.entries(sideMap)) {
          const shape = shapeKey as HandShape;
          if (relPath && relPath.length > 0) {
            resolvedSide[shape] = makeAsset(resolveAsset(relPath, dir));
          }
        }
        shapes[side] = resolvedSide;
      }
      hands = { shapes };
    }

    return {
      id: entry.id,
      revision: entry.revision,
      body,
      eyes,
      mouths,
      poses,
      voice: entry.voice,
      anchors: {
        mouth: [entry.anchors.mouth[0], entry.anchors.mouth[1]],
        ground: [entry.anchors.ground[0], entry.anchors.ground[1]],
      },
      backgrounds,
      skeleton: entry.skeleton,
      mesh: entry.mesh,
      eyebrows,
      hands,
      emotionEyebrows: entry.emotionEyebrows,
      clips: entry.clips,
    };
  }
}
