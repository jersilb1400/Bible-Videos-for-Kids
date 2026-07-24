import type { Emotion } from "../types.js";

// ────────────────────────────────────────────────────────────────────────────
// Performance engine — drives micro-animation from the real audio waveform.
// ────────────────────────────────────────────────────────────────────────────

/** Per-emotion voice modulation parameters. Applied on top of the base voice. */
export interface EmotionModulation {
  /** Playback rate multiplier (1.0 = normal). Joy → slightly faster, sad → slower. */
  rate: number;
  /** Pitch shift in Hz (0 = no shift). Wonder → +10Hz, sad → -5Hz. */
  pitchHz: number;
  /** Volume gain in dB (0 = no change). Brave → +2dB, afraid → -3dB. */
  gainDb: number;
}

/** Default modulation per emotion. When emotion is not in the map, neutral is used. */
export const EMOTION_MODULATION: Record<Emotion, EmotionModulation> = {
  neutral: { rate: 1.0, pitchHz: 0, gainDb: 0 },
  joy:     { rate: 1.08, pitchHz: 8, gainDb: 1 },
  sad:     { rate: 0.92, pitchHz: -5, gainDb: -1 },
  afraid:  { rate: 1.12, pitchHz: -3, gainDb: -2 },
  brave:   { rate: 1.02, pitchHz: 3, gainDb: 2 },
  wonder:  { rate: 0.95, pitchHz: 12, gainDb: 1 },
};

// ────────────────────────────────────────────────────────────────────────────
// Breathing schedule — deterministic idle motion for non-speaking characters.
// ────────────────────────────────────────────────────────────────────────────

/** A single breathing cycle: inhale (scale up slightly) + exhale (return). */
export interface BreathCycle {
  /** Start of inhale, in seconds from shot start. */
  startSec: number;
  /** Duration of the inhale phase in seconds (scale 1.0 → 1.012). */
  inhaleSec: number;
  /** Duration of the exhale phase in seconds (scale 1.012 → 1.0). */
  exhaleSec: number;
}

/**
 * Generate a deterministic breathing schedule for a character over a shot.
 *
 * Average adult breathes 12-20 times/minute; for cartoon subtlety we aim
 * for ~10 breaths/minute (one every 6 seconds) with slight jitter so two
 * characters on screen don't breathe in perfect sync.
 *
 * Breathing depth is intentionally subtle (1.2% scale) — visible enough to
 * make a still character feel alive, not so much it looks like panting.
 */
export function generateBreathSchedule(
  seed: number,
  durationSec: number,
): BreathCycle[] {
  const rng = mulberry32(seed);
  const cycles: BreathCycle[] = [];
  // First breath starts 0.5-2.5s in (avoids an immediate heave at frame 0)
  let t = 0.5 + rng() * 2;
  while (t < durationSec) {
    const inhale = 1.8 + rng() * 0.6; // 1.8-2.4s inhale
    const exhale = 2.4 + rng() * 0.8;  // 2.4-3.2s exhale
    cycles.push({ startSec: t, inhaleSec: inhale, exhaleSec: exhale });
    t += inhale + exhale;
  }
  return cycles;
}

/**
 * Compute the breathing scale factor at a specific time within a shot.
 * Returns 1.0 during exhale/rest, rising to ~1.012 during inhale.
 */
export function breathScaleAt(cycles: BreathCycle[], tSec: number): number {
  const DEPTH = 0.012;
  for (const c of cycles) {
    const inhaleEnd = c.startSec + c.inhaleSec;
    if (tSec >= c.startSec && tSec < inhaleEnd) {
      // Smooth ease-in-out (cubic) during inhale
      const p = (tSec - c.startSec) / c.inhaleSec;
      return 1.0 + DEPTH * easeInOutCubic(p);
    }
    const exhaleEnd = inhaleEnd + c.exhaleSec;
    if (tSec >= inhaleEnd && tSec < exhaleEnd) {
      // Smooth ease-out during exhale
      const p = (tSec - inhaleEnd) / c.exhaleSec;
      return 1.0 + DEPTH * (1 - easeInOutCubic(p));
    }
  }
  return 1.0;
}

// ────────────────────────────────────────────────────────────────────────────
// Gesture timeline — timed animation events layered on top of base posing.
// ────────────────────────────────────────────────────────────────────────────

/** Gesture type — what the character does with their body during a line. */
export type GestureType =
  | "point"
  | "wave"
  | "nod"
  | "head-shake"
  | "raise-hands"
  | "fold-arms"
  | "none";

/** A single timed gesture within a shot. */
export interface GestureEvent {
  /** Start time in seconds from shot start. */
  startSec: number;
  /** Duration in seconds. */
  durationSec: number;
  /** The gesture type. */
  type: GestureType;
  /** Which character performs it. */
  characterId: string;
  /** Triggered by a specific dialogue line (optional, for emphasis sync). */
  triggerUtteranceId?: string;
}

/**
 * Generate gesture events from dialogue timing and text analysis.
 *
 * Rules (deterministic — no Math.random):
 *  - "point" gestures when the text contains directional words (look, there, here, behold)
 *  - "wave" gestures for greetings (hello, hi, welcome, good morning)
 *  - "nod" for agreement (yes, indeed, truly, amen)
 *  - "head-shake" for negation (no, never, not)
 *  - "raise-hands" for worship/prayer (praise, God, Lord, pray, thank)
 *  - "fold-arms" for authority/judgment (decree, law, must, shall)
 *  - "none" as default
 *
 * Gestures are placed at the START of the triggering utterance and last
 * min(1.5s, utteranceDuration * 0.6).
 */
