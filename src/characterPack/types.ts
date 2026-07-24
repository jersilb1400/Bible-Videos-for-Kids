import { z } from "zod";
import type { MouthShape, Emotion } from "../types.js";

// ---------------------------------------------------------------------------
// Character Pack v2 — manifest schema
// ---------------------------------------------------------------------------
// The v2 "Character Pack" extends the v1 rig manifest with:
//   • skeleton / bone definitions (hierarchical, rested-pose angles)
//   • mesh deformation weights (bone-skinned vertices)
//   • additional expression layers (eyebrows, hands)
//   • animation clips (walk, wave, point, pray, sit, laugh, cry, react …)
//   • enhanced voice identity with per-emotion overrides + SSML flag
//
// The schema is intentionally extensible: future enhancements can append
// new optional sections without breaking older v2 manifests.  Every section
// added in this file is optional with a sensible default so that a migrated
// v1 manifest (which had none of them) still validates.
// ---------------------------------------------------------------------------

// ── Skeleton ────────────────────────────────────────────────────────────────

/** A single bone in the skeleton hierarchy. */
export const BoneSchema = z.object({
  /** Unique bone name, e.g. "root", "spine", "head", "arm.L". */
  name: z.string().min(1),
  /** Parent bone name. The root bone has parent null. */
  parent: z.string().nullable(),
  /** Rest length of the bone in local units (≥ 0). */
  length: z.number().min(0).default(0),
  /** Rest angle of the bone in degrees (0 = straight). */
  angle: z.number().default(0),
  /** Rest local x offset from the parent's head. */
  x: z.number().default(0),
  /** Rest local y offset from the parent's head. */
  y: z.number().default(0),
});
export type Bone = z.infer<typeof BoneSchema>;

export const SkeletonSchema = z.object({
  /** List of bones. Must contain at least one root bone (parent null). */
  bones: z.array(BoneSchema).min(1),
});
export type Skeleton = z.infer<typeof SkeletonSchema>;

// ── Mesh deformation ───────────────────────────────────────────────────────

/** A single weighted vertex of the mesh. */
export const MeshVertexSchema = z.object({
  /** Vertex index (0-based, contiguous). */
  index: z.number().int().min(0),
  /** X coordinate in the character's local viewBox space. */
  x: z.number(),
  /** Y coordinate in the character's local viewBox space. */
  y: z.number(),
  /**
   * Bone weights: map of bone name → influence weight (0-1). The vertex's
   * final position is the weighted average of bone-transformed positions.
   * Weights should sum to 1.0 for correct deformation but are not hard-
   * enforced (they may be normalised at runtime).
   */
  weights: z.record(z.string(), z.number().min(0).max(1)),
});
export type MeshVertex = z.infer<typeof MeshVertexSchema>;

export const MeshSchema = z.object({
  /** Whether mesh deformation is enabled for this character. */
  enabled: z.boolean().default(false),
  /** Vertex list. May be empty when `enabled` is false. */
  vertices: z.array(MeshVertexSchema).default([]),
});
export type Mesh = z.infer<typeof MeshSchema>;

// ── Expression layers ──────────────────────────────────────────────────────

/** Eyebrow expression presets. */
export const EyebrowShapeSchema = z.enum(["raised", "normal", "furrowed"]);
export type EyebrowShape = z.infer<typeof EyebrowShapeSchema>;

/** Hand gesture presets. */
export const HandShapeSchema = z.enum(["open", "point", "fist", "peace"]);
export type HandShape = z.infer<typeof HandShapeSchema>;

/**
 * Eyebrow expression layer. Each shape maps to an SVG path (optional).
 * Characters that render eyebrows directly in the body SVG may leave all
 * paths empty — the layer is still present so the renderer knows which shapes
 * the character *can* produce for emotion-driven selection.
 */
export const EyebrowsLayerSchema = z.object({
  /** SVG paths keyed by eyebrow shape. Optional — empty string = draw in body. */
  shapes: z.record(EyebrowShapeSchema, z.string()).default({}),
});
export type EyebrowsLayer = z.infer<typeof EyebrowsLayerSchema>;

/**
 * Hand expression layer. Shapes are keyed by hand-side ("left" | "right")
 * so each hand can have its own SVG set. Each side maps shape → SVG path.
 */
export const HandsLayerSchema = z.object({
  /** Map of hand side ("left" | "right") → shape → SVG path. */
  shapes: z.record(
    z.enum(["left", "right"]),
    z.record(HandShapeSchema, z.string()),
  ).default({}),
});
export type HandsLayer = z.infer<typeof HandsLayerSchema>;

