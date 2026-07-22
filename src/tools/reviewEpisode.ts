#!/usr/bin/env npx tsx
/**
 * Episode Review Tool — strings together story, visuals, audio, and character-voice mapping.
 * Run: npx tsx src/tools/reviewEpisode.ts <production-id>
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import { probeDuration } from "../providers/ffmpeg.js";
import { fallbackStory } from "../stages/story.js";
import type { Story, Character } from "../types.js";

interface ReviewItem {
  scene: number;
  narration: string;
  visual: string;
  characters: string[];
  setting: string;
  sceneType: string;
  durationHint: number;
  imagePath: string;
  audioPath: string;
  clipPath: string;
  audioDuration?: number;
}

async function loadProduction(productionId: string): Promise<{ story: Story; items: ReviewItem[] }> {
  const root = resolve(process.cwd(), config.outputDir, productionId);
  if (!existsSync(root)) throw new Error(`Production not found: ${root}`);

  // Use the offline Noah story which matches the generated episode
  const story = fallbackStory("Noah's Ark");

  const items: ReviewItem[] = [];
  for (let i = 0; i < story.scenes.length; i++) {
    const scene = story.scenes[i]!;
    const img = `${root}/images/scene-${String(i).padStart(2, "0")}.png`;
    const aud = `${root}/audio/scene-${String(i).padStart(2, "0")}.mp3`;
    const clip = `${root}/clips/scene-${String(i).padStart(2, "0")}.mp4`;

    items.push({
      scene: i + 1,
      narration: scene.narration,
      visual: scene.visual,
      characters: scene.characters,
      setting: scene.setting,
      sceneType: scene.sceneType,
      durationHint: scene.durationHint,
      imagePath: existsSync(img) ? img : "MISSING",
      audioPath: existsSync(aud) ? aud : "MISSING",
      clipPath: existsSync(clip) ? clip : "MISSING",
    });
  }

  // Probe audio durations
  for (const item of items) {
    if (item.audioPath !== "MISSING") {
      try {
        item.audioDuration = await probeDuration(item.audioPath);
      } catch { }
    }
  }

  return { story, items };
}

async function printReview(productionId: string): Promise<void> {
  const { story, items } = await loadProduction(productionId);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  EPISODE REVIEW: ${story.title}`);
  console.log(`  Source: ${story.source}  |  Lesson: ${story.lesson}`);
  console.log(`  Production: ${productionId}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Character roster with voice suggestions
  console.log("── CHARACTERS & VOICE CASTING ──────────────────────────────");
  const voiceMap: Record<string, string> = {
    "Noah": "edge-tts:en-US-ChristopherNeural (warm grandfather)",
    "Mrs. Noah": "edge-tts:en-US-JennyNeural (gentle mother)",
    "Dove": "edge-tts:en-US-AriaNeural (light, airy)",
    "David": "edge-tts:en-US-GuyNeural (youthful)",
    "Goliath": "edge-tts:en-US-RogerNeural (deep, slow)",
    "King Saul": "edge-tts:en-US-DavisNeural (regal, worried)",
  };

  for (const c of story.characters) {
    const suggested = voiceMap[c.name] || "edge-tts:en-US-ChristopherNeural (default)";
    console.log(`  ${c.name.padEnd(12)}  ${c.description}`);
    console.log(`  ${"".padEnd(14)}  Palette: skin=${c.palette.skin} hair=${c.palette.hair} robe=${c.palette.robe}`);
    console.log(`  ${"".padEnd(14)}  Voice: ${suggested}\n`);
  }

  // Scene-by-scene breakdown
  console.log("── SCENE BREAKDOWN ─────────────────────────────────────────");
  let totalAudio = 0;
  let missingImages = 0, missingAudio = 0, missingClips = 0;

  for (const item of items) {
    const charStr = item.characters.length ? ` [${item.characters.join(", ")}]` : "";
    const durStr = item.audioDuration ? `${item.audioDuration.toFixed(1)}s` : `~${item.durationHint}s (hint)`;
    const status = [
      item.imagePath === "MISSING" ? "🔴IMG" : "🟢IMG",
      item.audioPath === "MISSING" ? "🔴AUD" : "🟢AUD",
      item.clipPath === "MISSING" ? "🔴CLIP" : "🟢CLIP",
    ].join(" ");

    console.log(`\n${String(item.scene).padStart(2)}  ${item.sceneType.padEnd(7)}  ${item.setting.padEnd(7)}  ${durStr.padStart(8)}  ${status}${charStr}`);
    console.log(`     NARRATION: ${item.narration.slice(0, 120)}${item.narration.length > 120 ? "…" : ""}`);
    console.log(`     VISUAL:    ${item.visual.slice(0, 120)}${item.visual.length > 120 ? "…" : ""}`);

    if (item.imagePath === "MISSING") missingImages++;
    if (item.audioPath === "MISSING") missingAudio++;
    if (item.clipPath === "MISSING") missingClips++;
    if (item.audioDuration) totalAudio += item.audioDuration;
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  SUMMARY: ${items.length} scenes  |  Audio: ${totalAudio.toFixed(1)}s (${(totalAudio/60).toFixed(1)} min)`);
  console.log(`  Missing: ${missingImages} images, ${missingAudio} audio, ${missingClips} clips`);
  console.log(`  Final video: ${resolve(process.cwd(), config.outputDir, productionId, "episode.mp4")}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

// CLI
const prodId = process.argv[2];
if (!prodId) {
  console.error("Usage: npx tsx src/tools/reviewEpisode.ts <production-id>");
  process.exit(1);
}

printReview(prodId).catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});