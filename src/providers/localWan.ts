import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { config } from "../config.js";
import { log } from "../logger.js";

const COMFYUI_TIMEOUT = 600_000; // 10 minutes
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

/**
 * Local ComfyUI Provider — runs Wan 2.2 TI2V on local M4 Pro (MPS).
 * Zero cost, zero API keys, uses the ComfyUI server already running at 127.0.0.1:8188.
 */
export class LocalWanProvider {
  private endpoint: string;
  private clientId: string;
  private clipModel: string;
  private vaeModel: string;
  private diffusionModel: string;

  constructor() {
    // Default to local ComfyUI running on MPS
    this.endpoint = config.video.comfyEndpoint || "http://127.0.0.1:8188";
    this.clientId = `bible-kids-local-${Date.now()}`;
    // Model filenames as they appear in ComfyUI model directories
    this.clipModel = config.video.wanClipModel || "models_t5_umt5-xxl-enc-bf16.pth";
    this.vaeModel = config.video.wanVaeModel || "Wan2.2_VAE.pth";
    this.diffusionModel = config.video.wanDiffusionModel || "diffusion_pytorch_model.safetensors.index.json";
  }

  get available(): boolean { return true; } // Always available if ComfyUI is running

  async generate(imagePath: string, prompt: string, outputPath: string): Promise<void> {
    const base = this.endpoint.replace(/\/$/, "");
    const imageName = await this.uploadImage(base, imagePath);
    const workflow = this.buildWorkflow(imageName, prompt);

    log.info(`Submitting local Wan 2.2 workflow to ${base}...`);
    const submitRes = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
    });
    if (!submitRes.ok) throw new Error(`Local Wan 2.2 submit failed: ${submitRes.status} ${await submitRes.text()}`);
    const { prompt_id } = (await submitRes.json()) as { prompt_id: string };
    log.info(`Local Wan 2.2 prompt_id: ${prompt_id}, polling...`);

    const result = await this.pollForResult(base, prompt_id);
    if (!result) throw new Error(`Local Wan 2.2 timed out after ${COMFYUI_TIMEOUT / 1000}s`);

    let outputFilename: string | undefined, subfolder = "";
    for (const entry of Object.values(result.outputs ?? {})) {
      const imgs = entry.images ?? entry.gifs;
      if (imgs?.length) { outputFilename = imgs[0]!.filename; subfolder = imgs[0]!.subfolder ?? ""; break; }
    }
    if (!outputFilename) throw new Error("Local Wan 2.2 returned no output video");

    const downloadUrl = subfolder
      ? `${base}/view?filename=${encodeURIComponent(outputFilename)}&subfolder=${encodeURIComponent(subfolder)}&type=output`
      : `${base}/view?filename=${encodeURIComponent(outputFilename)}&type=output`;
    const downloadRes = await fetch(downloadUrl);
    if (!downloadRes.ok) throw new Error(`Local Wan 2.2 download failed: ${downloadRes.status}`);
    writeFileSync(outputPath, Buffer.from(await downloadRes.arrayBuffer()));
    log.ok(`Local Wan 2.2 clip saved: ${outputPath}`);
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

    // Uses built-in ComfyUI Wan 2.2 nodes (no WanVideoWrapper dependency).
    // The WanVideoWrapper requires PyTorch 2.4+ for torch.library.custom_op.
    return {
      // Node 1: Load the input keyframe image
      "1": { inputs: { image: imageName, upload: "image" }, class_type: "LoadImage" },

      // Node 2: Load CLIP model (UMT5 text encoder for Wan) — DualCLIPLoader for Wan
      "2": {
        inputs: {
          clip_name1: this.clipModel,
          clip_name2: this.clipModel,
          type: "wan",
          device: "default",
        },
        class_type: "DualCLIPLoader",
      },

      // Node 3: Encode positive prompt
      "3": {
        inputs: {
          text: pos,
          clip: ["2", 0],
        },
        class_type: "CLIPTextEncode",
      },

      // Node 4: Encode negative prompt
      "4": {
        inputs: { text: neg, clip: ["2", 0] },
        class_type: "CLIPTextEncode",
      },

      // Node 5: Load VAE
      "5": { inputs: { vae_name: this.vaeModel }, class_type: "VAELoader" },

      // Node 6: Wan 2.2 Image-to-Video latent encode — built-in comfy_extras node
      "6": {
        inputs: {
          vae: ["5", 0],
          width: 1920,
          height: 1088,
          length: 81,
          batch_size: 1,
          start_image: ["1", 0],
        },
        class_type: "Wan22ImageToVideoLatent",
      },

      // Node 7: KSampler (standard ComfyUI sampler)
      "7": {
        inputs: {
          model: ["8", 0],
          positive: ["3", 0],
          negative: ["4", 0],
          latent_image: ["6", 0],
          seed: Math.floor(Math.random() * 2**32),
          steps: 8,
          cfg: 5,
          sampler_name: "dpmpp_sde",
          scheduler: "karras",
          denoise: 1.0,
        },
        class_type: "KSampler",
      },

      // Node 8: ModelPatchLoader for Wan 2.2
      "8": {
        inputs: {
          name: this.diffusionModel,
        },
        class_type: "ModelPatchLoader",
      },

      // Node 9: Decode latent to image
      "9": {
        inputs: { samples: ["7", 0], vae: ["5", 0] },
        class_type: "VAEDecode",
      },

      // Node 10: Create video from frames
      "10": { inputs: { images: ["9", 0], fps: 16 }, class_type: "CreateVideo" },

      // Node 11: Save video
      "11": {
        inputs: {
          video: ["10", 0],
          filename_prefix: "bible-kids-wan22",
          format: "mp4",
          codec: "h264",
        },
        class_type: "SaveVideo",
      },
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
          if (entry.status.status_str === "error") log.warn(`Local Wan 2.2 error: ${JSON.stringify(entry.status.messages?.slice(-2))}`);
          return entry;
        }
      } catch { /* retry */ }
    }
    return null;
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }