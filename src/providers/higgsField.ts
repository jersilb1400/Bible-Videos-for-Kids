// Higgsfield provider — wraps the `higgsfield` CLI for image generation.
// Shells out to `higgsfield generate create <model> --prompt ... --wait`
// rather than hitting an HTTP bridge, because the CLI is the verified working path
// (workspace auth is handled by the CLI's own credential store).
//
// Chain with higgsfield-soul-id for character consistency across scenes.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { config } from "../config.js";
import { log } from "../logger.js";

const HIGGSFIELD_BIN = process.env.HIGGSFIELD_BIN || "higgsfield";

/** Default model for cartoon/storybook keyframes. */
const DEFAULT_MODEL = "nano_banana_2_lite";

export class HiggsFieldProvider {
  /** Available when HIGGSFIELD_API_KEY is configured.
   *  Matches FalFluxProvider's pattern: just check the key exists.
   *  The CLI's own auth state is verified at render time. */
  get available(): boolean {
    return !!config.image.higgsfieldApiKey;
  }

  /**
   * Generate a single image from a text prompt via `higgsfield generate create`.
   * Downloads the result to outputPath and returns both local path and remote URL.
   */
  async generateImage(
    prompt: string,
    outputPath: string,
    options?: { model?: string; aspectRatio?: string },
  ): Promise<{ localPath: string; url: string }> {
    if (!this.available) throw new Error("Higgsfield CLI not available");

    const model = options?.model || config.image.higgsfieldModel || DEFAULT_MODEL;
    const aspectRatio = options?.aspectRatio || "16:9";

    // `higgsfield generate create <model> --prompt "..." --aspect_ratio 16:9 --wait`
    // --wait blocks until the job finishes and prints the result URL on stdout.
    const stdout = execFileSync(
      HIGGSFIELD_BIN,
      [
        "generate", "create", model,
        "--prompt", prompt,
        "--aspect_ratio", aspectRatio,
        "--wait",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 180_000, // 3 min max — renders typically take ~20s
        encoding: "utf8",
      },
    ).trim();

    // stdout is the rendered asset URL (verified: CLI prints URL on success)
    const url = stdout.split("\n").pop()?.trim() || "";
    if (!url || !url.startsWith("http")) {
      throw new Error(`Higgsfield returned no URL (got: ${stdout.slice(0, 200)})`);
    }

    // Download to local file — matches FalFluxProvider pattern
    const imgRes = await fetch(url);
    if (!imgRes.ok) throw new Error(`Higgsfield download failed: ${imgRes.status}`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    writeFileSync(outputPath, buffer);

    log.info(
      `  Higgsfield ${model}: ${outputPath.split("/").pop()} (${(buffer.length / 1024).toFixed(0)}KB)`,
    );

    return { localPath: outputPath, url };
  }
}
