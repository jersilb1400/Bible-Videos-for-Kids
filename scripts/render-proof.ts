#!/usr/bin/env npx tsx
/**
 * Render the proof episode (Daniel and the Lions' Den) through the v2 pipeline.
 * Uses FixtureSpeechProvider (deterministic silent WAVs) so it needs no API keys.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runPipelineV2 } from "../src/pipelineV2.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

async function main() {
  const result = await runPipelineV2({
    episodeFile: join(repo, "episodes/proof-daniel-v2.json"),
    manifestFile: join(repo, "assets/manifest.v1.json"),
    outputFile: join(repo, "out/proof-daniel.mp4"),
    width: 1280,
    height: 720,
    fps: 30,
    seed: 42,
  });

  console.log("\n=== Proof Episode Rendered ===");
  console.log(`Title: ${result.episode.title}`);
  console.log(`Shots: ${result.episode.shots.length}`);
  console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`Frames: ${result.timeline.totalFrames}`);
  console.log(`Output: ${result.outputFile}`);
  console.log(`Captions: ${result.captionsFile}`);
}

main().catch(err => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
