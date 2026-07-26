#!/usr/bin/env npx tsx
/**
 * Render the proof episode through the v2 pipeline using fixture (silent)
 * audio. This is a STRUCTURAL PROOF — not a production render. It validates
 * the pipeline end-to-end: validation, timeline, rendering, assembly.
 *
 * Fixture audio is intentionally silent WAVs. The proof verifies the pipeline
 * mechanics, NOT voice quality or production lip sync.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { runPipelineV2 } from "../src/pipelineV2.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

/** Probe an MP4 with ffprobe and return structured QC metadata. */
function probeMp4(file: string): Record<string, any> {
  const out = execSync(
    'ffprobe -v error -show_format -show_streams ' +
    '-of json "' + file + '"',
    { encoding: "utf8", timeout: 30_000 },
  );
  return JSON.parse(out);
}

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

  const output = result.outputFile;
  if (!existsSync(output)) {
    console.error("PROOF FAIL: output file not created");
    process.exit(1);
  }

  // Probe the produced MP4
  const probe = probeMp4(output);
  const videoStream = probe.streams?.find((s: any) => s.codec_type === "video");
  const audioStream = probe.streams?.find((s: any) => s.codec_type === "audio");

  // Verify video stream exists
  if (!videoStream) {
    console.error("PROOF FAIL: no video stream in output");
    process.exit(1);
  }
  // Verify audio stream exists
  if (!audioStream) {
    console.error("PROOF FAIL: no audio stream in output");
    process.exit(1);
  }

  // Derive actual frame count from the stream (not per-shot estimates)
  const actualFrames = parseInt(videoStream.nb_frames ?? probe.format?.tags?.["DURATION"] ?? "0", 10);
  const durationSec = parseFloat(probe.format?.duration ?? "0");

  // Build QC metadata
  const qc = {
    proof: "v2",
    label: "structural — fixture audio (silent WAVs)",
    episode: {
      title: result.episode.title,
      shots: result.episode.shots.length,
      cast: result.episode.cast.length,
    },
    timeline: {
      totalFrames: result.timeline.totalFrames,
      durationMs: result.timeline.totalMs,
    },
    probe: {
      file: output,
      videoCodec: videoStream.codec_name,
      audioCodec: audioStream.codec_name,
      width: videoStream.width,
      height: videoStream.height,
      durationSec: parseFloat(durationSec.toFixed(3)),
      reportFrames: result.timeline.totalFrames,
      actualFrames,
      frameAgreement: Math.abs(result.timeline.totalFrames - actualFrames) <= 5,
    },
    captionsFile: result.captionsFile,
  };

  // Save QC metadata as an artifact
  const qcPath = output.replace(/\.mp4$/, "-qc.json");
  writeFileSync(qcPath, JSON.stringify(qc, null, 2));

  console.log("\n=== Proof Episode Rendered ===");
  console.log(`Title: ${qc.episode.title}`);
  console.log(`Shots: ${qc.episode.shots}`);
  console.log(`Cast: ${qc.episode.cast}`);
  console.log(`Label: ${qc.label}`);
  console.log(`Reported frames: ${qc.probe.reportFrames}`);
  console.log(`Actual frames: ${qc.probe.actualFrames}`);
  console.log(`Duration: ${qc.probe.durationSec}s`);
  console.log(`Frame agreement: ${qc.probe.frameAgreement}`);
  console.log(`Output: ${output}`);
  console.log(`Captions: ${result.captionsFile}`);
  console.log(`QC: ${qcPath}`);

  // Exit nonzero if frame counts disagree
  if (!qc.probe.frameAgreement) {
    console.error("PROOF WARN: frame count mismatch (report vs actual)");
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});