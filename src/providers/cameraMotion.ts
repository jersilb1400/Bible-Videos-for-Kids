import { config } from "../config.js";

export type CameraEffect =
  | "zoom-in"
  | "zoom-out"
  | "pan-left"
  | "pan-right"
  | "pan-up"
  | "pan-down"
  | "drift"
  | "crossfade"
  | "static";

export interface CameraMotionParams {
  effect: CameraEffect;
  /** Duration in seconds */
  duration: number;
  /** Zoom intensity (0.02-0.15). Higher = more dramatic zoom */
  zoomIntensity?: number;
  /** Pan distance in pixels (higher = faster pan) */
  panDistance?: number;
}

/**
 * Build an FFmpeg filter for cinematic camera motion over a static image.
 *
 * Effects:
 * - zoom-in: Slow zoom into the image (dramatic establishing shot)
 * - zoom-out: Slow pull-back reveal (establishing)
 * - pan-left/right/up/down: Slow horizontal/vertical scroll
 * - drift: Gentle floating motion (magical, dreamy)
 * - static: No motion
 */
export function cameraMotionFilter(
  params: CameraMotionParams,
  imageWidth: number = config.width,
  imageHeight: number = config.height,
): {
  filter: string;
  label: string;
} {
  const safeDuration = Math.max(params.duration, 0.5);
  const d = safeDuration.toFixed(2);
  const w = imageWidth;
  const h = imageHeight;
  const label = "[cam]";
  const fps = config.fps;

  switch (params.effect) {
    case "zoom-in": {
      const zi = (params.zoomIntensity ?? 0.08).toFixed(3);
      const endScale = (1 + parseFloat(zi)).toFixed(3);
      const ratePerFrame = (parseFloat(zi) / safeDuration / (fps || 30)).toFixed(6);
      return {
        filter: `zoompan=z='min(zoom+${ratePerFrame},${endScale})':d=${d}:x=${w / 2}:y=${h / 2}:s=${w}x${h},fps=${fps}${label}`,
        label,
      };
    }

    case "zoom-out": {
      const zi = (params.zoomIntensity ?? 0.08).toFixed(3);
      const startScale = (1 + parseFloat(zi)).toFixed(3);
      const ratePerFrame = (parseFloat(zi) / safeDuration / (fps || 30)).toFixed(6);
      return {
        filter: `zoompan=z='max(zoom-${ratePerFrame},1.0)':d=${d}:x=${w / 2}:y=${h / 2}:s=${w}x${h},fps=${fps}${label}`,
        label,
      };
    }

    case "pan-left": {
      const dist = params.panDistance ?? w * 0.25;
      const dx = (dist / safeDuration / (fps || 30)).toFixed(1);
      return {
        filter: `zoompan=z='1.1':x='${(w / 2).toFixed(0)}-on*${dx}':y=${h / 2}:d=${d}:s=${w}x${h},fps=${fps}${label}`,
        label,
      };
    }

    case "pan-right": {
      const dist = params.panDistance ?? w * 0.25;
      const dx = (dist / safeDuration / (fps || 30)).toFixed(1);
      return {
        filter: `zoompan=z='1.1':x='${(w / 2).toFixed(0)}+on*${dx}':y=${h / 2}:d=${d}:s=${w}x${h},fps=${fps}${label}`,
        label,
      };
    }

    case "pan-up": {
      const dist = params.panDistance ?? h * 0.2;
      const dy = (dist / safeDuration / (fps || 30)).toFixed(1);
      return {
        filter: `zoompan=z='1.1':x=${w / 2}:y='${(h / 2).toFixed(0)}-on*${dy}':d=${d}:s=${w}x${h},fps=${fps}${label}`,
        label,
      };
    }

    case "pan-down": {
      const dist = params.panDistance ?? h * 0.2;
      const dy = (dist / safeDuration / (fps || 30)).toFixed(1);
      return {
        filter: `zoompan=z='1.1':x=${w / 2}:y='${(h / 2).toFixed(0)}+on*${dy}':d=${d}:s=${w}x${h},fps=${fps}${label}`,
        label,
      };
    }

    case "drift": {
      const zoomAmp = "0.03";
      const xAmp = (w * 0.02).toFixed(0);
      const yAmp = (h * 0.02).toFixed(0);
      return {
        filter:
          `zoompan=z='1+${zoomAmp}*sin(2*PI*on/${d}/4)':d=${d}:` +
          `x=${w / 2}+${xAmp}*sin(2*PI*on/${d}/8):` +
          `y=${h / 2}+${yAmp}*sin(2*PI*on/${d}/6):` +
          `s=${w}x${h},fps=${fps}${label}`,
        label,
      };
    }

    default:
      return {
        filter: `scale=${w}:${h},fps=${fps}${label}`,
        label,
      };
  }
}

/**
 * Select a camera effect based on scene type and position.
 * Creates visual variety across the episode.
 */
export function selectCameraEffect(
  sceneType: string,
  sceneIndex: number,
  totalScenes: number,
): CameraEffect {
  if (sceneIndex === 0 || sceneType === "hook") return "zoom-in";
  if (sceneIndex === totalScenes - 1 || sceneType === "closing") return "zoom-out";
  if (sceneType === "premium") return "drift";
  if (sceneType === "recap") return "static";

  const panOptions: CameraEffect[] = ["pan-left", "pan-right", "pan-up", "pan-down"];
  const idx = sceneIndex % panOptions.length;
  return panOptions[idx] ?? "pan-left";
}