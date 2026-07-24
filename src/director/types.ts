import { z } from "zod";
import type { Shot, DialogueLine, Emotion, CameraMove } from "../types.js";
import {
  ShotSchema,
  EpisodeSchema,
} from "../types.js";

// ---------------------------------------------------------------------------
// DirectorConfig — LLM endpoint + directing style parameters.
// ---------------------------------------------------------------------------

/** Target age bracket drives vocabulary, pacing, and emotional intensity. */
export type TargetAge = "3-5" | "6-8" | "3-8";

/** Overall tonal direction for the episode. */
export type Tone = "gentle" | "playful" | "reverent" | "adventurous";

/** Pacing of cuts and dialogue beats. */
export type Pacing = "slow" | "medium" | "fast";

/** Humour level — keeps content age-appropriate. */
export type HumorLevel = "none" | "subtle" | "playful" | "slapstick";

/**
 * Configuration the director uses to call an LLM and to shape its directing
 * style. The endpoint, model, and API key are **self-contained** here — they
 * do NOT come from the global `src/config.ts`. This lets tests supply a mock
 * endpoint.
 */
export interface DirectorConfig {
  /** OpenAI-compatible chat completions endpoint base URL (no trailing slash). */
  endpoint: string;
  /** Model id the LLM should use (e.g. "gpt-4o", "meta/llama-3.1-70b"). */
  model: string;
  /** Bearer token / API key for the endpoint. Sent as `Authorization: Bearer <key>`. */
  apiKey: string;
  /** Target age audience. */
  targetAge: TargetAge;
  /** Desired emotional tone. */
  tone: Tone;
  /** Cut and beat pacing. */
  pacing: Pacing;
  /** Humour level for the production. */
  humorLevel: HumorLevel;
}

/** A minimal, fully-offline config used as a default and by the fallback director. */
export const DEFAULT_DIRECTOR_CONFIG: DirectorConfig = {
  endpoint: "",
  model: "",
  apiKey: "",
  targetAge: "3-8",
  tone: "gentle",
  pacing: "medium",
  humorLevel: "subtle",
};

// ---------------------------------------------------------------------------
// ScreenplayInput — maps to the existing v1 Story type.
// ---------------------------------------------------------------------------

/** A character in the screenplay (same shape as v1 `Character`). */
export const ScreenplayCharacterSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  palette: z.object({
    skin: z.string(),
    hair: z.string(),
    robe: z.string(),
  }),
});
export type ScreenplayCharacter = z.infer<typeof ScreenplayCharacterSchema>;

/** A scene in the screenplay (same shape as v1 `Scene`). */
export const ScreenplaySceneSchema = z.object({
  narration: z.string().min(1),
  visual: z.string().min(1),
  characters: z.array(z.string()).default([]),
  setting: z.enum(["day", "night", "sunrise", "indoor", "water", "desert"]).default("day"),
});
export type ScreenplayScene = z.infer<typeof ScreenplaySceneSchema>;

/**
 * A screenplay input — the story to be directed. Maps to v1 {@link Story}.
 *
 * This is a separate type from `Story` so the director module has a clean
 * dependency-free contract; it's structurally compatible with `Story` and can
 * be passed directly from v1 inputs.
 */
export const ScreenplayInputSchema = z.object({
  title: z.string().min(1),
  source: z.string().min(1),
  lesson: z.string().min(1),
  characters: z.array(ScreenplayCharacterSchema).min(1),
  scenes: z.array(ScreenplaySceneSchema).min(1),
});
export type ScreenplayInput = z.infer<typeof ScreenplayInputSchema>;

// ---------------------------------------------------------------------------
// DirectedShot — Shot + director metadata.
// ---------------------------------------------------------------------------

/**
 * Suggested animation clip for an actor in a shot.
 *
 * `clipId` is a freeform string the animation catalog understands
 * (e.g. "wave", "point", "pray", "sit-idle").
 */
export interface AnimationSuggestion {
  characterId: string;
  clipId: string;
  /** Why this clip was chosen (for humans / debugging). */
  reasoning: string;
}

/**
 * A reaction shot cue for a character who is *listening* — the director notes
 * that we should cut to their reaction during a particular dialogue line.
 */
export interface ReactionShot {
  /** The character whose reaction we should show. */
  characterId: string;
  /** The dialogue line id whose emphasis triggers the reaction. */
  triggerLineId: string;
  /** What emotion the reaction should convey. */
  emotion: Emotion;
}

/**
 * A timing cue: pause a macroscopic duration based on the emotional beat.
 * Aligned to a dialogue line id for sync purposes.
 */
