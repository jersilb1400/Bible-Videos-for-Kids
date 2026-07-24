import type { DirectorConfig, ScreenplayInput, DirectedShot, DirectedEpisode } from "./types.js";
import { validateDirectedEpisode } from "./types.js";
import { canonicalId } from "./promptBuilder.js";
import type { CameraMove, Emotion } from "../types.js";

// ---------------------------------------------------------------------------
// Deterministic offline fallback director.
// ---------------------------------------------------------------------------
// When no LLM endpoint is configured, or the LLM call fails, this director
// produces a valid DirectedEpisode using simple, readable rules:
//
//  - Centre the speaker (rule-of-thirds approximation: single actor at 0.5,
//    two actors at 0.33/0.67 facing each other, 3+ spread evenly).
//  - Face the listener toward the speaker.
//  - Camera: push-in for joy/wonder, locked for everything else.
//  - Pauses: 500ms for joy/wonder, 400ms for sad/afraid/brave, 300ms for neutral.
//  - Animation: derive a pose from scene visual keywords (pray, wave, point, walk).
//  - Dialogue: ONE line per scene, derived from the scene's narration text,
//    spoken by the first character present in that scene.
//
// This never fabricates extra scenes or changes the story — it stages exactly
// what the screenplay provides.

/** Detect emotion from a narration/visual string. */
function detectEmotion(text: string): Emotion {
  const t = text.toLowerCase();
  if (/\b(joy|joyful|happy|glad|rejoice|rejoicing|celebrate|celebrat\w*|laugh|safe|saved|angel|wonder|amazing|wow)\b/.test(t)) {
    return "joy";
  }
  if (/\b(sad|sadly|cry|crying|weep|weeping|tears|afraid|scared|fear|dark|danger)\b/.test(t)) {
    return "sad";
  }
  if (/\b(brave|bravely|braver|courage|courageous|stand|fight|protect)\b/.test(t)) {
    return "brave";
  }
  if (/\b(wonder|wondrous|awe|glory|shine|shining|light|heaven|miracle)\b/.test(t)) {
    return "wonder";
  }
  return "neutral";
}

/** Pick a camera move from the dominant emotion. */
function pickCamera(emotion: Emotion): CameraMove {
  if (emotion === "joy" || emotion === "wonder") return "push-in";
  return "locked";
}

/** Determine pause after a line from its emotion. */
function pauseForEmotion(emotion: Emotion): number {
  switch (emotion) {
    case "joy":
    case "wonder":
      return 500;
    case "sad":
    case "afraid":
      return 400;
    case "brave":
      return 350;
    default:
      return 300;
  }
}

/** Derive a pose/animation clip from text + whether the character is speaking. */
function derivePose(text: string, isSpeaker: boolean): string {
  const t = text.toLowerCase();
  if (isSpeaker) {
    if (/\b(pray|prayed|praying|thank god|worship|praise|praising)\b/.test(t)) return "pray";
    if (/\b(wave|waved|waving|hello|welcome|greet|come)\b/.test(t)) return "wave";
    if (/\b(point|pointed|pointing|look|looked|see|there|behold)\b/.test(t)) return "point";
    if (/\b(walk|walked|walking|go|going|enter|leave|run)\b/.test(t)) return "walk";
  }
  if (/\b(sit|sat|rest|listen|wait)\b/.test(t)) return "sit";
  if (/\b(look up|sky|heaven|star|angel)\b/.test(t)) return "look-up";
  return "neutral";
}

/** Build the animation suggestion reasoning. */
function animationReasoning(pose: string): string {
  const reasons: Record<string, string> = {
    pray: "worship/prayer scene detected",
    wave: "greeting detected in narration",
    point: "directing attention toward something",
    walk: "character movement implied",
    sit: "character at rest",
    "look-up": "wonder/awe moment",
    neutral: "default neutral pose",
  };
  return reasons[pose] ?? "default neutral pose";
}

/**
 * Deterministically direct a screenplay into a staged episode without any LLM.
 *
 * Produces one DirectedShot per scene. Each shot:
 *  - Has actors placed by rule-of-thirds (single=centre, pair=third lines, 3+=even spread).
 *  - Has one dialogue line derived from the scene's narration, spoken by the
 *    first listed character.
 *  - Has camera derived from the scene's emotional content.
 *  - Has animation suggestions, gesture timing, and reaction shots filled in.
 */
