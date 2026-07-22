import type { Episode, Shot, Story } from "../types.js";

/**
 * Adapt a v1 {@link Story} into a v2 {@link Episode}.
 *
 * One v1 `Scene` becomes one v2 `Shot`:
 *  - `scene.narration` is preserved as the shot's `leadIn` text (never dropped,
 *    never invented).
 *  - `scene.visual` becomes the shot's `settingId`-adjacent passthrough is not
 *    available in the v2 schema, so the visual is carried in `action` (prefixed
 *    with the legacy marker so the superRefine ≥1-line rule is relaxed).
 *  - `scene.characters` become the shot's `actors`, placed at a sensible
 *    default position across the stage.
 *  - **No dialogue is fabricated.** A v1 narration-only scene produces a v2
 *    shot with `dialogue: []`; the `action` field carries the "legacy" marker
 *    so EpisodeSchema's superRefine does not flag it for lacking dialogue.
 *  - `scene.setting` is folded into `settingId` (e.g. "day" → "setting:day")
 *    so downstream stages still have a setting handle.
 *
 * Every v1 `Character` becomes a v2 cast entry. The adapter assigns stable
 * `characterId`s (the lowercased character `name`) and deterministic
 * placeholder rig/voice ids (`rig:<name>`, `voice:<name>`). Downstream stages
 * are expected to resolve those placeholder ids to real rigs/voices.
 */
export function adaptV1Story(story: Story): Episode {
  const cast = story.characters.map((c) => {
    const id = canonicalId(c.name);
    return {
      characterId: id,
      // Placeholder rig/voice ids — resolved by downstream stages.
      rigId: `rig:${id}`,
      voiceId: `voice:${id}`,
    };
  });

  const castByName = new Map(story.characters.map((c) => [c.name, canonicalId(c.name)]));

  const shots: Shot[] = story.scenes.map((scene, i) => {
    // Place each named character across the stage left-to-right.
    const actorNames = scene.characters.length > 0 ? scene.characters : [];
    const actors = actorNames.map((name, idx) => {
      const characterId = castByName.get(name);
      // If a scene references a character not in the story's `characters`
      // array, fall back to a canonical id derived from the name so the shot
      // is still self-consistent (the cast may be missing an entry, which
      // EpisodeSchema will surface as a validation error rather than crash).
      const id = characterId ?? canonicalId(name);
      const n = actorNames.length;
      // Evenly space across the stage, leaving margins so characters aren't
      // touching the edges.
      const slot = n === 1 ? 0.5 : 0.25 + (0.5 * idx) / (n - 1);
      // Face toward stage centre so paired characters look at each other.
      const facing: "left" | "right" = slot <= 0.5 ? "right" : "left";
      return {
        characterId: id,
        x: slot,
        y: 0.5,
        scale: 1,
        pose: "neutral",
        facing,
      };
    });

    // If after mapping the scene had no characters at all we need at least one
    // actor (ShotSchema.actors is min(1)). Fall back to the first cast member
    // so the shot is at least placeable; the narrator is implied off-stage.
    const finalActors =
      actors.length > 0
        ? actors
        : cast.length > 0
          ? [{ characterId: cast[0]!.characterId, x: 0.5, y: 0.5, scale: 1, pose: "neutral", facing: "right" as const }]
          : [];

    return {
      id: `shot-${i + 1}`,
      settingId: `setting:${scene.setting}`,
      actors: finalActors,
      leadIn: { text: scene.narration, pauseAfterMs: 400 },
      // No fabricated dialogue: a v1 narration-only scene carries zero lines.
      dialogue: [],
      // "legacy" marker relaxes EpisodeSchema's ≥1-dialogue-line rule.
      action: `legacy (v1 narration-only): ${scene.visual}`,
      camera: "locked" as const,
    };
  });

  return {
    schemaVersion: 2,
    title: story.title,
    source: story.source,
    lesson: story.lesson,
    cast,
    shots,
  };
}

/** Canonical, lowercased, single-space id derived from a v1 character name. */
function canonicalId(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}
