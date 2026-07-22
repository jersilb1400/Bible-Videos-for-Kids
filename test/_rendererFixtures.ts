import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadManifest, resolveRig } from "../src/assets.js";
import type { RigManifest, ResolvedRig } from "../src/assets.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST_PATH = join(REPO, "assets", "manifest.v1.json");

/** Load the real manifest from the repo for renderer tests. */
export function loadTestManifest(): RigManifest {
  return loadManifest(MANIFEST_PATH);
}

/** Resolve a character rig from the real manifest. */
export function loadTestRig(characterId: string): ResolvedRig {
  return resolveRig(loadTestManifest(), characterId);
}

/** Manifest path for tests that need it directly. */
export const funmanifest = MANIFEST_PATH;
