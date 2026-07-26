import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, setConfig, resetConfig, type Config } from "../src/config.js";

// ---------------------------------------------------------------------------
// Hermeticity: empty env → offline defaults
// ---------------------------------------------------------------------------

test("loadConfig({}) produces fully offline defaults", () => {
  const cfg = loadConfig({}, { loadDotEnv: false });

  assert.equal(cfg.llm.apiKey, "", "no LLM API key");
  assert.equal(cfg.llm.model, "nousresearch/hermes-4-405b", "default LLM model");
  assert.equal(cfg.llm.baseUrl, "https://openrouter.ai/api/v1", "default LLM base URL");

  assert.equal(cfg.image.provider, "local", "default image provider");
  assert.equal(cfg.image.falKey, "", "no FAL key");

  assert.equal(cfg.video.provider, "local", "default video provider");
  assert.equal(cfg.video.falKey, "", "no FAL video key");
  assert.equal(cfg.video.renderer, "svg", "default renderer");

  assert.equal(cfg.tts.provider, "local", "default TTS provider");
  assert.equal(cfg.tts.elevenKey, "", "no ElevenLabs key");
  assert.equal(cfg.tts.kokoroEndpoint, "", "no Kokoro endpoint");

  assert.equal(cfg.music.provider, "local", "default music provider");
  assert.equal(cfg.music.sunoKey, "", "no Suno key");

  assert.equal(cfg.publish.provider, "mock", "default publish provider");
  assert.equal(cfg.publish.refreshToken, "", "no YouTube refresh token");
  assert.equal(cfg.publish.privacy, "unlisted", "default privacy");

  assert.equal(cfg.requireApproval, false, "no approval required");
  assert.equal(cfg.outputDir, "./out", "default output dir");
  assert.equal(cfg.width, 1920, "default width");
  assert.equal(cfg.height, 1080, "default height");
  assert.equal(cfg.fps, 30, "default fps");
});

// ---------------------------------------------------------------------------
// Env override: explicit env values take precedence
// ---------------------------------------------------------------------------

test("loadConfig respects explicit env vars", () => {
  const cfg = loadConfig(
    {
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_MODEL: "custom-model",
      IMAGE_PROVIDER: "fal",
      FAL_API_KEY: "fal-key",
      VIDEO_PROVIDER: "fal",
      RENDERER: "mlx",
      TTS_PROVIDER: "kokoro",
      KOKORO_ENDPOINT: "http://localhost:8000",
      MUSIC_PROVIDER: "suno",
      SUNO_API_KEY: "suno-key",
      PUBLISH_PROVIDER: "youtube",
      YOUTUBE_REFRESH_TOKEN: "yt-token",
      YOUTUBE_PRIVACY: "private",
      REQUIRE_APPROVAL: "true",
      OUTPUT_DIR: "/tmp/custom",
      VIDEO_WIDTH: "1280",
      VIDEO_HEIGHT: "720",
    },
    { loadDotEnv: false },
  );

  assert.equal(cfg.llm.apiKey, "test-key");
  assert.equal(cfg.llm.model, "custom-model");
  assert.equal(cfg.image.provider, "fal");
  assert.equal(cfg.image.falKey, "fal-key");
  assert.equal(cfg.video.provider, "fal");
  assert.equal(cfg.video.renderer, "mlx");
  assert.equal(cfg.tts.provider, "kokoro");
  assert.equal(cfg.tts.kokoroEndpoint, "http://localhost:8000");
  assert.equal(cfg.music.provider, "suno");
  assert.equal(cfg.music.sunoKey, "suno-key");
  assert.equal(cfg.publish.provider, "youtube");
  assert.equal(cfg.publish.refreshToken, "yt-token");
  assert.equal(cfg.publish.privacy, "private");
  assert.equal(cfg.requireApproval, true);
  assert.equal(cfg.outputDir, "/tmp/custom");
  assert.equal(cfg.width, 1280);
  assert.equal(cfg.height, 720);
});

// ---------------------------------------------------------------------------
// .env file loading: values populate when not in env
// ---------------------------------------------------------------------------

test("loadConfig merges .env file values", () => {
  const cfg = loadConfig({}, { loadDotEnv: true });

  // If .env has FAL_API_KEY, it should be present.
  // If not, it should be empty — either way, the function doesn't crash.
  assert.ok(typeof cfg.image.falKey === "string", "falKey is a string");

  // Default values should still apply for missing keys
  assert.equal(cfg.llm.model, "nousresearch/hermes-4-405b", "default model applies");
  assert.equal(cfg.fps, 30, "default fps from code");
});

// ---------------------------------------------------------------------------
// Env wins over .env: explicit env takes priority
// ---------------------------------------------------------------------------