/** Emotion-to-eyebrow-shape mapping for quick expression lookup. */
export const EmotionEyebrowsSchema = z.record(
  z.string(),
  EyebrowShapeSchema,
).default({});
export type EmotionEyebrows = z.infer<typeof EmotionEyebrowsSchema>;

// ── Animation clips ────────────────────────────────────────────────────────

/** An easing curve for a keyframe. */
export const EasingSchema = z.enum([
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "hold",
]);
export type Easing = z.infer<typeof EasingSchema>;

/** A single keyframe for a single bone within a clip. */
export const KeyframeSchema = z.object({
  /** Time in seconds from clip start (≥ 0). */
  time: z.number().min(0),
  /** Target angle in degrees (relative to rest). */
  angle: z.number().default(0),
  /** Target x offset (relative to rest). */
  x: z.number().default(0),
  /** Target y offset (relative to rest). */
  y: z.number().default(0),
  /** Easing curve applied as the bone interpolates *toward* this frame. */
  easing: EasingSchema.default("linear"),
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

/** One bone's animation track within a clip. */
export const BoneTrackSchema = z.object({
  /** Name of the bone (must match a skeleton bone). */
  bone: z.string().min(1),
  /** Ordered keyframes. Must have at least one. */
  keyframes: z.array(KeyframeSchema).min(1),
});
export type BoneTrack = z.infer<typeof BoneTrackSchema>;

/** A named reusable animation clip. */
export const AnimationClipSchema = z.object({
  /** Clip name: "walk", "wave", "point", "pray", "sit", "laugh", "cry", "react", … */
  name: z.string().min(1),
  /** Frames per second for this clip. */
  fps: z.number().int().min(1).default(24),
  /** Total duration in seconds. */
  duration: z.number().min(0),
  /** Whether the clip loops. */
  loop: z.boolean().default(false),
  /** Per-bone tracks. Each track animates one bone across the clip. */
  tracks: z.array(BoneTrackSchema).default([]),
});
export type AnimationClip = z.infer<typeof AnimationClipSchema>;

// ── Voice identity ─────────────────────────────────────────────────────────

/** Base voice parameters (mirrors v1 with extras). */
export const VoiceIdentitySchema = z.object({
  /** Provider voice id (e.g. ElevenLabs voice ID or Edge-TTS name). */
  providerVoiceId: z.string().min(1),
  /** Default speech rate multiplier. */
  rate: z.number().default(1.0),
  /** Default pitch offset in Hz or provider units. */
  pitch: z.number().default(0),
  /** Whether this voice supports SSML markup. */
  ssml: z.boolean().default(true),
  /**
   * Per-emotion overrides. Keyed by Emotion string. Each override may
   * specify rate and/or pitch deltas. Missing keys fall back to the base
   * rate/pitch. Provided the time-of-generation for the pipeline to know
   * how to adjust the voice for the dialogue's emotional tone.
   */
  emotionOverrides: z.record(
    z.string(),
    z.object({
      rate: z.number().optional(),
      pitch: z.number().optional(),
      /** Optional SSML tag snippet for this emotion (e.g. <prosody …>). */
      ssmlTag: z.string().optional(),
    }),
  ).default({}),
});
export type VoiceIdentity = z.infer<typeof VoiceIdentitySchema>;

/** The set of Emotion keys we recognise (for strong typing of overrides). */
export const KNOWN_EMOTIONS: readonly Emotion[] = [
  "neutral",
  "joy",
  "sad",
  "afraid",
  "brave",
  "wonder",
] as const;

// ── Character entry ────────────────────────────────────────────────────────

/** Required Preston-Blair visemes. */
const REQUIRED_MOUTH_SHAPES: MouthShape[] = ["A", "B", "C", "D", "E", "F", "X"];

/** Mouth map: each viseme → SVG path (relative to assetDir). */
export const MouthMapSchema = z.record(
  z.enum(["A", "B", "C", "D", "E", "F", "G", "H", "X"] as const),
  z.string().min(1),
).superRefine(( mouths, ctx) => {
  for (const shape of REQUIRED_MOUTH_SHAPES) {
    if (!(shape in mouths) || typeof mouths[shape as keyof typeof mouths] !== "string") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [shape],
        message: `required mouth shape "${shape}" is missing`,
      });
    }
  }
});
export type MouthMap = z.infer<typeof MouthMapSchema>;

/** Eyes pair (open + closed SVG paths). */
export const EyesSchema = z.object({
  open: z.string().min(1),
  closed: z.string().min(1),
});
export type Eyes = z.infer<typeof EyesSchema>;

