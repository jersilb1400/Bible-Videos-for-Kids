import type { Scene } from "../types.js";

/**
 * Build a cartoon-optimized FLUX prompt for a scene.
 * Targets Pixar-like 3D aesthetic with consistent character styling.
 */
export function buildScenePrompt(
  scene: Scene,
  characters: { name: string; description: string }[],
  episodeTitle: string,
): string {
  const cast = characters
    .filter((c) => scene.characters.includes(c.name))
    .map((c) => `${c.name}: ${c.description}`)
    .join("; ");

  const styleDirective =
    "Pixar-style 3D animation, children's Bible illustration, " +
    "soft rounded shapes, warm studio lighting, subsurface scattering, " +
    "expressive friendly faces, gentle pastel color palette, " +
    "high detail, volumetric lighting, depth of field, " +
    "cinematic composition, 4K, 3D render style";

  const sceneDesc = scene.visual;

  const lightingMap: Record<string, string> = {
    day: "bright sunny outdoor lighting, warm golden hour",
    night: "moonlit night scene, soft blue ambient light, stars",
    sunrise: "warm golden sunrise light, soft pink and orange sky",
    indoor: "warm interior lighting, soft window light, cozy atmosphere",
    water: "bright reflective water surface, caustic light patterns",
    desert: "warm desert sunlight, golden sand, clear sky",
  };
  const lighting = lightingMap[scene.setting] || "warm pleasant lighting";

  return `${styleDirective}. ${sceneDesc}. ${lighting}. Characters: ${cast}. Episode: ${episodeTitle}. No text, no watermarks, no frame borders.`;
}

/**
 * Build a simpler prompt for fallback scenes (filler, transitions).
 */
export function buildFillerPrompt(scene: Scene, episodeTitle: string): string {
  return (
    `Pixar-style children's Bible illustration. ${scene.visual}. ` +
    `Warm colors, soft shapes, friendly. ${episodeTitle}. No text, no watermarks.`
  );
}