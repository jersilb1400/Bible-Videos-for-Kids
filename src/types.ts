import { z } from "zod";

/**
 * A single beat of the story. One scene == one cartoon keyframe that gets
 * animated into a short clip with its own narration line.
 */
export const SceneSchema = z.object({
  /** Narration spoken over this scene (kept short and child-friendly). */
  narration: z.string().min(1),
  /** Visual prompt for the image/animation model. */
  visual: z.string().min(1),
  /** Which named characters appear, for reference-sheet consistency. */
  characters: z.array(z.string()).default([]),
  /** Background mood, used by the local renderer and as a model hint. */
  setting: z.enum(["day", "night", "sunrise", "indoor", "water", "desert"]).default("day"),
});
export type Scene = z.infer<typeof SceneSchema>;

export const CharacterSchema = z.object({
  name: z.string(),
  /** Stable visual description reused on every scene for consistency. */
  description: z.string(),
  /** Hex palette the local renderer uses; also fed to image models. */
  palette: z.object({ skin: z.string(), hair: z.string(), robe: z.string() }),
});
export type Character = z.infer<typeof CharacterSchema>;

export const StorySchema = z.object({
  title: z.string(),
  /** The Bible passage / theme this episode is based on. */
  source: z.string(),
  /** One-line moral for the parents in the description. */
  lesson: z.string(),
  characters: z.array(CharacterSchema).min(1),
  scenes: z.array(SceneSchema).min(3),
});
export type Story = z.infer<typeof StorySchema>;

export interface VideoMetadata {
  title: string;
  description: string;
  tags: string[];
}

/** Artifact bundle threaded through the pipeline stages. */
export interface Production {
  id: string;
  story: Story;
  /** Absolute paths to per-scene rendered images. */
  sceneImages: string[];
  /** Absolute paths to per-scene animated clips. */
  sceneClips: string[];
  narrationAudio?: string;
  musicAudio?: string;
  finalVideo?: string;
  thumbnail?: string;
  metadata?: VideoMetadata;
  /** Estimated seconds per scene, used to size animation + audio. */
  sceneDurations: number[];
  publishResult?: { id: string; url: string; status: string };
}

// ---------------------------------------------------------------------------
// v2 — Dialogue-first episode schema
// ---------------------------------------------------------------------------
// The v2 model is organised around *shots* of *talking characters* instead of
// narration-over-a-still. Each Episode has a cast of character rigs, a list of
// shots, and every shot carries its own dialogue lines. Narration (for legacy
// v1 stories imported through `adaptV1Story`) is preserved as a shot's
// `leadIn` so nothing is lost, but the canonical content of a v2 shot is its
// `dialogue[]`.
//
// EpisodeSchema uses a `superRefine` pass to enforce cross-field rules that
// per-field validators can't express: unique IDs, every speaker must be in the
// cast and in that shot's actors, and non-legacy shots must carry at least one
// spoken line (legacy shots imported from v1 may carry only a `leadIn`).
// ---------------------------------------------------------------------------

/** Emotional tone of a single dialogue line. Drives pose + mouth expression. */
export type Emotion = "neutral" | "joy" | "sad" | "afraid" | "brave" | "wonder";

/** Preston-Blair-style mouth viseme labels used by the cut-out renderer. */
export type MouthShape = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "X";

/** Camera movement for a shot. The SVG/ffmpeg renderer approximates these. */
export type CameraMove = "locked" | "push-in" | "pan-left" | "pan-right";

/** A single spoken utterance inside a shot, tied to one cast character. */
export const DialogueLineSchema = z.object({
  /** Stable id unique across the whole episode (used as the TTS/audio key). */
  id: z.string().min(1),
  /** `characterId` of the speaking cast member. Must be in the shot's actors. */
  speakerId: z.string().min(1),
  /** The exact line spoken. Never empty. */
  text: z.string().min(1),
  /** Drives pose and mouth shape selection. Defaults to neutral. */
  emotion: z.enum(["neutral", "joy", "sad", "afraid", "brave", "wonder"]).default("neutral"),
  /** Silence after this line, in integer milliseconds. */
  pauseAfterMs: z.number().int().min(0).default(300),
});
export type DialogueLine = z.infer<typeof DialogueLineSchema>;

/** A character placed on a shot's stage. */
export const ShotActorSchema = z.object({
  /** `characterId` of a cast member present in this shot. */
  characterId: z.string().min(1),
  /** Normalised stage position [0,1]. */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  /** Render scale multiplier (1 = native). */
  scale: z.number().positive().default(1),
  /** Freeform pose key the rig catalog understands (e.g. "wave", "sit"). */
  pose: z.string().default("neutral"),
  /** Which way the character faces (camera-left or camera-right). */
  facing: z.enum(["left", "right"]).default("right"),
});
export type ShotActor = z.infer<typeof ShotActorSchema>;

/**
 * One beat of an episode: a place, a set of characters, and what they say.
 *
 * `dialogue` is an array (not `.min(1)`) so that legacy shots imported from v1
 * narration-only stories can legitimately carry zero spoken lines. The
 * EpisodeSchema superRefine enforces that *non-legacy* shots have at least one
 * dialogue line; a shot is treated as legacy when its `action` field contains
 * the case-insensitive marker "legacy" (set by `adaptV1Story`).
 */
