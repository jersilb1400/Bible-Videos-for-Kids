/**
 * Proof contract test. Verifies the v2 proof pipeline produces a valid MP4
 * with honest metadata. This is a STRUCTURAL proof — fixture audio only.
 *
 * Run with: npm test (included in the test suite)
 * Or standalone: npm run proof:v2
 */
import { describe, test } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

/** Probe an MP4 with ffprobe. */
function probeMp4(file: string): Record<string, any> {
  const out = execSync(
    'ffprobe -v error -show_format -show_streams ' +
    '-of json "' + file + '"',
    { encoding: "utf8", timeout: 30_000 },
  );
  return JSON.parse(out);
}

/** Run the proof pipeline and return the QC JSON. */
function runProof(): { qc: any; probe: any } {
  execSync("npx tsx scripts/render-proof.ts", {
    cwd: repo,
    stdio: "pipe",
    timeout: 300_000,
  });

  const qcPath = join(repo, "out/proof-daniel-qc.json");
  assert.ok(existsSync(qcPath), "QC metadata file must exist");
  const qc = JSON.parse(readFileSync(qcPath, "utf8"));

  const output = join(repo, "out/proof-daniel.mp4");
  const probe = probeMp4(output);
  return { qc, probe };
}

describe("proof contract", () => {
  test("structural: produces MP4 with video+audio streams, honest QC metadata", {
    timeout: 300_000,
  }, () => {
    const { qc, probe } = runProof();

    // Video stream must exist
    const videoStream = probe.streams?.find((s: any) => s.codec_type === "video");
    assert.ok(videoStream, "must have a video stream");
    assert.equal(videoStream.width, 1280, "width must be 1280");
    assert.equal(videoStream.height, 720, "height must be 720");

    // Audio stream must exist
    const audioStream = probe.streams?.find((s: any) => s.codec_type === "audio");
    assert.ok(audioStream, "must have an audio stream");

    // Honest labeling
    assert.equal(qc.proof, "v2", "proof version must be v2");
    assert.ok(qc.label.includes("fixture"), "label must indicate fixture audio");
    assert.ok(!qc.label.includes("production"), "label must NOT claim production quality");
    assert.ok(!qc.label.includes("real voices"), "label must NOT claim real voices");

    // Frame agreement (±5 frames for encoder GOP padding)
    assert.ok(qc.probe.frameAgreement,
      `reported frames (${qc.probe.reportFrames}) must agree with actual (${qc.probe.actualFrames}) within tolerance`);
  });

  test("deterministic: two fixture renders produce identical hash", {
    timeout: 360_000,
  }, async () => {
    const { createHash } = await import("node:crypto");

    // Run 1
    runProof();
    const output = join(repo, "out/proof-daniel.mp4");
    const h1 = createHash("sha256")
      .update(readFileSync(output))
      .digest("hex");

    // Run 2
    runProof();
    const h2 = createHash("sha256")
      .update(readFileSync(output))
      .digest("hex");

    assert.equal(h1, h2, "two fixture renders must produce identical output hash");
  });
});