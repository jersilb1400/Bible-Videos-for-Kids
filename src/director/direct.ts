import type { DirectorConfig, ScreenplayInput, DirectedShot, DirectedEpisode } from "./types.js";
import { DirectorResponseSchema } from "./types.js";
import { DirectorPromptBuilder, canonicalId } from "./promptBuilder.js";
import { fallbackDirect } from "./fallback.js";
import { EpisodeSchema as episodeSchemaLocal } from "../types.js";

// ---------------------------------------------------------------------------
// LLM errors.
// ---------------------------------------------------------------------------

/** Base error thrown by the director pipeline. */
export class DirectorError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "DirectorError";
  }
}

/** LLM HTTP request failed or returned a non-200 status. */
export class LlmRequestError extends DirectorError {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "LlmRequestError";
    this.status = status;
    this.body = body;
  }
}

/** LLM returned content that couldn't be parsed or didn't validate. */
export class LlmParseError extends DirectorError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "LlmParseError";
  }
}

// ---------------------------------------------------------------------------
// OpenAI chat completion request/response shapes (minimal).
// ---------------------------------------------------------------------------

interface ChatCompletionRequest {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  temperature?: number;
  max_tokens?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  error?: { message?: string };
}

// ---------------------------------------------------------------------------
// DirectEpisode — screenplay → LLM → DirectedShot[] → DirectedEpisode.
// ---------------------------------------------------------------------------

export interface DirectOptions {
  /** Inject a custom fetch (used by tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override the temperature; default 0.5. */
  temperature?: number;
  /** If true (default), fall back to the deterministic director when the LLM
   * call fails. Set false to surface LLM errors instead. */
  useFallbackOnFailure?: boolean;
  /** Abort the LLM call after this many ms. */
  timeoutMs?: number;
}

/**
 * Direct an episode: convert a ScreenplayInput into a fully-staged
 * {@link DirectedEpisode} via an LLM call.
 *
 * If the LLM is unreachable (no endpoint configured) or the call fails and
 * `useFallbackOnFailure` is true, the deterministic fallback director is used
 * so the pipeline always produces a valid episode (matching the project's
 * "every stage has an offline fallback" design principle).
 */
export async function directEpisode(
  input: ScreenplayInput,
  config: DirectorConfig,
  opts: DirectOptions = {},
): Promise<DirectedEpisode> {
  const useFallback = opts.useFallbackOnFailure ?? true;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // If no endpoint is configured, go straight to the offline fallback.
  if (!config.endpoint || !config.model) {
    return await directWithFallback(input, config);
  }

  if (!config.apiKey) {
    return await directWithFallback(input, config);
  }

  let shots: DirectedShot[];
  try {
    shots = await callLlmForShots(input, config, fetchImpl, opts);
  } catch (err) {
    if (useFallback) {
      return await directWithFallback(input, config);
    }
    throw err;
  }

  // Enrich the LLM's shots with the cast built from the screenplay and validate.
  return buildDirectedEpisode(input, shots);
}

/** Build a DirectedEpisode from the LLM-output shots by adding cast info. */
function buildDirectedEpisode(
  input: ScreenplayInput,
  shots: DirectedShot[],
): DirectedEpisode {
  const cast = input.characters.map((c) => {
    const id = canonicalId(c.name);
    return { characterId: id, rigId: `rig:${id}`, voiceId: `voice:${id}` };
  });

  const episode: DirectedEpisode = {
    schemaVersion: 2,
    title: input.title,
    source: input.source,
    lesson: input.lesson,
    cast,
    shots,
  };
  // Validate through the EpisodeSchema (this re-runs all the superRefine rules).
  return validateAndClean(episode, input);
}

/** Validate a DirectedEpisode via EpisodeSchema; throws LlmParseError on failure. */
function validateAndClean(
  ep: DirectedEpisode,
  _input: ScreenplayInput,
): DirectedEpisode {
  try {
    // Reuse the shared validator (it strips director metadata before parsing
    // the base EpisodeSchema, then returns the original episode intact).
    return validateViaEpisodeSchema(ep);
  } catch (err) {
    throw new LlmParseError(
      `LLM-produced shots failed v2 EpisodeSchema validation: ${extractMessage(err)}`,
      err,
    );
  }
}

