import { config } from "../config.js";
import { log } from "../logger.js";
import { ffmpeg } from "../providers/ffmpeg.js";
import type { Storage } from "../storage.js";
import { generateMLXMusic, isMLXMusicAvailable, type MusicMood } from "../providers/mlxMusic.js";

/**
 * Local: a soft, gentle C-major pad bed generated with ffmpeg oscillators —
 * pleasant under narration and requires no API. Swap for Suno (or a licensed
 * royalty-free library) in production via MUSIC_PROVIDER=suno.
 */
async function padBed(seconds: number, out: string): Promise<void> {
  const d = seconds.toFixed(2);
  const notes = [261.63, 329.63, 392.0, 523.25]; // C4 E4 G4 C5
  const inputs = notes.flatMap((f) => ["-f", "lavfi", "-i", `sine=frequency=${f}:duration=${d}`]);
  const mix = `${notes.map((_, i) => `[${i}]`).join("")}amix=inputs=${notes.length}:normalize=0,` +
    `tremolo=f=0.25:d=0.4,highpass=f=120,lowpass=f=2200,volume=0.10,` +
    `afade=t=in:st=0:d=2,afade=t=out:st=${Math.max(0, seconds - 2.5).toFixed(2)}:d=2.5`;
  await ffmpeg([...inputs, "-filter_complex", mix, "-c:a", "aac", "-b:a", "128k", out]);
}

/**
 * Map the episode's lesson/source tone to a music mood.
 * Defaults to "warm" — a safe, pleasant bed for children's content.
 */
function inferMood(lesson?: string): MusicMood {
  if (!lesson) return "warm";
  const lower = lesson.toLowerCase();
  if (/celebrat|joy|happy|rejoic/.test(lower)) return "celebration";
  if (/wonder|amaz|discov|new/.test(lower)) return "wonder";
  if (/pray|trust|faith|silent|calm/.test(lower)) return "prayer";
  if (/brave|danger|protect|battle/.test(lower)) return "gentle-tension";
  if (/\bjoy|\bglad|\bsing/.test(lower)) return "joyful";
  return "warm";
}

export async function generateMusic(
  totalSeconds: number,
  storage: Storage,
  opts?: { lesson?: string },
): Promise<string> {
  const provider = config.music.provider;
  log.stage(`6/9  Music  (provider: ${provider})`);
  const out = `${storage.dir("audio")}/music.${provider === "mlx" ? "wav" : "m4a"}`;

  if (provider === "mlx") {
    try {
      const available = await isMLXMusicAvailable();
      if (!available) {
        log.warn("MLX music server not available (set MUSIC_PROVIDER=local for fallback). Using local pad bed.");
        await padBed(totalSeconds + 1, out);
        return out;
      }

      const mood = inferMood(opts?.lesson);
      log.info(`MLX music mood: ${mood}`);
      const result = await generateMLXMusic({
        mood,
        durationSec: Math.min(600, Math.max(10, Math.ceil(totalSeconds + 1))),
        outputPath: out,
      });
      log.ok(`MLX music bed: ${result.durationSec}s (${mood}).`);
      return result.outputPath;
    } catch (err) {
      log.warn(`MLX music failed: ${(err as Error).message}. Falling back to local pad bed.`);
      await padBed(totalSeconds + 1, out);
      return out;
    }
  }

  // Suno integration point: poll its async API, then download to `out`.
  // Currently falls through to local pad bed.
  if (provider === "suno") {
    log.info("Suno provider not yet implemented — using local pad bed");
  }

  // Default: local ffmpeg pad bed
  await padBed(totalSeconds + 1, out);
  log.ok(`Music bed: ${(totalSeconds).toFixed(1)}s.`);
  return out;
}