export interface GestureTimingCue {
  lineId: string;
  /** When (ms within the line) the gesture should start. */
  startMs: number;
  /** Duration of the gesture in ms. */
  durationMs: number;
  /** The gesture/pose key. */
  gesture: string;
}

/** Director metadata that extends a v2 {@link Shot}. */
export interface DirectorMetadata {
  /** Why the characters are placed this way (rule of thirds, speaker prominence, etc.). */
  staging: string;
  /** Why this camera move was chosen. */
  cameraRationale: string;
  /** Per-actor animation suggestions. */
  animationSuggestions: AnimationSuggestion[];
  /** Gesture timing cues aligned to dialogue emphasis. */
  gestureTiming: GestureTimingCue[];
  /** Reaction shots for listening characters. */
  reactionShots: ReactionShot[];
}

/** A Shot enriched with director's staging notes. */
export type DirectedShot = Shot & {
  director: DirectorMetadata;
};

// ---------------------------------------------------------------------------
// LLM response schema.
// ---------------------------------------------------------------------------
// The LLM is asked to return a JSON object `{ shots: [...] }` where each shot
// has all the v2 Shot fields plus a `director` block. We validate with a Zod
// schema that reuses the base ShotSchema (which already has defaults) and
// extends it with the director metadata. EpisodeSchema re-validates the
// full episode internally.

const AnimationSuggestionSchema = z.object({
  characterId: z.string().min(1),
  clipId: z.string().min(1),
  reasoning: z.string().default(""),
});

const ReactionShotSchema = z.object({
  characterId: z.string().min(1),
  triggerLineId: z.string().min(1),
  emotion: z.enum(["neutral", "joy", "sad", "afraid", "brave", "wonder"]).default("neutral"),
});

const GestureTimingCueSchema = z.object({
  lineId: z.string().min(1),
  startMs: z.number().int().min(0).default(0),
  durationMs: z.number().int().min(0).default(300),
  gesture: z.string().min(1),
});

const DirectorMetadataSchema = z.object({
  staging: z.string().default(""),
  cameraRationale: z.string().default(""),
  animationSuggestions: z.array(AnimationSuggestionSchema).default([]),
  gestureTiming: z.array(GestureTimingCueSchema).default([]),
  reactionShots: z.array(ReactionShotSchema).default([]),
});

/**
 * The shot schema the LLM response is parsed against. It extends the base
 * `ShotSchema` with a `director` block and discards unknown fields.
 */
export const DirectedShotSchema = ShotSchema.extend({
  director: DirectorMetadataSchema.optional().default({
    staging: "",
    cameraRationale: "",
    animationSuggestions: [],
    gestureTiming: [],
    reactionShots: [],
  }),
}).strip();

/** The full JSON object the LLM returns. */
export const DirectorResponseSchema = z.object({
  schemaVersion: z.literal(2).optional(),
  title: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  lesson: z.string().min(1).optional(),
  cast: z
    .array(
      z.object({
        characterId: z.string().min(1),
        rigId: z.string().min(1),
        voiceId: z.string().min(1),
      }),
    )
    .optional(),
  shots: z.array(DirectedShotSchema).min(1),
});

/** A parsed, validated director response payload. */
export type DirectorResponse = z.infer<typeof DirectorResponseSchema>;

// ---------------------------------------------------------------------------
// DirectedEpisode — full episode with director metadata on every shot.
// ---------------------------------------------------------------------------

/**
 * A v2 Episode where every shot carries a `director` metadata block.
 * Built by `fallback.ts` or parsed from the LLM response (after enriching
 * with cast information from the ScreenplayInput).
 */
export interface DirectedEpisode {
  schemaVersion: 2;
  title: string;
  source: string;
  lesson: string;
  cast: {
    characterId: string;
    rigId: string;
    voiceId: string;
  }[];
  shots: DirectedShot[];
}

/** Validates a DirectedEpisode through the EpisodeSchema (reuses all superRefine rules). */
export function validateDirectedEpisode(ep: DirectedEpisode): DirectedEpisode {
  // Strip director metadata for base EpisodeSchema validation (ShotSchema doesn't know it).
  const baseEpisode = {
    schemaVersion: 2 as const,
    title: ep.title,
    source: ep.source,
    lesson: ep.lesson,
    cast: ep.cast,
    shots: ep.shots.map((s) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { director: _director, ...shot } = s;
      return shot;
    }),
  };
  const _parsed = EpisodeSchema.parse(baseEpisode);
  void _parsed;
  // The base episode validated cleanly; return the original with director metadata intact.
  return ep;
}

export type { DialogueLine, Emotion, CameraMove };
