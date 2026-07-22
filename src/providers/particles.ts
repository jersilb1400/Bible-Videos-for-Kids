import { config } from "../config.js";

export type ParticleType =
  | "sparkles"
  | "fireflies"
  | "stars"
  | "clouds"
  | "sunbeams"
  | "none";

/**
 * Generate a particle overlay video using FFmpeg's lavfi.
 *
 * Output is a BLACK-background RGB video where bright pixels are the particles.
 * This is paired with `blend=all_mode=screen` in the assemble stage so black
 * pixels stay transparent (no effect on cartoon) and bright pixels ADD light
 * to the cartoon. This avoids the alpha-channel encoder bugs that hit
 * libx264 yuva420p on macOS.
 *
 * Returns the full ffmpeg argument list for creating the overlay video.
 */
export function generateParticleVideo(
  type: ParticleType,
  duration: number,
  outputPath: string,
  width: number = config.width,
  height: number = config.height,
): string[] {
  const d = duration.toFixed(2);
  const w = width;
  const h = height;
  const fps = 30;

  switch (type) {
    case "sparkles":
      // Subtle white sparkle dots — bright on black for overlay-blend
      return [
        "-f", "lavfi", "-i",
        `nullsrc=s=${w}x${h}:d=${d}:r=${fps},` +
        `geq=r='255*(random(1)*sin(2*PI*T*random(1))+0.5)*0.5':` +
        `g='255*(random(1)*sin(2*PI*T*random(1))+0.5)*0.5':` +
        `b='255*(random(1)*sin(2*PI*T*random(1))+0.5)*0.5',` +
        `gblur=sigma=2,` +
        `colorlevels=rimin=0.8:gimin=0.8:bimin=0.8,` +
        `format=yuv420p`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
        "-pix_fmt", "yuv420p",
        outputPath,
      ];

    case "fireflies":
      // Warm yellow-orange fireflies — soft glow on black
      return [
        "-f", "lavfi", "-i",
        `nullsrc=s=${w}x${h}:d=${d}:r=${fps},` +
        `geq=r='255*(random(1)*sin(2*PI*T*random(1))+0.5)*0.8':` +
        `g='200*(random(1)*sin(2*PI*T*random(1))+0.5)*0.8':` +
        `b='80*(random(1)*sin(2*PI*T*random(1))+0.5)*0.6',` +
        `gblur=sigma=5,` +
        `colorlevels=rimin=0.8:gimin=0.8:bimin=0.8,` +
        `format=yuv420p`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
        "-pix_fmt", "yuv420p",
        outputPath,
      ];

    case "stars":
      // Bright white twinkling stars — sharp pinpoints on black
      return [
        "-f", "lavfi", "-i",
        `nullsrc=s=${w}x${h}:d=${d}:r=${fps},` +
        `geq=r='255*(random(1)*pow(sin(2*PI*T*random(1)),4))':` +
        `g='255*(random(1)*pow(sin(2*PI*T*random(1)),4))':` +
        `b='255*(random(1)*pow(sin(2*PI*T*random(1)),4))',` +
        `gblur=sigma=1,` +
        `colorlevels=rimin=0.85:gimin=0.85:bimin=0.85,` +
        `format=yuv420p`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
        "-pix_fmt", "yuv420p",
        outputPath,
      ];

    case "sunbeams":
      // Very subtle warm atmospheric haze — mostly black, sparse soft rays
      return [
        "-f", "lavfi", "-i",
        `nullsrc=s=${w}x${h}:d=${d}:r=${fps},` +
        `geq=r='255*st(1,sin(2*PI*T/6+random(1)*2))*0.08':` +
        `g='220*st(1,sin(2*PI*T/6+random(1)*2))*0.07':` +
        `b='150*st(1,sin(2*PI*T/6+random(1)*2))*0.05',` +
        `gblur=sigma=50,` +
        `colorlevels=rimin=0.92:gimin=0.92:bimin=0.92,` +
        `format=yuv420p`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
        "-pix_fmt", "yuv420p",
        outputPath,
      ];

    default:
      return [];
  }
}

/**
 * Select particle effect based on scene setting and type.
 */
export function selectParticleEffect(setting: string, sceneType: string): ParticleType {
  if (sceneType === "closing" || sceneType === "recap") return "sparkles";
  if (setting === "night") return "stars";
  if (setting === "sunrise") return "sunbeams";
  if (setting === "water" || setting === "indoor") return "fireflies";
  if (sceneType === "hook") return "sunbeams";
  return "none";
}