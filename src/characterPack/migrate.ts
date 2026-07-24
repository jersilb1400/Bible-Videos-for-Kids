import type { RigManifest, RigCharacterEntry } from "../assets.js";
import {
  CharacterPackManifestSchema,
  type CharacterPackManifest,
  type Bone,
  type CharacterPackEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// v1 → v2 manifest migration
// ---------------------------------------------------------------------------
// Takes a loaded v1 `RigManifest` (from `loadManifest`) and produces a v2
// `CharacterPackManifest` with all v2-only fields filled in with sensible
// defaults:
//
//   • skeleton  — a single "root" bone with parent null, length 0.
//   • mesh      — disabled, no vertices.
//   • eyebrows  — empty shapes map (drawn in body SVG).
//   • hands     — empty shapes map.
//   • emotionEyebrows — all known emotions default to "normal".
//   • clips     — empty array (no animation clips).
//   • voice     — upgraded with `ssml: true` and empty `emotionOverrides`.
//
// The produced manifest is validated against `CharacterPackManifestSchema`
// before being returned, so the output is guaranteed well-formed.
// ---------------------------------------------------------------------------

/** A minimal root-only skeleton appended to every migrated character. */
function defaultSkeleton(): Bone[] {
  return [{ name: "root", parent: null, length: 0, angle: 0, x: 0, y: 0 }];
}

/** Default emotion→eyebrow mapping (all "normal" — no eyebrow animation). */
function defaultEmotionEyebrows(): Record<string, "raised" | "normal" | "furrowed"> {
  return {
    neutral: "normal",
    joy: "normal",
    sad: "normal",
    afraid: "normal",
    brave: "normal",
    wonder: "normal",
  };
}

/**
 * Upgrade a single v1 `RigCharacterEntry` to a v2 `CharacterPackEntry`.
 *
 * All v2-only sections are populated with defaults. The v1 fields (body,
 * eyes, mouths, poses, voice, anchors) are preserved verbatim — only `voice`
 * is reshaped to add `ssml` and `emotionOverrides`.
 */
function migrateCharacter(c: RigCharacterEntry): CharacterPackEntry {
  return {
    id: c.id,
    revision: c.revision,
    body: c.body,
    eyes: { open: c.eyes.open, closed: c.eyes.closed },
    mouths: { ...c.mouths },
    poses: { ...c.poses },
    voice: {
      providerVoiceId: c.voice.providerVoiceId,
      rate: c.voice.rate,
      pitch: c.voice.pitch,
      ssml: true,
      emotionOverrides: {},
    },
    anchors: {
      mouth: [c.anchors.mouth[0], c.anchors.mouth[1]],
      ground: [c.anchors.ground[0], c.anchors.ground[1]],
    },
    skeleton: { bones: defaultSkeleton() },
    mesh: { enabled: false, vertices: [] },
    eyebrows: { shapes: {} },
    hands: { shapes: {} },
    emotionEyebrows: defaultEmotionEyebrows(),
    clips: [],
  };
}

/**
 * Build a default placeholder clip list for a migrated character.
 * Migrated characters get no animation clips by default (the renderer falls
 * back to static poses). This keeps the schema honest — a real pack author
 * would populate `clips` with real bone-keyed animations.
 */

/**
 * Migrate a loaded v1 `RigManifest` into a v2 `CharacterPackManifest`.
 *
 * The v1 `assetDir` is NOT carried over — the returned object is a pure data
 * value validated against the v2 schema. If the caller needs runtime asset
 * resolution they should pass the result to `CharacterPack.fromManifest`
 * along with the original `assetDir`.
 *
 * @throws if the produced v2 manifest fails Zod validation (should not happen
 *         for a valid v1 manifest — defaults are chosen to always validate).
 */
export function migrateV1ToV2(v1: RigManifest): CharacterPackManifest {
  const v2 = {
    schemaVersion: 2 as const,
    characters: v1.characters.map(migrateCharacter),
    backgrounds: { ...v1.backgrounds },
  };
  // Validate the migrated output against the v2 schema. Any issue here
  // indicates a bug in the migration defaults.
  return CharacterPackManifestSchema.parse(v2);
}

/**
 * Migrate any supported manifest version to v2.
 *
 * Currently only v1 (`schemaVersion: 1`) is supported. A v2 manifest passed
 * through here is re-validated and returned as-is (so callers can normalise
 * arbitrary input to a validated v2 object).
 */
export function migrateToV2(manifest: unknown): CharacterPackManifest {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("migrateToV2: manifest is not an object");
  }
  const obj = manifest as Record<string, unknown>;
  const version = obj.schemaVersion;
  if (version === 2) {
    // Already v2 — re-validate and return.
    return CharacterPackManifestSchema.parse(manifest);
  }
  if (version === 1) {
    // v1 manifest shape — but we only have the runtime RigManifest type.
    // The caller is expected to pass a loaded `RigManifest` here.
    return migrateV1ToV2(manifest as RigManifest);
  }
  throw new Error(
    `migrateToV2: unsupported manifest schemaVersion ${String(version)} (expected 1 or 2)`,
  );
}
