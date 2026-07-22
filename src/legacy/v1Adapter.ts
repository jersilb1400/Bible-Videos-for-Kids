import type { Story, Episode, Shot, DialogueLine, CharacterRigRef } from "../types.js";

/**
 * Convert a v1 narration-only Story into a v2 Episode.
 *
 * Each v1 scene becomes one v2 shot. The scene narration moves into `leadIn`.
 * No dialogue is fabricated — all shots are marked `legacy: true` so the v2
 * schema's "non-legacy shots require dialogue" rule is satisfied.
 *
 * Cast is derived from the v1 characters (lowercased, slugified).
 */
export function adaptV1Story(story: Story): Episode {
  const cast: CharacterRigRef[] = story.characters.map((c) => ({
    characterId: slug(c.name),
    rigId: `rig:${slug(c.name)}`,
    voiceId: `voice:${slug(c.name)}`,
  }));

  const castSet = new Set(cast.map((c) => c.characterId));

  const shots: Shot[] = story.scenes.map((scene, i) => {
    const actors = scene.characters
      .map((name) => slug(name))
      .filter((id) => castSet.has(id))
      .map((id) => ({
        characterId: id,
        x: 0.5,
        y: 0.5,
        scale: 1,
        pose: "neutral",
        facing: "right" as const,
      }));

    // Deduplicate actors by characterId (v1 may list the same character twice)
    const seen = new Set<string>();
    const uniqueActors = actors.filter((a) => {
      if (seen.has(a.characterId)) return false;
      seen.add(a.characterId);
      return true;
    });

    return {
      id: `shot-${i + 1}`,
      settingId: `setting:${scene.setting}`,
      actors: uniqueActors.length > 0 ? uniqueActors : [{ characterId: cast[0]!.characterId, x: 0.5, y: 0.5, scale: 1, pose: "neutral", facing: "right" as const }],
      leadIn: { text: scene.narration, pauseAfterMs: 400 },
      dialogue: [] as DialogueLine[],
      action: "[legacy v1 narration-only shot]",
      camera: "locked" as const,
      legacy: true,
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

/** Simple slugifier for character names → IDs */
function slug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}
