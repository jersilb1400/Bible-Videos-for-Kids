import { spawn } from "node:child_process";
import { resolveVoice } from "./voiceRegistry.js";

/**
 * Edge-TTS provider — free, zero-config, high-quality children's narration.
 * Requires `edge-tts` Python package installed:
 *   pip install edge-tts
 *
 * Voice options: pass a character ID ("narrator", "daniel", "mother"),
 * a legacy rig key ("jenny", "guy", "maisie", "aria"), or a raw Microsoft
 * voice name ("en-US-GuyNeural"). Unrecognised keys fall back to the default.
 * See voiceRegistry.ts for the full roster.
 *
 * Example voice keys:
 *   jenny  → en-US-JennyNeural   — warm female (default, good for kids)
 *   guy    → en-US-GuyNeural     — friendly male
 *   maisie → en-GB-MaisieNeural  — British child voice (best for kids' content!)
 *   aria   → en-US-AriaNeural    — expressive female
 */

/** Rate at which speech is delivered. 1.0 = normal, 1.2 = slightly faster for kids. */
const RATE_DEFAULT = "+0%";

export class EdgeTtsProvider {
  get available(): boolean {
    return true;
  }

  async generate(
    text: string,
    outputPath: string,
    voice?: string,
    rate?: string,
  ): Promise<void> {
    const voiceId = resolveVoice(voice);
    const speechRate: string = rate ?? RATE_DEFAULT;

    return new Promise((resolve, reject) => {
      const args: string[] = ["--text", text, "--voice", voiceId, "--write-media", outputPath];
      if (speechRate !== "+0%") {
        args.push("--rate", speechRate);
      }

      const child = spawn("edge-tts", args, { stdio: ["ignore", "pipe", "pipe"] as const });

      let stderr = "";
      if (child.stderr) {
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      }
      child.on("error", (e: Error) =>
        reject(
          new Error(
            `edge-tts not found: ${e.message}. Install with: pip install edge-tts`,
          ),
        ),
      );
      child.on("close", (code: number | null) => {
        if (code === 0) resolve();
        else reject(new Error(`edge-tts exited ${code}: ${stderr.slice(-500)}`));
      });
    });
  }
}