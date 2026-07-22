import { writeFileSync } from "node:fs";
import { config } from "../config.js";
import { log } from "../logger.js";

const FAL_BASE = "https://fal.run";

interface FalImageResult {
  images?: { url: string; content_type?: string }[];
  prompt?: string;
  seed?: number;
  request_id?: string;
}

/**
 * fal.ai Flux 2 image generation provider.
 * Generates high-quality cartoon-style keyframes for children's Bible videos.
 * Cost: ~$0.02-0.05 per 1080p image (verify on fal.ai/pricing).
 *
 * Uses sync_mode for fast single-image generation.
 * Falls back to async if sync is not supported by the model.
 */
export class FalFluxProvider {
  get available(): boolean {
    return !!config.image.falKey;
  }

  /**
   * Generate a single image from a text prompt.
   * Downloads the result to outputPath and returns both local path and URL.
   */
  async generateImage(
    prompt: string,
    outputPath: string,
    options?: {
      imageSize?: { width: number; height: number };
      model?: string;
    },
  ): Promise<{ localPath: string; url: string }> {
    if (!this.available) throw new Error("FAL_API_KEY not configured");

    const model = options?.model || config.image.falModel;
    const size = options?.imageSize || { width: config.width, height: config.height };

    // Step 1: Submit generation request
    const res = await fetch(`${FAL_BASE}/${model}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${config.image.falKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        image_size: size,
        num_images: 1,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`fal ${res.status}: ${text}`);
    }

    // Step 2: Parse response — fal.ai may return sync or async
    const body = (await res.json()) as Record<string, unknown>;

    // Check for async response (request_id means we need to poll)
    if (body.request_id) {
      return await this.pollAndDownload(body.request_id as string, outputPath, prompt);
    }

    // Sync response — has images directly
    const data = body as FalImageResult;
    const image = data.images?.[0];
    if (!image?.url) throw new Error("fal returned no image URL");

    return await this.downloadToFile(image.url, outputPath);
  }

  /**
   * Poll an async fal.ai request until complete, then download.
   */
  private async pollAndDownload(
    requestId: string,
    outputPath: string,
    _prompt: string,
  ): Promise<{ localPath: string; url: string }> {
    const startTime = Date.now();
    const timeout = 120_000; // 2 minutes max
    const pollUrl = `${FAL_BASE}/requests/${requestId}`;

    while (Date.now() - startTime < timeout) {
      await sleep(2000);

      const res = await fetch(pollUrl, {
        headers: { Authorization: `Key ${config.image.falKey}` },
      });

      if (!res.ok) {
        if (res.status === 404) continue; // Not ready yet
        throw new Error(`fal poll ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as FalImageResult & { status?: string };

      if (data.status === "COMPLETED" || data.status === "SUCCESS") {
        const image = data.images?.[0];
        if (!image?.url) throw new Error("fal async returned no image URL");
        return await this.downloadToFile(image.url, outputPath);
      }

      if (data.status === "FAILED" || data.status === "ERROR") {
        throw new Error(`fal generation failed for request ${requestId}`);
      }

      // Still processing — continue polling
    }

    throw new Error(`fal generation timed out for request ${requestId}`);
  }

  /**
   * Download a remote image URL to a local file.
   */
  private async downloadToFile(
    url: string,
    outputPath: string,
  ): Promise<{ localPath: string; url: string }> {
    const imgRes = await fetch(url);
    if (!imgRes.ok) throw new Error(`Image download failed: ${imgRes.status}`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    writeFileSync(outputPath, buffer);

    log.info(
      `  fal Flux: ${outputPath.split("/").pop()} (${(buffer.length / 1024).toFixed(0)}KB)`,
    );

    return { localPath: outputPath, url };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}