export const ShotSchema = z.object({
  /** Stable id unique across the episode. */
  id: z.string().min(1),
  /** Setting/rig key for the background (e.g. "setting:throne-room"). */
  settingId: z.string().min(1),
  /** Characters visibly on stage in this shot. */
  actors: z.array(ShotActorSchema).min(1),
  /** Optional narration spoken *before* the shot's dialogue, bridging scenes. */
  leadIn: z
    .object({ text: z.string().min(1), pauseAfterMs: z.number().int().min(0) })
    .optional(),
  /** The spoken lines for this shot. May be empty only for legacy shots. */
  dialogue: z.array(DialogueLineSchema),
  /**
   * Freeform action note. When it contains "legacy" (case-insensitive) the
   * EpisodeSchema relaxes the ≥1-dialogue-line rule — used by `adaptV1Story`
   * to represent v1 narration-only scenes without fabricating dialogue.
   */
  action: z.string().default(""),
  /** Camera movement for this shot. */
  camera: z.enum(["locked", "push-in", "pan-left", "pan-right"]).default("locked"),
});
export type Shot = z.infer<typeof ShotSchema>;

/** Cast entry: binds a canonical characterId to a rig and a voice. */
export const CharacterRigRefSchema = z.object({
  /** `characterId` unique within the episode cast. */
  characterId: z.string().min(1),
  /** Visual rig key the renderer understands (e.g. "rig:daniel"). */
  rigId: z.string().min(1),
  /** TTS voice id (e.g. "voice:daniel"). */
  voiceId: z.string().min(1),
});
export type CharacterRigRef = z.infer<typeof CharacterRigRefSchema>;

const LEGACY_MARKER = /legacy/i;

/**
 * A dialogue-first episode. The schemaVersion literal pins this to v2.
 *
 * superRefine enforces the cross-field invariants the pipeline relies on:
 *  - cast characterIds are unique
 *  - rigId/voiceId are unique within the cast
 *  - shot ids are unique across the episode
 *  - dialogue line ids are unique across the whole episode
 *  - every dialogue speaker exists in the cast
 *  - every dialogue speaker is one of that shot's actors
 *  - every non-legacy shot has at least one dialogue line
 */
export const EpisodeSchema = z
  .object({
    schemaVersion: z.literal(2),
    title: z.string().min(1),
    source: z.string().min(1),
    lesson: z.string().min(1),
    cast: z.array(CharacterRigRefSchema).min(1),
    shots: z.array(ShotSchema).min(1),
  })
  .superRefine((ep, ctx) => {
    // Cast characterIds must be unique.
    const castIds = new Set<string>();
    const seenRigIds = new Set<string>();
    const seenVoiceIds = new Set<string>();
    for (const c of ep.cast) {
      if (castIds.has(c.characterId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cast"],
          message: `duplicate cast characterId: ${c.characterId}`,
        });
      }
      castIds.add(c.characterId);
      if (seenRigIds.has(c.rigId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cast"],
          message: `duplicate cast rigId: ${c.rigId}`,
        });
      }
      seenRigIds.add(c.rigId);
      if (seenVoiceIds.has(c.voiceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cast"],
          message: `duplicate cast voiceId: ${c.voiceId}`,
        });
      }
      seenVoiceIds.add(c.voiceId);
    }

    // Shot ids must be unique across the episode.
    const shotIds = new Set<string>();
    for (const shot of ep.shots) {
      if (shotIds.has(shot.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["shots"],
          message: `duplicate shot id: ${shot.id}`,
        });
      }
      shotIds.add(shot.id);
    }

    // Dialogue line ids must be unique across the whole episode.
    const lineIds = new Set<string>();
    for (const shot of ep.shots) {
      for (const line of shot.dialogue) {
        if (lineIds.has(line.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["shots"],
            message: `duplicate dialogue line id: ${line.id}`,
          });
        }
        lineIds.add(line.id);
      }
    }

    // Per-shot cross-field rules.
    for (let s = 0; s < ep.shots.length; s++) {
      const shot = ep.shots[s]!;
      const actorIds = new Set(shot.actors.map((a) => a.characterId));

      // Every speaker in this shot must exist in the cast.
      for (let l = 0; l < shot.dialogue.length; l++) {
        const line = shot.dialogue[l]!;
        if (!castIds.has(line.speakerId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["shots", s, "dialogue", l, "speakerId"],
            message: `speaker "${line.speakerId}" is not in the cast`,
          });
        }
        // Every speaker must be one of this shot's actors.
        if (!actorIds.has(line.speakerId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["shots", s, "dialogue", l, "speakerId"],
            message: `speaker "${line.speakerId}" is not one of this shot's actors`,
          });
        }
      }

      // Non-legacy shots must have at least one dialogue line.
      if (shot.dialogue.length === 0 && !LEGACY_MARKER.test(shot.action)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["shots", s, "dialogue"],
          message: `shot "${shot.id}" has no dialogue lines (only legacy shots may omit dialogue)`,
        });
      }
    }
  });
export type Episode = z.infer<typeof EpisodeSchema>;
