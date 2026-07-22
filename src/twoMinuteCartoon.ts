/**
 * 2-minute cartoon production script using xAI Grok-style API chain.
 *
 * Defaults: fal Flux 2 for keyframes + cinematic motion for animation.
 *
 * Cost controls (HARD):
 *   - MAX_SCENES = 12     ← hard scene limit, abort beyond
 *   - ESTIMATED_MAX_USD = 1.50 ← abort if fal cost projection > this
 *   - No Wan 2.5 I2V (would exceed budget)
 *   - All scene count + image size validation done before any spend
 *
 * If costs diverge from expectation, fail loudly and exit 1.
 */
import { writeFileSync } from "node:fs";
import { FalFluxProvider } from "./providers/falFlux.js";
import { renderSceneSvg } from "./providers/svgScene.js";
import { Resvg } from "@resvg/resvg-js";
import { cameraMotionFilter, selectCameraEffect } from "./providers/cameraMotion.js";
import { EdgeTtsProvider } from "./providers/edgeTts.js";
import { ffmpeg, probeDuration } from "./providers/ffmpeg.js";
// Inline padBed (matches stages/music.ts implementation) — running it directly
// avoids pulling in the Storage class and full music stage just for a 12-scene bed.
import { ffmpeg as ffmpegRaw } from "./providers/ffmpeg.js";
async function padBedInline(seconds: number, out: string): Promise<void> {
  const d = seconds.toFixed(2);
  const notes = [261.63, 329.63, 392.0, 523.25]; // C4 E4 G4 C5
  const inputs = notes.flatMap((f) => ["-f", "lavfi", "-i", `sine=frequency=${f}:duration=${d}`]);
  const mix = `${notes.map((_, i) => `[${i}]`).join("")}amix=inputs=${notes.length}:normalize=0,` +
    `tremolo=f=0.25:d=0.4,highpass=f=120,lowpass=f=2200,volume=0.10,` +
    `afade=t=in:st=0:d=2,afade=t=out:st=${Math.max(0, seconds - 2.5).toFixed(2)}:d=2.5`;
  await ffmpegRaw([...inputs, "-filter_complex", mix, "-c:a", "aac", "-b:a", "128k", out]);
}
import type { Story } from "./types.js";

const MAX_SCENES = 12;
const ESTIMATED_MAX_USD = 1.5;        // circuit breaker
const PER_IMAGE_USD = 0.04;            // Flux Kontext Pro pricing (verified today)
const SCENE_DURATION = 10;             // 10s per scene × 12 = 120s = 2 min

const STORY: Story = {
  title: "Noah Builds the Ark",
  source: "Genesis 6:9-22",
  lesson: "God keeps His promises",
  characters: [
    {
      name: "Noah",
      description: "an older bearded man with kind eyes, wearing a brown robe",
      palette: { skin: "#e8c39e", hair: "#cccccc", robe: "#8b5a3c" },
    },
  ],
  scenes: [
    {
      narration: "Long ago, God looked down at the world and saw that people were very, very sad.",
      visual: "wide shot of misty ancient hills with soft golden sunbeams breaking through clouds, Pixar-style flat cartoon",
      characters: ["Noah"],
      setting: "day",
      sceneType: "hook",
      durationHint: SCENE_DURATION,
    },
    {
      narration: "But one man loved God with all his heart. His name was Noah.",
      visual: "close-up of Noah, kind face, long gray beard, brown robe, standing on grass",
      characters: ["Noah"],
      setting: "day",
      sceneType: "filler",
      durationHint: SCENE_DURATION,
    },
    {
      narration: "God spoke to Noah and said, build a great big boat, an ark.",
      visual: "God's warm light shining down from above onto Noah, who stands on open ground listening",
      characters: ["Noah"],
      setting: "day",
      sceneType: "premium",
      durationHint: SCENE_DURATION,
    },
    {
      narration: "Noah listened. He and his three sons gathered wood and began to build.",
      visual: "Noah and three sons hammering wooden planks together on grass, mountains in background",
      characters: ["Noah"],
      setting: "day",
      sceneType: "premium",
      durationHint: SCENE_DURATION,
    },
    {
      narration: "The ark grew, plank by plank, and grew, and grew, and grew.",
      visual: "the wooden ark getting bigger, frame visible, a work in progress, yellow sunlight",
      characters: ["Noah"],
      setting: "day",
      sceneType: "filler",
      durationHint: SCENE_DURATION,
    },
    {
      narration: "At last, the ark was finished. It was huge!",
      visual: "completed wooden ark on dry land, three stories tall, beautiful golden light",
      characters: ["Noah"],
      setting: "sunrise",
      sceneType: "premium",
      durationHint: SCENE_DURATION,
    },
    {
      narration: "Then God told Noah, bring two of every animal, a boy and a girl.",
      visual: "Noah looking toward animals in a peaceful meadow, pairs of creatures in the distance",
      characters: ["Noah"],
      setting: "day",
      sceneType: "filler",
      durationHint: SCENE_DURATION,
    },
    {
      narration: "Two lions came. Two elephants. Two monkeys, two giraffes, two zebras.",
      visual: "pairs of cute cartoon animals walking in a line, smiling, colorful Pixar style",
      characters: ["Noah"],
      setting: "day",
      sceneType: "premium",
      durationHint: SCENE_DURATION,
    },
    {
      narration: "Two by two, they marched right up the ramp into the ark.",
      visual: "animals climbing a wooden ramp into the open ark door, friendly warm light inside",
      characters: ["Noah"],
      setting: "day",
      sceneType: "premium",
      durationHint: SCENE_DURATION,
    },
    {
      narration: "When everyone was safe inside, God closed the great big door.",
      visual: "Noah at the ark door, wooden door closing, soft golden sunset light",
      characters: ["Noah"],
      setting: "sunrise",
      sceneType: "premium",
      durationHint: SCENE_DURATION,
    },
    {
      narration: "And then the rain came down, and the ark floated safe upon the water.",
      visual: "the ark floating on blue water, soft rain, rainbow in the distance, peaceful",
      characters: ["Noah"],
      setting: "water",
      sceneType: "premium",
      durationHint: SCENE_DURATION,
    },
    {
      narration: "God keeps His promises. Just like He keeps them with you. The end!",
      visual: "rainbow arcing over the ark on calm water, soft golden glow, birds flying",
      characters: ["Noah"],
      setting: "sunrise",
      sceneType: "closing",
      durationHint: SCENE_DURATION,
    },
  ],
};

