import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  loadManifest,
  resolveRig,
  type RigManifest,
  type ResolvedRig,
} from "../src/assets.js";

const REPO = workingDir();
const MANIFEST = join(REPO, "assets", "manifest.v1.json");

/** Resolve the repo root from this test file's location.
 * `test/assets.test.ts` → /repo (test/ is one level under repo root).
 * Uses fileURLToPath so spaces in the path survive (no %20). */
function workingDir(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

test("loadManifest: loads and validates assets/manifest.v1.json", () => {
  const m = loadManifest(MANIFEST);
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.characters.length, 2);
  assert.deepEqual(
    m.characters.map((c) => c.id).sort(),
    ["daniel", "darius"],
  );
});

test("resolveRig: Daniel has all required mouths (A–F and X)", () => {
  const m = loadManifest(MANIFEST);
  const rig = resolveRig(m, "daniel");
  assert.equal(rig.characterId, "daniel");
  // Required visemes A–F must all resolve to absolute paths that exist.
  for (const shape of ["A", "B", "C", "D", "E", "F", "X"] as const) {
    assert.ok(rig.mouths[shape], `missing mouth ${shape}`);
    assert.ok(
      rig.mouths[shape]!.isAbsolute,
      `mouth ${shape} path is not absolute: ${rig.mouths[shape]}`,
    );
    assert.ok(
      rig.mouths[shape]!.exists,
      `mouth ${shape} file does not exist: ${rig.mouths[shape]}`,
    );
  }
  // G / H are optional and absent in the current manifest.
  assert.equal(rig.mouths["G"], undefined);
  assert.equal(rig.mouths["H"], undefined);
  // Body and eye assets must also resolve.
  assert.ok(rig.body.exists, `body missing: ${rig.body}`);
  assert.ok(rig.eyes.open.exists, `eyes.open missing: ${rig.eyes.open}`);
  assert.ok(rig.eyes.closed.exists, `eyes.closed missing: ${rig.eyes.closed}`);
});

test("resolveRig: Darius has all required mouths (A–F and X)", () => {
  const m = loadManifest(MANIFEST);
  const rig = resolveRig(m, "darius");
  for (const shape of ["A", "B", "C", "D", "E", "F", "X"] as const) {
    assert.ok(rig.mouths[shape], `missing mouth ${shape}`);
    assert.ok(
      rig.mouths[shape]!.exists,
      `mouth ${shape} file does not exist: ${rig.mouths[shape]}`,
    );
  }
});

test("resolveRig: resolved paths are absolute and anchored to the manifest dir", () => {
  const m = loadManifest(MANIFEST);
  const rig = resolveRig(m, "daniel");
  const assetsDir = join(REPO, "assets");
  assert.ok(
    rig.body.pathname.startsWith(assetsDir),
    `body path ${rig.body.pathname} not under ${assetsDir}`,
  );
  assert.ok(
    rig.mouths["A"]!.pathname.startsWith(assetsDir),
    `mouth A path not under assets`,
  );
});

test("resolveRig: rejects path traversal in manifest paths (../ in path)", () => {
  // Build a manifest in a temp dir whose character body path escapes via ../
  const tmp = mkdtempSync(join(tmpdir(), "rig-trav-"));
  const sub = mkdtempSync(join(tmpdir(), "rig-trav-target-"));
  // A file to "escape to" — proves traversal could read outside assets.
  writeFileSync(join(sub, "secret.txt"), "topsecret");
  const escapedBody = join(sub, "secret.txt");
  const evil = {
    schemaVersion: 1,
    characters: [
      {
        id: "evil",
        revision: "1",
        body: "../escape/../../" + relativeEscape(sub, tmp) + "/secret.txt",
        eyes: { open: "eyes/open.svg", closed: "eyes/closed.svg" },
        mouths: {
          X: "mouths/X.svg", A: "mouths/A.svg", B: "mouths/B.svg",
          C: "mouths/C.svg", D: "mouths/D.svg", E: "mouths/E.svg", F: "mouths/F.svg",
        },
        poses: { neutral: "body.svg" },
        voice: { providerVoiceId: "x", rate: 1, pitch: 0 },
        anchors: { mouth: [0.5, 0.41], ground: [0.5, 1.0] },
      },
    ],
    backgrounds: {},
  };
  writeFileSync(join(tmp, "manifest.v1.json"), JSON.stringify(evil));
  const m = loadManifest(join(tmp, "manifest.v1.json"));
  assert.throws(
    () => resolveRig(m, "evil"),
    /path traversal|outside.*directory|\.\.\//i,
    `resolveRig must reject path traversal but accepted: ${escapedBody}`,
  );
});

