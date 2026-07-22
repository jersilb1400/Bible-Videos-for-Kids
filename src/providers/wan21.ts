import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { config } from "../config.js";
import { log } from "../logger.js";

const COMFYUI_TIMEOUT = 600_000; // 10 minutes — gives CUDA plenty of headroom
const POLL_INTERVAL = 5000;

interface ComfyUIOutputImage {
  filename: string;
  subfolder?: string;
  type?: string;
}
interface ComfyUIOutputEntry {
  images?: ComfyUIOutputImage[];
  animated?: boolean[];
  gifs?: ComfyUIOutputImage[];
}
interface ComfyUIStatus {
  status_str: string;
  completed: boolean;
  messages: Array<[string, Record<string, unknown>]>;
}
interface ComfyUIHistoryEntry {
  prompt: unknown[];
  outputs: Record<string, ComfyUIOutputEntry>;
  status: ComfyUIStatus;
}

export class Wan21Provider {
  private endpoint: string;
  private clientId: string;
  private clipModel: string;
  private vaeModel: string;
  private diffusionModel: string;

  constructor() {
    this.endpoint = config.video.wanEndpoint || config.image.comfyEndpoint || "";
    this.clientId = `bible-kids-${Date.now()}`;
    this.clipModel = config.video.wanClipModel || "umt5-xxl-enc-bf16.safetensors";
    this.vaeModel = config.video.wanVaeModel || "Wan2_2_VAE_bf16.safetensors";
    this.diffusionModel = config.video.wanDiffusionModel || "Wan2_2-TI2V-5B-FastWanFullAttn_bf16.safetensors";
  }

  get available(): boolean { return !!this.endpoint; }

