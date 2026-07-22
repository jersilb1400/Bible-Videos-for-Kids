import { existsSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { MouthShape } from "../types.js";
import {
  type LipSyncTrack,
  type LipSyncAudio,
  type MouthCue,
} from "../lipsync/types.js";

// ---------------------------------------------------------------------------
// Rhubarb Lip Sync JSON export shape
// ---------------------------------------------------------------------------

/**
 * A single mouth cue from Rhubarb's `--exportFormat json` output. Rhubarb's
 * real schema uses `{ start, end, value }` (seconds as numbers, value as a
 * viseme label A-G/H/X). We accept either `value` (canonical) or `shape`
 * (our internal naming) so the adapter is forgiving with third-party JSON.
 */
export interface RhubarbMouthCue {
  /** Start time in seconds. */
  start: number;
  /** End time in seconds. */
  end: number;
  /** Viseme label, e.g. "A", "B", "X", "G", "H". */
  value: MouthShape;
}

/** Top-level Rhubarb JSON export. */
export interface RhubarbOutput {
  mouthCues: RhubarbMouthCue[];
  /** Source audio file name (informational). */
  sound?: string;
  /** Optional metadata keys Rhubarb writes (we ignore them). */
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Behaviour mode for the Rhubarb lip-sync provider.
 *
 * - `auto`      — try Rhubarb; on any failure (missing binary, non-zero exit,
 *                  timeout, malformed JSON) log a warning and fall back to the
 *                  deterministic `energy-text-v1` provider. (Default.)
 * - `required`  — hard error if Rhubarb cannot be used. No fallback.
 * - `disabled`  — never run Rhubarb; act as if discovery returned null.
 */
export const RhubarbMode = {
  AUTO: "auto",
  REQUIRED: "required",
  DISABLED: "disabled",
} as const;
export type RhubarbMode = (typeof RhubarbMode)[keyof typeof RhubarbMode];

export interface DiscoverOptions {
  /**
   * Process environment. `RHUBARB_BIN` (preferred) and `RHUBARB_MODE` are
   * read from this object. Falls back to `process.env` when omitted.
   */
  env?: NodeJS.ProcessEnv;
  /** Override the `$PATH` searched when falling back to PATH lookup. */
  PATH?: string;
  /** Inject a custom `existsSync` (used by tests). Defaults to fs.existsSync. */
  existsSync?: (path: string) => boolean;
  /** Inject a custom `statSync` for the vendor/ directory check. */
  statSync?: (path: string) => Stats;
  /**
   * Override the project root used to resolve `vendor/`. Defaults to
   * `process.cwd()` — the directory the pipeline runs from.
   */
  projectRoot?: string;
}

/**
 * Cached discovery result — the rhubarb binary path (or null when not found)
 * is stable for the lifetime of the process, so we avoid re-statting on every
 * utterance. The cache key is the `RHUBARB_MODE` + `RHUBARB_BIN` + `PATH`
 * inputs; an explicit discovery call bypasses the cache.
 */
let cachedDiscovery: { key: string; result: string | null } | null = null;

function discoveryKey(opts: DiscoverOptions): string {
  const env = opts.env ?? process.env;
  return [
    env.RHUBARB_MODE ?? "auto",
    env.RHUBARB_BIN ?? "",
    opts.PATH ?? process.env.PATH ?? "",
  ].join("\u0000");
}

/** Resolve a (possibly relative) RHUBARB_BIN value to an absolute path. */
function resolveBin(rawBin: string, existsFn: (p: string) => boolean): string | null {
  if (rawBin && existsFn(rawBin)) {
    return resolve(rawBin);
  }
  return null;
}

/**
 * Find the Rhubarb Lip Sync executable. Search order (first existing wins):
 *
 *   1. `RHUBARB_MODE === "disabled"`      → return `null` immediately.
 *   2. `RHUBARB_BIN` env var (if it points to an existing file).
 *   3. `vendor/rhubarb` (or `vendor/rhubarb.exe` on Windows) under the project
 *      root — bundled with the repo for zero-config installs.
 *   4. `rhubarb` on `$PATH` (shell `which`-style lookup).
 *
 * Returns the absolute path to the binary, or `null` if nothing was found.
 * Discovery is cached per process (and per distinct input set) so repeated
 * calls during a render are cheap.
 */
export function discoverRhubarb(opts: DiscoverOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const mode = (env.RHUBARB_MODE as RhubarbMode | undefined) ?? RhubarbMode.AUTO;
  if (mode === RhubarbMode.DISABLED) return null;

  const key = discoveryKey(opts);
  if (cachedDiscovery && cachedDiscovery.key === key) return cachedDiscovery.result;

  const result = discoverRhubarbUncached(opts);
  cachedDiscovery = { key, result };
  return result;
}

function discoverRhubarbUncached(opts: DiscoverOptions): string | null {
  const env = opts.env ?? process.env;
  const existsFn = opts.existsSync ?? existsSync;

  // 1. RHUBARB_BIN env var (absolute path to an existing file).
  const envBin = env.RHUBARB_BIN;
  if (envBin) {
    const found = resolveBin(envBin, existsFn);
    if (found) return found;
  }

  // 2. vendor/ under the project root.
  const root = opts.projectRoot ?? process.cwd();
  const isWin = process.platform === "win32";
  const vendorNames = isWin ? ["rhubarb.exe", "rhubarb"] : ["rhubarb"];
  for (const name of vendorNames) {
    const candidate = join(root, "vendor", name);
    if (existsFn(candidate)) return candidate;
  }

  // 3. PATH lookup — split PATH and check each directory for `rhubarb`.
  const pathEnv = opts.PATH ?? env.PATH ?? "";
  if (pathEnv) {
    const pathSep = isWin ? ";" : ":";
    for (const dir of pathEnv.split(pathSep)) {
      if (!dir) continue;
      for (const name of vendorNames) {
        const candidate = join(dir, name);
        if (existsFn(candidate)) return candidate;
      }
    }
  }

  return null;
}

/** Reset the discovery cache (test helper only). */
export function _resetRhubarbDiscoveryCache(): void {
  cachedDiscovery = null;
}

// ---------------------------------------------------------------------------
// Parsing: turn Rhubarb's JSON output into a canonical LipSyncTrack
// ---------------------------------------------------------------------------

export interface ParseRhubarbContext {
  trackId: string;
  utteranceId: string;
  speakerId: string;
  audio: LipSyncAudio;
}

/**
 * Parse Rhubarb's `--exportFormat json` output into a canonical
 * {@link LipSyncTrack}.
 *
 * Normalisation guarantees (enforced so the result satisfies
 * `validateLipSyncTrack`):
 *  - **First cue starts at 0.** If Rhubarb's first cue starts later, a leading
 *    X cue is inserted from 0 to that start.
 *  - **Last cue ends at `audio.durationSec`.** A trailing X cue is appended if
 *    Rhubarb stopped early.
 *  - **Gaps filled with X.** Any silent gap between two Rhubarb cues produces
 *    an X cue bridging them.
 *  - **Overlaps clipped.** When two Rhubarb cues overlap, the earlier cue is
 *    clipped at the later cue's start, then merged if they share the same
 *    viseme, or simply clipped and left standing if they differ.
 *  - **Empty input** (Rhubarb did not detect speech) → one X cue spanning the
 *    whole duration.
 */
export function parseRhubarbJson(
  raw: RhubarbOutput,
  ctx: ParseRhubarbContext,
): LipSyncTrack {
  const duration = ctx.audio.durationSec;
  if (!isFinite(duration) || duration <= 0) {
    throw new Error(`parseRhubarbJson: invalid durationSec ${duration}`);
  }

  const rawCues = Array.isArray(raw?.mouthCues) ? raw.mouthCues : [];

  // --- 1. Normalise and clip cues onto [0, duration] -----------------------
  type NormCue = { start: number; end: number; shape: MouthShape };
  const norm: NormCue[] = [];
  for (const rc of rawCues) {
    if (typeof rc.start !== "number" || typeof rc.end !== "number") continue;
    const value = (rc as { value?: string }).value;
    const shape = (isMouthShape(value) ? value : "X") as MouthShape;
    let s = Math.max(0, rc.start);
    let e = Math.min(duration, rc.end);
    if (!(s < e)) continue; // drop zero-width or out-of-range cues
    norm.push({ start: s, end: e, shape });
  }
  // Order by start time (stable sort); ties broken by original order.
  norm.sort((a, b) => a.start - b.start);

  // --- 2. Clip overlaps: each cue's start must be >= previous cue's end --
  for (let i = 1; i < norm.length; i++) {
    const prev = norm[i - 1]!;
    const cur = norm[i]!;
    if (cur.start < prev.end) {
      // Overlap: clip the earlier cue to the later cue's start.
      prev.end = cur.start;
      if (!(prev.start < prev.end)) {
        // Earlier cue collapsed to zero width: drop it.
        norm.splice(i - 1, 1);
        i--;
        continue;
      }
    }
  }
  // After clipping, drop any cue that has collapsed entirely.
  const clipped = norm.filter((c) => c.start < c.end);

  // --- 3. Build contiguous track: insert X cues in gaps --------------------
  const out: NormCue[] = [];
  let cursor = 0;

  for (const c of clipped) {
    if (c.start > cursor) {
      // Gap → insert X cue [cursor, c.start].
      out.push({ start: cursor, end: c.start, shape: "X" });
    } else if (c.start < cursor) {
      // Defensive: c.start < cursor means our clipping didn't fully fix it
      // (shouldn't happen, but be robust). Skip cues fully inside cursor.
      if (c.end <= cursor) continue;
      // Trim c.start to cursor.
      c.start = cursor;
      if (!(c.start < c.end)) continue;
    }
    // Merge with previous cue if same shape and contiguous — keeps the track
    // tidy without changing its semantic meaning.
    const prev = out[out.length - 1];
    if (prev && prev.shape === c.shape && prev.end === c.start) {
      prev.end = c.end;
    } else {
      out.push({ ...c });
    }
    cursor = c.end;
  }

  // --- 4. Trailing gap → X cue to reach duration ---------------------------
  if (cursor < duration) {
    out.push({ start: cursor, end: duration, shape: "X" });
  }
  // Defensive: if nothing at all was produced (empty input), emit one X cue.
  if (out.length === 0) {
    out.push({ start: 0, end: duration, shape: "X" });
  }

  // --- 5. Coerce to canonical MouthCue[] and build the track --------------
  const cues: MouthCue[] = out.map((c) => ({
    startSec: round(c.start),
    endSec: round(c.end),
    shape: c.shape,
  }));

  const track: LipSyncTrack = {
    schemaVersion: 1,
    trackId: ctx.trackId,
    utteranceId: ctx.utteranceId,
    speakerId: ctx.speakerId,
    audio: ctx.audio,
    analyzer: { kind: "rhubarb", version: (raw as any).version, notes: undefined },
    cues,
  };
  return track;
}

/** Round to the nearest microsecond to keep times tidy and deterministic. */
function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function isMouthShape(v: unknown): v is MouthShape {
  return (
    typeof v === "string" &&
    ["A", "B", "C", "D", "E", "F", "G", "H", "X"].includes(v)
  );
}

// ---------------------------------------------------------------------------
// Invocation (run rhubarb on a real audio file)
// ---------------------------------------------------------------------------

export interface InvokeRhubarbOptions {
  /** Absolute path to the rhubarb binary. */
  binPath: string;
  /** 48kHz mono WAV to analyse. */
  wavPath: string;
  /** Plain-text transcript (one line of dialogue) — improves phoneme quality. */
  transcriptPath?: string;
  /** Timeout in milliseconds (default 60_000). */
  timeoutMs?: number;
  /** Inject a custom child_process spawn (used by tests). */
  spawnFn?: typeof spawn;
}

export interface InvokeRhubarbResult {
  /** Parsed Rhubarb JSON, ready to feed to {@link parseRhubarbJson}. */
  output: RhubarbOutput;
  /** Combined stderr output (warnings/diagnostics). */
  stderr: string;
}

/**
 * Invoke Rhubarb Lip Sync on a normalised audio file and return its JSON
 * output. Builds temp files for the output JSON and the dialog file, and
 * cleans them up on exit. On non-zero exit code or timeout, throws with the
 * captured stderr so the caller can decide whether to fall back.
 *
 * Command (matches the project's documented contract):
 *
 *   rhubarb --exportFormat json --output temp.json \
 *           --recognizer pocketSphinx \
 *           --dialogFile transcript.txt \
 *           --extendedShapes GHX \
 *           --threads 1 \
 *           utterance.wav
 */
export async function invokeRhubarb(opts: InvokeRhubarbOptions): Promise<InvokeRhubarbResult> {
  const binPath = opts.binPath;
  const wavPath = opts.wavPath;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const runSpawn = opts.spawnFn ?? spawn;

  const dir = mkdtempSync(join(tmpdir(), "rhubarb-"));
  const outJson = join(dir, "lipsync.json");
  let exited = false;

  try {
    const args = [
      "--exportFormat", "json",
      "--output", outJson,
      "--recognizer", "pocketSphinx",
      "--extendedShapes", "GHX",
      "--threads", "1",
    ];
    if (opts.transcriptPath) {
      args.push("--dialogFile", opts.transcriptPath);
    }
    args.push(wavPath);

    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const child = runSpawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const timer = setTimeout(() => {
        if (!exited) {
          child.kill("SIGTERM");
          rejectSpawn(new Error(`rhubarb timed out after ${timeoutMs}ms\n${stderr}`));
        }
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        rejectSpawn(err);
      });
      child.on("exit", (code, signal) => {
        exited = true;
        clearTimeout(timer);
        if (code === 0) {
          resolveSpawn();
        } else {
          rejectSpawn(
            new Error(`rhubarb exited with code ${code} (signal ${signal ?? "none"})\n${stderr}`),
          );
        }
      });
    });

    const jsonText = readFileSync(outJson, "utf8");
    const parsed = JSON.parse(jsonText) as RhubarbOutput;
    return { output: parsed, stderr: "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