test("resolveRig: rejects missing character", () => {
  const m = loadManifest(MANIFEST);
  assert.throws(
    () => resolveRig(m, "nonexistent"),
    /not found|unknown character|no character/i,
  );
});

test("resolveRig: rejects manifest pointing at a missing file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rig-missing-"));
  const evil = {
    schemaVersion: 1,
    characters: [
      {
        id: "ghost",
        revision: "1",
        body: "characters/ghost/body.svg",
        eyes: { open: "eyes/open.svg", closed: "eyes/closed.svg" },
        mouths: {
          X: "mouths/X.svg", A: "mouths/A.svg", B: "mouths/B.svg",
          C: "mouths/C.svg", D: "mouths/D.svg", E: "mouths/E.svg", F: "mouths/F.svg",
        },
        poses: { neutral: "body.svg" },
        voice: { providerVoiceId: "x", rate: 1, pitch: 0 },
        anchors: { mouth: [0.5, 0.41], ground: [0.5, 1.0] },
      },
    ],
    backgrounds: {},
  };
  writeFileSync(join(tmp, "manifest.v1.json"), JSON.stringify(evil));
  const m = loadManifest(join(tmp, "manifest.v1.json"));
  assert.throws(
    () => resolveRig(m, "ghost"),
    /not found|missing|ENOENT/i,
  );
});

test("resolveRig: rejects manifest missing a required mouth (A–F or X)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rig-nomouth-"));
  // Copy a minimal valid structure but omit mouth E.
  const evil = {
    schemaVersion: 1,
    characters: [
      {
        id: "incomplete",
        revision: "1",
        body: "body.svg",
        eyes: { open: "eyes/open.svg", closed: "eyes/closed.svg" },
        mouths: {
          // E deliberately omitted.
          X: "mouths/X.svg", A: "mouths/A.svg", B: "mouths/B.svg",
          C: "mouths/C.svg", D: "mouths/D.svg", F: "mouths/F.svg",
        },
        poses: { neutral: "body.svg" },
        voice: { providerVoiceId: "x", rate: 1, pitch: 0 },
        anchors: { mouth: [0.5, 0.41], ground: [0.5, 1.0] },
      },
    ],
    backgrounds: {},
  };
  writeFileSync(join(tmp, "manifest.v1.json"), JSON.stringify(evil));
  // loadManifest detects the structural problem; resolveRig would never see
  // such a manifest because loadManifest guards the door. Either layer must
  // throw — assert.throws across both.
  let manifest: RigManifest | undefined;
  try {
    manifest = loadManifest(join(tmp, "manifest.v1.json"));
  } catch (err) {
    assert.match(
      (err as Error).message,
      /missing required mouth|mouth.*E/i,
      `loadManifest threw but for the wrong reason: ${(err as Error).message}`,
    );
    return;
  }
  // loadManifest accepted it (unexpected — defensive fallback). resolveRig
  // must reject.
  assert.throws(
    () => resolveRig(manifest!, "incomplete"),
    /missing required mouth|mouth.*E/i,
  );
});

/** Compute a relative `../…` path from `from` to `to` so an evil manifest can
 * reference a file outside its own assets dir. */
function relativeEscape(to: string, from: string): string {
  let rel = "";
  // Walk up from `from` until we reach the common ancestor with `to`.
  let f = from;
  while (!to.startsWith(f + "/") && f !== "/") {
    rel += "../";
    f = f.slice(0, f.lastIndexOf("/"));
  }
  return rel + to.slice(f.length + 1);
}
