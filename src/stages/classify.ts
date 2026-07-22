import { log } from "../logger.js";
import type { Story } from "../types.js";

export interface SceneClassification {
  /** Indices of scenes to animate with Wan 2.1 (premium, hook). */
  premium: number[];
  /** Indices of scenes to animate with cinematic camera motion + particles (filler, recap, closing). */
  filler: number[];
  /** Index of the opening hook scene. */
  hook: number;
  /** Index of the lesson recap scene. */
  recap: number;
  /** Index of the closing card scene. */
  closing: number;
}

/**
 * Validates and classifies scenes by animation tier.
 * Ensures we have at least 15 premium scenes for the hybrid model.
 * If the LLM output is malformed, re-classifies based on heuristics.
 */
export function classifyScenes(story: Story): SceneClassification {
  const premium: number[] = [];
  const filler: number[] = [];
  let hook = -1;
  let recap = -1;
  let closing = -1;

  for (let i = 0; i < story.scenes.length; i++) {
    const scene = story.scenes[i]!;
    switch (scene.sceneType) {
      case "hook":
        if (hook === -1) hook = i;
        premium.push(i); // hooks are always animated
        break;
      case "premium":
        premium.push(i);
        break;
      case "recap":
        if (recap === -1) recap = i;
        premium.push(i); // recaps are premium animation
        break;
      case "closing":
        if (closing === -1) closing = i;
        filler.push(i); // closing card uses cinematic motion + particles
        break;
      case "filler":
        filler.push(i);
        break;
      default:
        // Unrecognized type — treat as filler
        filler.push(i);
        break;
    }
  }

  // Heuristic fallback: if too few premium scenes, promote early filler scenes
  if (premium.length < 10 && filler.length > 0) {
    log.warn(
      `Only ${premium.length} premium scenes found (need ≥10). Promoting top filler scenes to premium.`,
    );
    const needed = 10 - premium.length;
    const promoted = filler.splice(0, Math.min(needed, filler.length));
    premium.push(...promoted);
  }

  // Hook fallback: use first premium scene
  if (hook === -1 && premium.length > 0) {
    hook = premium[0]!;
    log.warn("No hook scene tagged — using first premium scene as hook.");
  }
  // Recap fallback: use last premium scene
  if (recap === -1 && premium.length > 1) {
    recap = premium[premium.length - 1]!;
    log.warn("No recap scene tagged — using last premium scene as recap.");
  }
  // Closing fallback: use last filler scene
  if (closing === -1) {
    if (filler.length > 0) {
      closing = filler[filler.length - 1]!;
    } else {
      closing = premium[premium.length - 1] ?? story.scenes.length - 1;
    }
    log.warn("No closing scene tagged — using last scene as closing.");
  }

  log.info(
    `Classification: ${premium.length} premium (wan), ${filler.length} filler (cinematic-motion), hook=#${hook}, recap=#${recap}, closing=#${closing}`,
  );

  return { premium, filler, hook, recap, closing };
}