export function generateGestures(
  utterances: { utteranceId: string; speakerId: string; text: string; startSec: number; durationSec: number }[],
): GestureEvent[] {
  const events: GestureEvent[] = [];
  for (const u of utterances) {
    const gesture = classifyText(u.text);
    if (gesture === "none") continue;
    const durationSec = Math.min(1.5, u.durationSec * 0.6);
    events.push({
      startSec: u.startSec,
      durationSec,
      type: gesture,
      characterId: u.speakerId,
      triggerUtteranceId: u.utteranceId,
    });
  }
  return events;
}

function classifyText(text: string): GestureType {
  const lower = text.toLowerCase();
  // Order matters: check most-specific first.
  // Greetings (hello, good morning) before directional (there, here)
  // because "Hello there!" should produce a wave, not a point.
  if (/\b(hello|hi|welcome|good\s*morning|greetings)\b/.test(lower)) return "wave";
  if (/\b(look|behold|see)\b/.test(lower)) return "point";
  if (/\b(there|here)\b/.test(lower)) return "point";
  if (/\b(yes|indeed|truly|amen|of\s*course)\b/.test(lower)) return "nod";
  if (/\b(no|never|not|don't|cannot|won't)\b/.test(lower)) return "head-shake";
  if (/\b(praise|god|lord|pray|thank|worship|bless)\b/.test(lower)) return "raise-hands";
  if (/\b(decree|law|must|shall|command|order)\b/.test(lower)) return "fold-arms";
  return "none";
}

// ────────────────────────────────────────────────────────────────────────────
// Head movement — subtle idle sway + expressive dips for emotion.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute head offset (xPx, yPx) at a given shot time.
 *
 * Combines:
 *  - Idle sway: a slow sinusoidal lateral drift (~3px at 1280×720)
 *  - Speaking emphasis: a slight downward dip at the start of each phrase
 *  - Emotion: "sad" tilts down slightly, "wonder" tilts up, "joy" bobs
 *
 * The offset is in fractional units (multiply by frame width/height for pixels).
 */
export function headOffsetAt(
  tSec: number,
  emotion: Emotion,
  seed: number,
  isSpeaking: boolean,
): { xFrac: number; yFrac: number; rotateDeg: number } {
  // Idle sway: 0.4° amplitude, 0.08Hz (12.5s period)
  const swayX = Math.sin(tSec * 0.5 + seed) * 0.0015; // ~1.92px at 1280
  const swayY = Math.cos(tSec * 0.37 + seed * 1.7) * 0.001; // ~0.72px at 720

  let yFrac = swayY;
  let rotateDeg = Math.sin(tSec * 0.5 + seed) * 0.4;

  // Emotion-based postural lean (held throughout, not animated per-frame)
  switch (emotion) {
    case "sad":
      yFrac += 0.006;     // head drops ~4.3px at 720p
      rotateDeg += 0;      // no tilt
      break;
    case "wonder":
      yFrac -= 0.004;     // head lifts ~2.9px
      rotateDeg += -1.2;  // slight upward tilt
      break;
    case "joy":
      // Subtle bobbing: 2Hz, 0.8° amplitude
      rotateDeg += Math.sin(tSec * 2 + seed) * 0.8;
      break;
    case "afraid":
      // Subtle tremor: 6Hz, 0.3° amplitude
      rotateDeg += Math.sin(tSec * 6 + seed) * 0.3;
      yFrac += 0.002; // slight recoil
      break;
    case "brave":
      // Chin up, still
      yFrac -= 0.003;
      break;
    case "neutral":
    default:
      break;
  }

  // Speaking emphasis: slight downward nod at phrase start (first 0.3s)
  if (isSpeaking) {
    const phrasePhase = Math.min(1, (tSec % 2) / 0.3); // reset every 2s
    if (phrasePhase < 1) {
      yFrac += 0.003 * (1 - easeOutCubic(phrasePhase));
    }
  }

  return { xFrac: swayX, yFrac, rotateDeg };
}

// ────────────────────────────────────────────────────────────────────────────
// Performance track — the complete set of micro-animations for a shot.
// ────────────────────────────────────────────────────────────────────────────

/**
 * A complete performance track for a single character in a single shot.
 * The renderer reads this to drive body, eyes, mouth, head, and breathing.
 */
export interface PerformanceTrack {
  characterId: string;
  breathing: BreathCycle[];
  gestures: GestureEvent[];
  /** The emotion that determines the postural baseline. */
  emotion: Emotion;
  /** Seed for deterministic idle motion. */
  seed: number;
}

/**
 * Build a performance track for a character in a shot.
 *
 * Combines breathing schedule, gesture events, and emotion into a single
 * track the renderer can sample per-frame without recomputing.
 */
export function buildPerformanceTrack(
  characterId: string,
  seed: number,
  durationSec: number,
  emotion: Emotion,
  utterances: { utteranceId: string; speakerId: string; text: string; startSec: number; durationSec: number }[],
): PerformanceTrack {
  const breathSeed = seed + hashString(characterId);
  const breathing = generateBreathSchedule(breathSeed, durationSec);
  const gestures = generateGestures(
    utterances.filter((u) => u.speakerId === characterId),
  );
  return {
    characterId,
    breathing,
    gestures,
    emotion,
    seed: breathSeed,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Utility — deterministic PRNG (same algorithm as svgCutout.ts for consistency).
// ────────────────────────────────────────────────────────────────────────────

function mulberry32(seedValue: number): () => number {
  let a = seedValue;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Simple string hash → 32-bit integer. Deterministic, non-cryptographic. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Cubic ease-in-out: 0→0.5 is ease-in, 0.5→1 is ease-out. */
function easeInOutCubic(t: number): number {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Cubic ease-out: starts fast, decelerates. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