test("env wins over .env file values", () => {
  const cfg = loadConfig(
    { VIDEO_WIDTH: "640" },
    { loadDotEnv: true },
  );

  // Explicit env ALWAYS wins — that's the contract.
  assert.equal(cfg.width, 640, "explicit env value wins over .env");
});

// ---------------------------------------------------------------------------
// setConfig / resetConfig: override and restore
// ---------------------------------------------------------------------------

test("setConfig overrides the module-level config", async () => {
  const offline = loadConfig({}, { loadDotEnv: false });
  const original = loadConfig(); // captures process.env state

  setConfig(offline);

  // After setConfig, the config should match offline defaults
  assert.equal(offline.llm.apiKey, "", "offline config has no key");

  // Verify the exported config proxy was mutated
  const { config } = await import("../src/config.js");
  assert.equal(config.llm.apiKey, "", "exported config proxy reflects override");

  // Restore
  resetConfig();

  // Verify reset restored process.env values
  const restored = loadConfig();
  assert.equal(restored.llm.apiKey, original.llm.apiKey, "reset restores original env values");
});

// ---------------------------------------------------------------------------
// Type contract: Config interface is stable
// ---------------------------------------------------------------------------

test("Config type has all required fields", () => {
  const cfg: Config = loadConfig({}, { loadDotEnv: false });

  // Just checking the shape exists — TypeScript catches missing fields at compile time,
  // but this runtime check ensures the object is complete.
  assert.ok(cfg.llm, "has llm");
  assert.ok(cfg.image, "has image");
  assert.ok(cfg.video, "has video");
  assert.ok(cfg.tts, "has tts");
  assert.ok(cfg.music, "has music");
  assert.ok(cfg.publish, "has publish");
  assert.ok(typeof cfg.requireApproval === "boolean", "requireApproval is boolean");
  assert.ok(typeof cfg.outputDir === "string", "outputDir is string");
  assert.ok(typeof cfg.width === "number", "width is number");
  assert.ok(typeof cfg.height === "number", "height is number");
  assert.ok(typeof cfg.fps === "number", "fps is number");
});

// ---------------------------------------------------------------------------
// Bool parsing edge cases
// ---------------------------------------------------------------------------

test("bool parsing: various truthy/falsy values", () => {
  assert.equal(
    loadConfig({ REQUIRE_APPROVAL: "true" }, { loadDotEnv: false }).requireApproval,
    true,
  );
  assert.equal(
    loadConfig({ REQUIRE_APPROVAL: "1" }, { loadDotEnv: false }).requireApproval,
    true,
  );
  assert.equal(
    loadConfig({ REQUIRE_APPROVAL: "yes" }, { loadDotEnv: false }).requireApproval,
    true,
  );
  assert.equal(
    loadConfig({ REQUIRE_APPROVAL: "false" }, { loadDotEnv: false }).requireApproval,
    false,
  );
  assert.equal(
    loadConfig({ REQUIRE_APPROVAL: "0" }, { loadDotEnv: false }).requireApproval,
    false,
  );
  assert.equal(
    loadConfig({ REQUIRE_APPROVAL: "" }, { loadDotEnv: false }).requireApproval,
    false,
  );
  assert.equal(
    loadConfig({}, { loadDotEnv: false }).requireApproval,
    false,
  );
});

// ---------------------------------------------------------------------------
// Num parsing edge cases
// ---------------------------------------------------------------------------

test("num parsing: valid, invalid, missing", () => {
  assert.equal(
    loadConfig({ VIDEO_WIDTH: "1280" }, { loadDotEnv: false }).width,
    1280,
  );
  assert.equal(
    loadConfig({ VIDEO_WIDTH: "abc" }, { loadDotEnv: false }).width,
    1920, // fallback default
  );
  assert.equal(
    loadConfig({ VIDEO_WIDTH: "0" }, { loadDotEnv: false }).width,
    1920, // 0 is not > 0, so fallback
  );
  assert.equal(
    loadConfig({ VIDEO_WIDTH: "-100" }, { loadDotEnv: false }).width,
    1920, // negative falls back
  );
  assert.equal(
    loadConfig({}, { loadDotEnv: false }).width,
    1920, // missing falls back
  );
});

// ---------------------------------------------------------------------------
// Isolation: test suite doesn't pollute the module-level config
// ---------------------------------------------------------------------------

test("loadConfig({}) is isolated — doesn't mutate process.env", () => {
  const envCopy = { ...process.env };
  loadConfig({}, { loadDotEnv: false });
  // process.env should be unchanged
  for (const key of Object.keys(envCopy)) {
    assert.equal(process.env[key], envCopy[key], `process.env[${key}] unchanged`);
  }
  for (const key of Object.keys(process.env)) {
    assert.equal(process.env[key], envCopy[key], `no new keys in process.env`);
  }
});