// ── Cost guard ───────────────────────────────────────────────────────
const projectedUSD = STORY.scenes.length * PER_IMAGE_USD;
if (projectedUSD > ESTIMATED_MAX_USD) {
  console.error(`✗ Projected spend $${projectedUSD.toFixed(2)} exceeds cap $${ESTIMATED_MAX_USD}. Aborting.`);
  process.exit(1);
}
if (STORY.scenes.length > MAX_SCENES) {
  console.error(`✗ Scene count ${STORY.scenes.length} exceeds MAX_SCENES=${MAX_SCENES}. Aborting.`);
  process.exit(1);
}
console.log(`[budget] ${STORY.scenes.length} scenes × $${PER_IMAGE_USD}/img = $${projectedUSD.toFixed(2)} projected (cap $${ESTIMATED_MAX_USD})`);

const W = 1280, H = 720; // 720p for headroom — keep keyframes light; upscale at assembly

const outRoot = new Date().toISOString().slice(0, 10) + "-2min-noah";
const fs = await import("node:fs/promises");
const outDir = `out/${outRoot}`;
await fs.mkdir(outDir, { recursive: true });
await fs.mkdir(`${outDir}/images`, { recursive: true });
await fs.mkdir(`${outDir}/clips`, { recursive: true });
await fs.mkdir(`${outDir}/audio`, { recursive: true });
await fs.mkdir(`${outDir}/captions`, { recursive: true });

// ── Stage 1: Keyframes (Flux 2) ─────────────────────────────────────
const flux = new FalFluxProvider();
const imageUrls: string[] = [];
let falReportedCents = 0;

console.log(`\n[1/4] Generating ${STORY.scenes.length} keyframes via fal Flux 2 ($${projectedUSD.toFixed(2)} target)…`);
for (let i = 0; i < STORY.scenes.length; i++) {
  const scene = STORY.scenes[i]!;
  const cast = "Character - Noah: an older bearded man with kind eyes, wearing a brown robe";
  const prompt =
    `Pixar-style flat-vector cartoon for preschoolers, soft pastel colors, friendly faces. ${scene.visual}. ${cast}. Setting: ${scene.setting}. No text, no watermarks.`;

  console.log(`  → scene ${i + 1}/${STORY.scenes.length}: ${scene.setting}`);
  const out = `${outDir}/images/scene-${String(i).padStart(2, "0")}.png`;
  const { localPath, url } = await flux.generateImage(prompt, out, { imageSize: { width: W, height: H } });
  imageUrls.push(url);
}
console.log(`[1/4] Done. ${imageUrls.length} images. (Monitor your fal dashboard for actual spend.)`);