/** Normalised anchors as fractions of the character viewBox. */
export const AnchorsSchema = z.object({
  mouth: z.tuple([z.number(), z.number()]),
  ground: z.tuple([z.number(), z.number()]),
});
export type Anchors = z.infer<typeof AnchorsSchema>;

/**
 * A single character pack entry inside the v2 manifest.
 *
 * All v2-only sections are optional with defaults so a migrated v1 entry
 * (which lacks them) still validates.
 */
export const CharacterPackEntrySchema = z.object({
  id: z.string().min(1),
  revision: z.string().default("1"),
  /** Body SVG path (relative to assetDir). */
  body: z.string().min(1),
  eyes: EyesSchema,
  mouths: MouthMapSchema,
  /** Named poses → SVG path (relative to assetDir). */
  poses: z.record(z.string(), z.string()).default({}),
  voice: VoiceIdentitySchema,
  anchors: AnchorsSchema,

  // ── v2 extensions (all optional, defaulted for backward compat) ──

  /** Skeleton / bone hierarchy for skeletal animation. */
  skeleton: SkeletonSchema.optional(),
  /** Mesh deformation (bone-skinned vertices). */
  mesh: MeshSchema.optional(),
  /** Eyebrow expression layer. */
  eyebrows: EyebrowsLayerSchema.optional(),
  /** Hand expression layer. */
  hands: HandsLayerSchema.optional(),
  /** Emotion → eyebrow shape mapping. */
  emotionEyebrows: EmotionEyebrowsSchema.optional(),
  /** Animation clips available for this character. */
  clips: z.array(AnimationClipSchema).default([]),
});
export type CharacterPackEntry = z.infer<typeof CharacterPackEntrySchema>;

// ── Manifest root ──────────────────────────────────────────────────────────

/**
 * The v2 manifest root. `schemaVersion` is pinned to the literal `2`.
 * `characters` is a non-empty array and `backgrounds` is an optional
 * map of setting → SVG path (matching v1's shape for parity).
 */
export const CharacterPackManifestSchema = z.object({
  schemaVersion: z.literal(2),
  characters: z.array(CharacterPackEntrySchema).min(1),
  backgrounds: z.record(z.string(), z.string()).default({}),
}).superRefine((manifest, ctx) => {
  // Character ids must be unique within the manifest.
  const ids = new Set<string>();
  for (let i = 0; i < manifest.characters.length; i++) {
    const c = manifest.characters[i]!;
    if (ids.has(c.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["characters", i, "id"],
        message: `duplicate character id: ${c.id}`,
      });
    }
    ids.add(c.id);
  }

  // Animation clip names must be unique per character.
  for (let i = 0; i < manifest.characters.length; i++) {
    const c = manifest.characters[i]!;
    if (!c.clips || c.clips.length === 0) continue;
    const clipNames = new Set<string>();
    for (let j = 0; j < c.clips.length; j++) {
      const clip = c.clips[j]!;
      if (clipNames.has(clip.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["characters", i, "clips", j, "name"],
          message: `duplicate clip name "${clip.name}" on character "${c.id}"`,
        });
      }
      clipNames.add(clip.name);
    }
  }

  // If skeleton is defined, every bone track in every clip must reference
  // a bone that exists in the skeleton.
  for (let i = 0; i < manifest.characters.length; i++) {
    const c = manifest.characters[i]!;
    if (!c.skeleton) continue;
    const boneNames = new Set(c.skeleton.bones.map((b) => b.name));
    for (let j = 0; j < c.clips.length; j++) {
      const clip = c.clips[j]!;
      for (let k = 0; k < clip.tracks.length; k++) {
        const track = clip.tracks[k]!;
        if (!boneNames.has(track.bone)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["characters", i, "clips", j, "tracks", k, "bone"],
            message: `clip "${clip.name}" references unknown bone "${track.bone}"`,
          });
        }
      }
    }
  }
});
export type CharacterPackManifest = z.infer<typeof CharacterPackManifestSchema>;

/**
 * On-disk shape of the v2 manifest file (what Zod parses and validates).
 * The `CharacterPack` loader attaches a derived `assetDir` string at runtime
 * — that field lives on the runtime `LoadedCharacterPackManifest`, not here.
 */
export type CharacterPackManifestFile = CharacterPackManifest;

/**
 * Runtime manifest with the derived `assetDir` that the loader attaches.
 * Paths in the manifest are resolved relative to this directory.
 */
export interface LoadedCharacterPackManifest extends CharacterPackManifest {
  /** Absolute directory the manifest file was loaded from. */
  readonly assetDir: string;
}
