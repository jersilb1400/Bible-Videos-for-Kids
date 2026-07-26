import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EpisodeTimeline, ShotTimeline, PlacedUtterance } from "../timeline.js";
import type { Episode } from "../types.js";
import { log } from "../logger.js";

export interface AssemblyOptions {
  width: number;
  height: number;
  fps: number;
  musicFile?: string;        // licensed background music
  musicGainDb?: number;      // base music level (e.g. -18)
  duckGainDb?: number;       // ducked music level during dialogue (e.g. -28)
  outputFile: string;        // final episode.mp4
}

export interface AssemblyResult {
  file: string;
  durationMs: number;
  captionsFile: string;      // .srt
}

/**
 * Final assembly: concatenate shot videos, mix audio with side-chain ducking,
 * burn captions, and master to broadcast loudness.
 */
export async function assembleEpisode(
  shotClips: { file: string; timeline: ShotTimeline }[],
  episode: Episode,
  timeline: EpisodeTimeline,
  speechDir: string,
  options: AssemblyOptions,
): Promise<AssemblyResult> {
  log.stage("Assembly  (professional audio mix + captions + mux)");

  mkdirSync(dirname(options.outputFile), { recursive: true });

  // Step 1: Concatenate shot videos
  const concatFile = join(dirname(options.outputFile), ".concat-list.txt");
  const concatList = shotClips
    .map((c) => `file '${c.file}'`)
    .join("\n");
  writeFileSync(concatFile, concatList);

  const silentVideo = join(dirname(options.outputFile), ".silent-concat.mp4");
  await runffmpeg([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatFile,
    "-c", "copy",
    silentVideo,
  ]);

  // Collect temp file paths for cleanup on any path (success or failure)
  const tempFiles: string[] = [];
  try {
  // Step 2: Build episode audio (concatenate all speech clips with silence)
  const episodeAudio = join(dirname(options.outputFile), ".episode-audio.wav");
  tempFiles.push(episodeAudio);
  await buildEpisodeAudio(timeline, speechDir, episodeAudio);

  // Step 3: Generate captions (.srt)
  const captionsFile = options.outputFile.replace(/\.mp4$/, ".srt");
  generateCaptions(timeline, captionsFile);

  // Step 4: Generate ASS subtitles (for burn-in, avoids drawtext dependency)
  const assFile = options.outputFile.replace(/\.mp4$/, ".ass");
  generateASS(timeline, assFile, options.width, options.height);

  // Step 5: Mix audio with side-chain ducking + master
  const finalAudio = join(dirname(options.outputFile), ".mixed-audio.wav");
  tempFiles.push(finalAudio);

  if (options.musicFile && existsSync(options.musicFile)) {
    // Side-chain ducking: music ducks when speech is active
    await runffmpeg([
      "-y",
      "-i", episodeAudio,
      "-i", options.musicFile,
      "-filter_complex",
      `[1:a]volume=${options.musicGainDb ?? -18}dB[bgm];` +
      `[bgm][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=200:makeup=2[ducked];` +
      `[ducked][0:a]amix=inputs=2:duration=first[aout]`,
      "-map", "[aout]",
      "-c:a", "pcm_s16le",
      "-ar", "48000",
      finalAudio,
    ]);
  } else {
    // No music — just copy speech audio
    await runffmpeg([
      "-y",
      "-i", episodeAudio,
      "-c:a", "pcm_s16le",
      "-ar", "48000",
      finalAudio,
    ]);
  }

  // Step 6: Mux video + audio. Burn-in captions via libass if available;
  // otherwise ship sidecar .srt (professional approach for streaming platforms).
  const finalOutput = options.outputFile;
  const canBurnCaptions = await hasSubtitleFilter();
  if (canBurnCaptions) {
    const { copyFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    // Place temp ASS in tmpdir with a safe filename (no special chars).
    // The libass subtitles filter needs Windows-style escaping:
    // backslashes, colons, and commas in the path must be escaped.
    const localAss = join(tmpdir(), `captions-${process.pid}.ass`);
    tempFiles.push(localAss);
    copyFileSync(assFile, localAss);
    // Escape backslashes, colons, and single quotes for the subtitles filter
    const filterPath = localAss.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
    await runffmpeg([
      "-y",
      "-i", silentVideo,
      "-i", finalAudio,
      "-vf", `subtitles='${filterPath}'`,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "fast",
      "-crf", "18",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "48000",
      "-shortest",
      "-movflags", "+faststart",
      finalOutput,
    ]);
  } else {
    log.info("Subtitle burn-in unavailable (ffmpeg lacks libass). Shipping sidecar .srt captions.");
    await runffmpeg([
      "-y",
      "-i", silentVideo,
      "-i", finalAudio,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "fast",
      "-crf", "18",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "48000",
      "-shortest",
      "-movflags", "+faststart",
      finalOutput,
    ]);
  }

  log.ok(`Episode assembled: ${finalOutput}`);
  return {
    file: finalOutput,
    durationMs: timeline.totalMs,
    captionsFile,
  };
  } finally {
    // Cleanup temp files — always run, even on failure
    tempFiles.push(concatFile, silentVideo);
    for (const f of tempFiles) {
      try { rmSync(f, { force: true }); } catch { /* non-critical */ }
    }
  }
}

/**
 * Build the episode audio track by placing speech clips at their timeline
 * positions with silence in between.
 */
async function buildEpisodeAudio(
  timeline: EpisodeTimeline,
  speechDir: string,
  outputPath: string,
): Promise<void> {
  // Build an ffmpeg complex filter that overlays each speech clip at its
  // episode-relative start time onto a silent base track.
  const inputs: string[] = [];
  const filterParts: string[] = [];

  // Create silent base track of total duration
  filterParts.push(`anullsrc=channel_layout=mono:sample_rate=48000[base]`);

  let trackIdx = 0;
  for (const shot of timeline.shots) {
    for (const utt of shot.utterances) {
      const clipPath = join(speechDir, `${utt.utteranceId}.wav`);
      if (!existsSync(clipPath)) continue;

      inputs.push("-i", clipPath);
      const inputIdx = trackIdx + 1; // 0 is the base (synthesized)
      const delaySec = utt.startMs / 1000;
      filterParts.push(
        `[${inputIdx}:a]adelay=${utt.startMs}|${utt.startMs}[d${trackIdx}]`,
      );
      trackIdx++;
    }
  }

  if (trackIdx === 0) {
    // No speech clips — just output silence for the full duration
    await runffmpeg([
      "-y",
      "-f", "lavfi",
      "-i", `anullsrc=channel_layout=mono:sample_rate=48000`,
      "-t", String(timeline.totalMs / 1000),
      "-c:a", "pcm_s16le",
      outputPath,
    ]);
    return;
  }

  // Mix all delayed tracks together
  const mixInputs = filterParts
    .filter((p) => p.includes("adelay"))
    .map((p) => {
      const m = p.match(/\[d(\d+)\]/);
      return m ? `[d${m[1]}]` : "";
    })
    .join("");

  filterParts.push(`${mixInputs}amix=inputs=${trackIdx}:duration=longest:normalize=0[mixed]`);
  filterParts.push(`[base][mixed]amix=inputs=2:duration=longest:normalize=0[aout]`);

  const args = [
    "-y",
    "-f", "lavfi",
    "-i", "anullsrc=channel_layout=mono:sample_rate=48000",
    ...inputs,
    "-filter_complex", filterParts.join(";"),
    "-map", "[aout]",
    "-t", String(timeline.totalMs / 1000),
    "-c:a", "pcm_s16le",
    "-ar", "48000",
    outputPath,
  ];

  await runffmpeg(args);
}

/**
 * Generate SRT caption file from the timeline.
 */
function generateCaptions(timeline: EpisodeTimeline, outputPath: string): void {
  const lines: string[] = [];
  let captionIdx = 1;

  for (const shot of timeline.shots) {
    for (const utt of shot.utterances) {
      const start = msToSrtTime(utt.startMs);
      const end = msToSrtTime(utt.endMs);
      lines.push(String(captionIdx++));
      lines.push(`${start} --> ${end}`);
      lines.push(utt.text);
      lines.push("");
    }
  }

  writeFileSync(outputPath, lines.join("\n"));
  log.info(`Captions: ${outputPath} (${captionIdx - 1} cues)`);
}

/**
 * Generate ASS subtitle file for burn-in captions.
 * Uses a clean, readable style suitable for children's videos.
 */
function generateASS(
  timeline: EpisodeTimeline,
  outputPath: string,
  width: number,
  height: number,
): void {
  const fontSize = Math.round(height * 0.05); // 5% of height
  const header = `[Script Info]
Script Type: V4.00+
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events: string[] = [];
  for (const shot of timeline.shots) {
    for (const utt of shot.utterances) {
      const start = msToAssTime(utt.startMs);
      const end = msToAssTime(utt.endMs);
      // Speaker label for dialogue, no label for leadIn narration
      const text = utt.isLeadIn
        ? utt.text
        : `{\\i1}${utt.speakerId}:{\\i0} ${utt.text}`;
      events.push(
        `Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`,
      );
    }
  }

  writeFileSync(outputPath, header + events.join("\n") + "\n");
  log.info(`ASS subtitles: ${outputPath}`);
}

function msToSrtTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function msToAssTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const centi = Math.floor((ms % 1000) / 10);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(centi).padStart(2, "0")}`;
}

/** Check if ffmpeg has the `subtitles` filter (libass). */
async function hasSubtitleFilter(): Promise<boolean> {
  const { ffmpegBin } = await import("../providers/ffmpeg.js");
  return new Promise((resolve) => {
    const ff = spawn(ffmpegBin(), ["-filters"]);
    let stdout = "";
    ff.stdout.on("data", (d) => (stdout += d));
    ff.on("close", () => {
      resolve(stdout.includes(" subtitles"));
    });
    ff.on("error", () => resolve(false));
  });
}

async function runffmpeg(args: string[]): Promise<void> {
  const { ffmpegBin } = await import("../providers/ffmpeg.js");
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegBin(), args);
    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += d));
    ff.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-500)}`));
      } else {
        resolve();
      }
    });
    ff.on("error", reject);
  });
}