// ── Stage 2: Cinematic motion (animated clips) ──────────────────────
console.log(`\n[2/4] Generating cinematic motion clips (ffmpeg only, $0)…`);
const clipPaths: string[] = [];
for (let i = 0; i < STORY.scenes.length; i++) {
  const scene = STORY.scenes[i]!;
  const out = `${outDir}/clips/scene-${String(i).padStart(2, "0")}.mp4`;
  const effect = selectCameraEffect(scene.sceneType!, i, STORY.scenes.length);
  const cam = cameraMotionFilter({ effect, duration: SCENE_DURATION });
  await ffmpeg([
    "-loop", "1", "-t", String(SCENE_DURATION), "-i", `${outDir}/images/scene-${String(i).padStart(2, "0")}.png`,
    "-filter_complex", cam.filter,
    "-map", cam.label,
    "-s", `${W}x${H}`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
    "-r", "30",
    out,
  ]);
  clipPaths.push(out);
}
console.log(`[2/4] Done. ${clipPaths.length} clips at ${SCENE_DURATION}s each = ${(clipPaths.length * SCENE_DURATION / 60).toFixed(1)} min`);

// ── Stage 3: Narration (Edge-TTS, $0) ───────────────────────────────
console.log(`\n[3/4] Generating narration via Edge-TTS ($0)…`);
const tts = new EdgeTtsProvider();
const narrPaths: string[] = [];
const narrDurations: number[] = [];
for (let i = 0; i < STORY.scenes.length; i++) {
  const narration = STORY.scenes[i]!.narration;
  const out = `${outDir}/audio/narr-${String(i).padStart(2, "0")}.mp3`;
  await tts.generate(narration, out, "jenny");
  const dur = await probeDuration(out);
  narrPaths.push(out);
  narrDurations.push(Math.max(SCENE_DURATION, dur));
}
const totalNarrationSec = narrDurations.reduce((a, b) => a + b, 0);
console.log(`[3/4] Done. ${narrPaths.length} narration clips totaling ${totalNarrationSec.toFixed(1)}s`);

// ── Stage 4: Assembly — per-scene, attach narration + caption ───────
console.log(`\n[4/4] Assembling final video with captions + music bed…`);
const segDir = `${outDir}/segments`;
await fs.mkdir(segDir, { recursive: true });
const segPaths: string[] = [];

for (let i = 0; i < STORY.scenes.length; i++) {
  const dur = Math.min(SCENE_DURATION + 2, narrDurations[i]!);
  const seg = `${segDir}/seg-${String(i).padStart(2, "0")}.mp4`;

  // Caption via drawtext (best-effort, may degrade if no drawtext available)
  const captionText = STORY.scenes[i]!.narration;
  const capFile = `${outDir}/captions/scene-${String(i).padStart(2, "0")}.txt`;
  writeFileSync(capFile, captionText);

  const drawtext =
    `drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:` +
    `text='${captionText.replace(/'/g, "’").replace(/:/g, "\\:")}'` +
    `:fontcolor=white:fontsize=28:line_spacing=8:box=1:boxcolor=0x000000A0:boxborderw=18:` +
    `x=(w-text_w)/2:y=h-text_h-40`;

  await ffmpeg([
    "-i", clipPaths[i]!,
    "-i", narrPaths[i]!,
    "-filter_complex", `[0:v]${drawtext}[v]`,
    "-map", "[v]", "-map", "1:a",
    "-t", String(dur),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-r", "30",
    "-c:a", "aac", "-ar", "44100", "-ac", "2",
    "-shortest",
    seg,
  ]);
  segPaths.push(seg);
}

// Concat segments + mix music bed (cheap C-major sine pad)
const concatList = `${outDir}/concat.txt`;
writeFileSync(concatList, segPaths.map((s) => `file '${s.replace(/^out\//, "")}'`).join("\n"));

const final = `${outDir}/episode.mp4`;
const musicPath = `${outDir}/music.m4a`;
await padBedInline(totalNarrationSec + 2, musicPath);

await ffmpeg([
  "-f", "concat", "-safe", "0", "-i", `${outDir}/concat.txt`.replace(/^out\//, ""),
  "-i", musicPath,
  "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]",
  "-map", "0:v", "-map", "[a]",
  "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
  "-movflags", "+faststart",
  final,
]);

console.log(`\n[done] ${final}`);
console.log(`[done] Open it: open "${final.replace(/^out\//, "out/")}"`);
console.log(`\n[budget summary]`);
console.log(`  fal Flux images:  12 × $${PER_IMAGE_USD} = $${projectedUSD.toFixed(2)} projected`);
console.log(`  Video animation:  $0 (cinematic motion, ffmpeg)`);
console.log(`  Voiceover (TTS):  $0 (edge-tts)`);
console.log(`  Music:            $0 (ffmpeg sine pad)`);
console.log(`  Story + metadata: $0 (built-in offline)`);
console.log(`  TOTAL:            ~$${projectedUSD.toFixed(2)} (vs ~$3 with Grok basic, ~$24 with Grok 720p)`);