export function fallbackDirect(
  input: ScreenplayInput,
  _config: DirectorConfig,
): DirectedEpisode {
  const cast = input.characters.map((c) => {
    const id = canonicalId(c.name);
    return { characterId: id, rigId: `rig:${id}`, voiceId: `voice:${id}` };
  });

  const nameToId = new Map(input.characters.map((c) => [c.name, canonicalId(c.name)]));
  const allCastIds = new Set(cast.map((c) => c.characterId));

  let lineCounter = 0;

  const shots: DirectedShot[] = input.scenes.map((scene, sceneIdx) => {
    // Resolve which characters appear in this scene.
    const sceneNames = scene.characters.length > 0 ? scene.characters : [];
    const sceneCharIds = sceneNames.map((n) => nameToId.get(n) ?? canonicalId(n));

    // Ensure at least one actor: fall back to first cast member.
    const actorIds = sceneCharIds.length > 0
      ? sceneCharIds.filter((id) => allCastIds.has(id))
      : cast.length > 0 ? [cast[0]!.characterId] : [];

    const finalActorIds = actorIds.length > 0 ? actorIds : cast.length > 0 ? [cast[0]!.characterId] : [];
    void sceneNames; // referenced for clarity; actorIds is the source of truth

    // Place actors across the stage.
    const n = finalActorIds.length;
    const actors = finalActorIds.map((id, idx) => {
      let slot: number;
      if (n === 1) {
        slot = 0.5;
      } else {
        // Spread across [0.25, 0.75] using even spacing.
        slot = 0.25 + (0.5 * idx) / (n - 1);
      }
      // Face toward centre (left half faces right, right half faces left).
      const facing = slot <= 0.5 ? "right" as const : "left" as const;
      const isFirst = idx === 0;
      const pose = derivePose(`${scene.visual} ${scene.narration}`, isFirst);
      return {
        characterId: id,
        x: round3(slot),
        y: 0.5,
        scale: isFirst ? 1.15 : 0.95, // speaker prominence
        pose,
        facing,
      };
    });

    // Emotional content of this scene.
    const sceneText = `${scene.narration} ${scene.visual}`;
    const emotion = detectEmotion(sceneText);
    const camera = pickCamera(emotion);
    const pauseMs = pauseForEmotion(emotion);

    // Build one dialogue line from the narration, spoken by the first actor.
    const speakerId = finalActorIds[0] ?? "";
    const lineId = `line-${++lineCounter}`;
    const dialogueText = scene.narration;

    const dialogue = [{
      id: lineId,
      speakerId,
      text: dialogueText,
      emotion,
      pauseAfterMs: pauseMs,
    }];

    // Animation suggestions: one per actor.
    const animationSuggestions = actors.map((a) => ({
      characterId: a.characterId,
      clipId: a.pose,
      reasoning: animationReasoning(a.pose),
    }));

    // Gesture timing: the speaking actor gestures at the start of their line.
    const gestureTiming = [{
      lineId,
      startMs: 0,
      durationMs: Math.min(800, Math.max(400, pauseMs * 2)),
      gesture: actors[0]?.pose ?? "neutral",
    }];

    // Reaction shots: every non-speaking actor reacts.
    const reactionShots = actors
      .filter((a) => a.characterId !== speakerId)
      .map((a) => ({
        characterId: a.characterId,
        triggerLineId: lineId,
        emotion: reactionEmotion(emotion),
      }));

    // Staging rationale.
    const stagingDesc = n === 1
      ? `Single character ${speakerId} centred at (0.5, 0.5) — sole focus of the shot.`
      : `${n} actors placed by rule-of-thirds; speaker ${speakerId} at ${actors[0]?.x} with prominence (scale 1.15), others scaled down to 0.95.`;

    const cameraRationale = camera === "push-in"
      ? `Emotion "${emotion}" detected — push-in to let the emotional moment land.`
      : `Emotion "${emotion}" — locked camera keeps the shot calm and readable for age 3-8.`;

    return {
      id: `shot-${sceneIdx + 1}`,
      settingId: sanitizeSettingId(scene.setting),
      actors,
      leadIn: undefined, // narration becomes dialogue, not a lead-in
      dialogue,
      action: scene.visual,
      camera,
      director: {
        staging: stagingDesc,
        cameraRationale,
        animationSuggestions,
        gestureTiming,
        reactionShots,
      },
    } satisfies DirectedShot;
  });

  const episode: DirectedEpisode = {
    schemaVersion: 2,
    title: input.title,
    source: input.source,
    lesson: input.lesson,
    cast,
    shots,
  };

  return validateDirectedEpisode(episode);
}

/** Map a speaker emotion to a plausible listener reaction. */
function reactionEmotion(speakerEmotion: Emotion): Emotion {
  switch (speakerEmotion) {
    case "joy":
      return "joy";
    case "wonder":
      return "wonder";
    case "sad":
      return "sad";
    case "afraid":
      return "afraid";
    case "brave":
      return "wonder";
    default:
      return "neutral";
  }
}

/** Sanitize a setting enum value into a valid settingId (alphanumeric + dash). */
function sanitizeSettingId(setting: string): string {
  // The v1 setting enum values are all already alphanumeric, so this is a
  // safety net in case of unexpected input.
  return setting.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** Round to 3 decimal places for deterministic output. */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
