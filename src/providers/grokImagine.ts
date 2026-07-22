import { writeFileSync } from "node:fs";
import { config } from "../config.js";
import { log } from "../logger.js";

const XAI_BASE = "https://api.x.ai/v1";
const POLL_INTERVAL = 5000; // 5 seconds
const POLL_TIMEOUT = 300_000; // 5 minutes

interface ImageResult {
  url: string;
  mime_type?: string;
  revised_prompt?: string;
}

interface VideoResult {
  status: "processing" | "done" | "error" | "failed";
  video?: { url: string; duration: number };
  progress?: number;
  usage?: { cost_in_usd_ticks: number };
  error?: string;
}

/**
 * Grok Imagine provider via xAI API.
 *
 * Generates images (text-to-image) and videos (text-to-video + image-to-video)
 * using Grok Imagine models. Asynchronous video generation with polling.
 */
export class GrokImagineProvider {
  private apiKey: string;

  constructor() {
    this.apiKey = config.xai.apiKey || "";
  }

  get available(): boolean {
    return !!this.apiKey;
  }

  /** Generate a single image from a text prompt. Returns the image URL. */
  async generateImage(
    prompt: string,
    quality: "standard" | "quality" = "quality",
  ): Promise<string> {
    if (!this.apiKey) throw new Error("XAI_API_KEY not configured");

    const model = quality === "quality" ? "grok-imagine-image-quality" : "grok-imagine-image";

    const res = await fetch(`${XAI_BASE}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, prompt, n: 1 }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Grok image gen failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as {
      data: ImageResult[];
      usage?: { cost_in_usd_ticks: number };
    };

    const image = data.data?.[0];
    if (!image?.url) throw new Error("Grok returned no image URL");

    const cost = data.usage?.cost_in_usd_ticks;
    if (cost) log.info(`  Grok image: ${(cost / 1e7).toFixed(1)}¢`);

    return image.url;
  }

  /**
   * Generate a video from text + optional starting image.
   * Returns the video URL after polling for completion.
   */
  async generateVideo(
    prompt: string,
    imageUrl?: string,
    duration = 8,
    model = "grok-imagine-video",
  ): Promise<string> {
    if (!this.apiKey) throw new Error("XAI_API_KEY not configured");

    const body: Record<string, unknown> = { model, prompt, duration };
    if (imageUrl) {
      body.image = { url: imageUrl };
    }

    const submitRes = await fetch(`${XAI_BASE}/videos/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!submitRes.ok) {
      const text = await submitRes.text();
      throw new Error(`Grok video submit failed: ${submitRes.status} ${text}`);
    }

    const { request_id } = (await submitRes.json()) as { request_id: string };
    if (!request_id) throw new Error("Grok video: no request_id returned");

    log.info(`  Grok video submitted: ${request_id}, polling...`);

    const result = await this.pollVideo(request_id);
    if (!result?.video?.url) {
      throw new Error(`Grok video failed: ${result?.error || "no video URL"}`);
    }

    const cost = result.usage?.cost_in_usd_ticks;
    if (cost) log.info(`  Grok video: $${(cost / 1e9).toFixed(2)}`);

    return result.video.url;
  }

  /** Poll for video generation completion. */
  private async pollVideo(requestId: string): Promise<VideoResult | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < POLL_TIMEOUT) {
      await sleep(POLL_INTERVAL);
      try {
        const res = await fetch(`${XAI_BASE}/videos/${requestId}`, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        });
        if (!res.ok) continue;
        const data = (await res.json()) as VideoResult;
        if (data.status === "done") return data;
        if (data.status === "error" || data.status === "failed") {
          log.warn(`Grok video status: ${data.status} — ${data.error || ""}`);
          return data;
        }
      } catch {
        // Polling error — retry
      }
    }
    return null;
  }

  /**
   * Download a remote URL to a local file.
   */
  async downloadFile(url: string, outputPath: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(outputPath, buffer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