/** Direct copy of validateDirectedEpisode from types.ts, kept local for clarity. */
function validateViaEpisodeSchema(ep: DirectedEpisode): DirectedEpisode {
  // Import inline to avoid a circular type import complication at module scope.
  // The EpisodeSchema in types.ts already validates all the cross-field rules.
  const baseEpisode = {
    schemaVersion: 2 as const,
    title: ep.title,
    source: ep.source,
    lesson: ep.lesson,
    cast: ep.cast,
    shots: ep.shots.map((s) => {
      const { director: _d, ...shot } = s;
      return shot;
    }),
  };
  // Parsing validates and normalizes defaults; if it throws, we surface it.
  const parsed = episodeSchemaLocal.parse(baseEpisode);
  void parsed; // validated; return original with director metadata intact
  return ep;
}

// ---------------------------------------------------------------------------
// LLM call: screenplay → DirectedShot[].
// ---------------------------------------------------------------------------

async function callLlmForShots(
  input: ScreenplayInput,
  config: DirectorConfig,
  fetchImpl: typeof fetch,
  opts: DirectOptions,
): Promise<DirectedShot[]> {
  const builder = new DirectorPromptBuilder(config);
  const { system, user } = builder.build(input);

  const body: ChatCompletionRequest = {
    model: config.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: opts.temperature ?? 0.5,
  };

  const endpointUrl = joinUrl(config.endpoint, "/chat/completions");
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetchImpl(endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    throw new LlmRequestError(
      `LLM fetch failed: ${extractMessage(err)}`,
      0,
      String(err),
    );
  }
  clearTimeout(timer);

  if (!resp.ok) {
    const respText = await safeText(resp);
    throw new LlmRequestError(
      `LLM endpoint returned ${resp.status}: ${respText.slice(0, 500)}`,
      resp.status,
      respText,
    );
  }

  let data: ChatCompletionResponse;
  try {
    data = (await resp.json()) as ChatCompletionResponse;
  } catch (err: unknown) {
    throw new LlmParseError(
      `LLM response was not valid JSON: ${extractMessage(err)}`,
      err,
    );
  }

  if (data.error) {
    throw new LlmRequestError(
      `LLM returned an error: ${data.error.message ?? "unknown"}`,
      resp.status,
      JSON.stringify(data.error),
    );
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new LlmParseError("LLM response had no message content");
  }

  return parseLlmResponse(content);
}

/**
 * Parse the raw content string from the LLM into validated DirectedShot[].
 * Strips markdown fences if present, then JSON-parses + Zod-validates.
 */
export function parseLlmResponse(raw: string): DirectedShot[] {
  let jsonStr = raw.trim();

  // Strip ```json ... ``` fences if the model added them despite instructions.
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    jsonStr = fenceMatch[1].trim();
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonStr);
  } catch (err: unknown) {
    throw new LlmParseError(
      `Could not parse LLM output as JSON: ${extractMessage(err)}`,
      err,
    );
  }

  let validated;
  try {
    validated = DirectorResponseSchema.parse(parsedJson);
  } catch (err: unknown) {
    throw new LlmParseError(
      `LLM output failed Zod validation: ${extractMessage(err)}`,
      err,
    );
  }

  return validated.shots.map((s) => {
    // DirectorResponseSchema.strips unknown fields and already provides defaults
    // for the director block via .default(). Ensure director is present.
    const director = s.director ?? {
      staging: "",
      cameraRationale: "",
      animationSuggestions: [],
      gestureTiming: [],
      reactionShots: [],
    };
    return { ...s, director } as DirectedShot;
  });
}

// ---------------------------------------------------------------------------
// Fallback (deterministic, offline) director used by directEpisode on failure.
// ---------------------------------------------------------------------------

async function directWithFallback(
  input: ScreenplayInput,
  config: DirectorConfig,
): Promise<DirectedEpisode> {
  return fallbackDirect(input, config);
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

/** Extract a message from an unknown error. */
function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const encoder = new TextEncoder();

/** Read response text safely (swallows body-read errors). */
async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return encoder.encode("").toString();
  }
}

/** Join a base URL + path, tolerating trailing slashes. */
function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

export { canonicalId };
