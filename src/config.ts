import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Config {
  llm: {
    apiKey: string;
    model: string;
    utilityModel: string;
    baseUrl: string;
  };
  image: {
    provider: string;
    falKey: string;
    falModel: string;
    comfyEndpoint: string;
  };
  video: {
    provider: string;
    falKey: string;
    falModel: string;
    renderer: string;
  };
  tts: {
    provider: string;
    elevenKey: string;
    elevenVoice: string;
    kokoroEndpoint: string;
  };
  music: {
    provider: string;
    sunoKey: string;
  };
  publish: {
    provider: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    privacy: string;
  };
  requireApproval: boolean;
  outputDir: string;
  width: number;
  height: number;
  fps: number;
}

// ---------------------------------------------------------------------------
// Pure config builder — no side effects, testable
// ---------------------------------------------------------------------------

/**
 * Build a {@link Config} from an explicit environment object.
 *
 * This is the hermetic entry point: tests pass `{}` (or a controlled subset)
 * to get fully offline defaults, immune to whatever the developer's `.env`
 * or shell happens to contain.
 *
 * @param env   Source of environment variables.
 * @param opts  Optional: `cwd` to load `.env` from, and `loadDotEnv` (default
 *              `true` for the default process-env call, `false` for tests).
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  opts: { cwd?: string; loadDotEnv?: boolean } = {},
): Config {
  const { cwd = process.cwd(), loadDotEnv: shouldLoadDotEnv = true } = opts;

  // Merge .env file values *under* the provided env (env wins).
  const merged: Record<string, string | undefined> = { ...env };
  if (shouldLoadDotEnv) {
    try {
      const text = readFileSync(resolve(cwd, ".env"), "utf8");
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        if (merged[key] === undefined) merged[key] = val;
      }
    } catch {
      // No .env file — rely on provided env / defaults.
    }
  }

  const e = (k: string, d = ""): string => merged[k]?.trim() || d;
  const bool = (k: string, d = false): boolean => {
    const v = merged[k]?.trim().toLowerCase();
    return v === undefined || v === "" ? d : v === "true" || v === "1" || v === "yes";
  };
  const num = (k: string, d: number): number => {
    const v = Number(merged[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };

  return {
    llm: {
      apiKey: e("OPENROUTER_API_KEY"),
      model: e("OPENROUTER_MODEL", "nousresearch/hermes-4-405b"),
      utilityModel: e("OPENROUTER_UTILITY_MODEL", "meta-llama/llama-3.3-70b-instruct"),
      baseUrl: "https://openrouter.ai/api/v1",
    },
    image: {
      provider: e("IMAGE_PROVIDER", "local"),
      falKey: e("FAL_API_KEY"),
      falModel: e("FAL_IMAGE_MODEL", "fal-ai/flux-2"),
      comfyEndpoint: e("COMFYUI_ENDPOINT"),
    },
    video: {
      provider: e("VIDEO_PROVIDER", "local"),
      falKey: e("FAL_API_KEY"),
      falModel: e("FAL_VIDEO_MODEL", "fal-ai/pixverse/v4.5/image-to-video"),
      renderer: e("RENDERER", "svg"),
    },
    tts: {
      provider: e("TTS_PROVIDER", "local"),
      elevenKey: e("ELEVENLABS_API_KEY"),
      elevenVoice: e("ELEVENLABS_VOICE_ID"),
      kokoroEndpoint: e("KOKORO_ENDPOINT"),
    },
    music: {
      provider: e("MUSIC_PROVIDER", "local"),
      sunoKey: e("SUNO_API_KEY"),
    },
    publish: {
      provider: e("PUBLISH_PROVIDER", "mock"),
      clientId: e("YOUTUBE_CLIENT_ID"),
      clientSecret: e("YOUTUBE_CLIENT_SECRET"),
      refreshToken: e("YOUTUBE_REFRESH_TOKEN"),
      privacy: e("YOUTUBE_PRIVACY", "unlisted"),
    },
    requireApproval: bool("REQUIRE_APPROVAL", false),
    outputDir: e("OUTPUT_DIR", "./out"),
    width: num("VIDEO_WIDTH", 1920),
    height: num("VIDEO_HEIGHT", 1080),
    fps: 30,
  };
}

// ---------------------------------------------------------------------------
// Module-level default + override API
// ---------------------------------------------------------------------------

let _config: Config = loadConfig();

/** The active configuration. Read by pipeline stages and providers. */
export const config: Config = _config;

/**
 * Override the active configuration. Primarily for tests that need an
 * isolated, deterministic environment (e.g. `setConfig(loadConfig({}))`
 * forces everything offline regardless of `.env` or shell vars).
 */
export function setConfig(cfg: Config): void {
  _config = cfg;
  // Update the exported proxy so all `import { config }` callers see the new value.
  Object.assign(config, cfg);
}

/** Restore the default configuration from `process.env` + `.env`. */
export function resetConfig(): void {
  setConfig(loadConfig());
}