  async generate(imagePath: string, prompt: string, outputPath: string): Promise<void> {
    if (!this.endpoint) throw new Error("WAN_ENDPOINT not configured");
    const base = this.endpoint.replace(/\/$/, "");
    const imageName = await this.uploadImage(base, imagePath);
    const workflow = this.buildWorkflow(imageName, prompt);

    log.info(`Submitting Wan 2.2 workflow to ${base}...`);
    const submitRes = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
    });
    if (!submitRes.ok) throw new Error(`Wan 2.2 submit failed: ${submitRes.status} ${await submitRes.text()}`);
    const { prompt_id } = (await submitRes.json()) as { prompt_id: string };
    log.info(`Wan 2.2 prompt_id: ${prompt_id}, polling...`);

    const result = await this.pollForResult(base, prompt_id);
    if (!result) throw new Error(`Wan 2.2 timed out after ${COMFYUI_TIMEOUT / 1000}s`);

    let outputFilename: string | undefined, subfolder = "";
    for (const entry of Object.values(result.outputs ?? {})) {
      const imgs = entry.images ?? entry.gifs;
      if (imgs?.length) { outputFilename = imgs[0]!.filename; subfolder = imgs[0]!.subfolder ?? ""; break; }
    }
    if (!outputFilename) throw new Error("Wan 2.2 returned no output video");

    const downloadUrl = subfolder
      ? `${base}/view?filename=${encodeURIComponent(outputFilename)}&subfolder=${encodeURIComponent(subfolder)}&type=output`
      : `${base}/view?filename=${encodeURIComponent(outputFilename)}&type=output`;
    const downloadRes = await fetch(downloadUrl);
    if (!downloadRes.ok) throw new Error(`Wan 2.2 download failed: ${downloadRes.status}`);
    writeFileSync(outputPath, Buffer.from(await downloadRes.arrayBuffer()));
    log.ok(`Wan 2.2 clip saved: ${outputPath}`);
  }

  private async uploadImage(base: string, imagePath: string): Promise<string> {
    const imageName = basename(imagePath).replace(/[^a-zA-Z0-9._-]/g, "_");
    const imageBuffer = readFileSync(imagePath);
    const formData = new FormData();
    formData.append("image", new Blob([imageBuffer]), imageName);
    formData.append("overwrite", "true");
    const uploadRes = await fetch(`${base}/upload/image`, { method: "POST", body: formData });
    if (!uploadRes.ok) {
      const altRes = await fetch(`${base}/api/upload/image`, { method: "POST", body: formData });
      if (!altRes.ok) throw new Error(`Image upload failed: ${altRes.status}`);
    }
    return imageName;
  }

  private buildWorkflow(imageName: string, prompt: string): Record<string, unknown> {
    const pos = `Pixar-style childrens Bible animation: ${prompt}, warm lighting, soft rounded shapes, friendly expressions, smooth slow camera movement, 1080p, high quality`;
    const neg = "scary, dark, horror, violence, ugly, distorted, text, watermark, low quality, blurry, deformed";

    return {
      "1": { inputs: { image: imageName, upload: "image" }, class_type: "LoadImage" },
      // Node 2: Load CLIP model for Wan text encoding (use CLIPLoader with type=wan instead of LoadWanVideoT5TextEncoder)
      "2": {
        inputs: {
          clip_name: this.clipModel,
          type: "wan",
        },
        class_type: "CLIPLoader",
      },

      // Node 3: Encode text prompt with CLIP -> CONDITIONING
      "3": {
        inputs: {
          text: pos,
          clip: ["2", 0],
        },
        class_type: "CLIPTextEncode",
      },

      // Node 4: Encode negative prompt -> CONDITIONING
      "4": {
        inputs: { text: neg, clip: ["2", 0] },
        class_type: "CLIPTextEncode",
      },

      // Node 5: Text embed bridge -> WANVIDEOTEXTEMBEDS from CLIP conditioning
      "5": {
        inputs: {
          positive: ["3", 0],
          negative: ["4", 0],
        },
        class_type: "WanVideoTextEmbedBridge",
      },

      // Node 6: Load diffusion model
      "6": { inputs: { model: this.diffusionModel, base_precision: "fp16", quantization: "disabled", load_device: "offload_device", attention_mode: "sdpa" }, class_type: "WanVideoModelLoader" },

      // Node 7: Load VAE
      "7": { inputs: { model_name: this.vaeModel, precision: "bf16" }, class_type: "WanVideoVAELoader" },

      // Node 8: Image to Video Encode — MUST be multiples of 16 for VAE
      "8": { inputs: { vae: ["7", 0], start_image: ["1", 0], width: 1920, height: 1088, num_frames: 81, force_offload: true, start_latent_strength: 1.0, end_latent_strength: 1.0, noise_aug_strength: 0.03 }, class_type: "WanVideoImageToVideoEncode" },

      // Node 9: Sampler — Turbo model needs fewer steps
      "9": { inputs: { model: ["6", 0], image_embeds: ["8", 0], text_embeds: ["5", 0], steps: 8, cfg: 5, shift: 8, scheduler: "dpm++_sde", seed: Math.floor(Math.random() * 2**32), force_offload: true, riflex_freq_index: 0 }, class_type: "WanVideoSampler" },

      // Node 10: Decode, create video, save
      "10": { inputs: { vae: ["7", 0], samples: ["9", 1], enable_vae_tiling: false, tile_x: 272, tile_y: 272, tile_stride_x: 144, tile_stride_y: 128, batch_mode: "default" }, class_type: "WanVideoDecode" },
      "11": { inputs: { images: ["10", 0], fps: 16 }, class_type: "CreateVideo" },
      "12": { inputs: { video: ["11", 0], filename_prefix: "bible-kids-wan22", format: "mp4", codec: "h264" }, class_type: "SaveVideo" },
    };
  }

  private async pollForResult(base: string, promptId: string): Promise<ComfyUIHistoryEntry | null> {
    const start = Date.now();
    while (Date.now() - start < COMFYUI_TIMEOUT) {
      await sleep(POLL_INTERVAL);
      try {
        const res = await fetch(`${base}/history/${promptId}`);
        if (!res.ok) continue;
        const data = (await res.json()) as Record<string, ComfyUIHistoryEntry>;
        const entry = data[promptId];
        if (entry?.status?.completed) {
          if (entry.status.status_str === "error") log.warn(`Wan 2.2 error: ${JSON.stringify(entry.status.messages?.slice(-2))}`);
          return entry;
        }
      } catch { /* retry */ }
    }
    return null;
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }