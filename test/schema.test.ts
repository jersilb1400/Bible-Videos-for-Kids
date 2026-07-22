import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EpisodeSchema,
  type Episode,
  type Story,
} from "../src/types.js";
import { adaptV1Story } from "../src/legacy/v1Adapter.js";

/**
 * A canonical valid v2 episode: "Daniel and the Lions' Den" with Daniel and
 * King Darius across four shots with real dialogue. Used as the happy path and
 * as the base for every rejection case (each case mutates a deep clone).
 *
 * Returns the raw object (typed loosely) WITHOUT parsing — each test does
 * its own parse so the helper can be reused for both the happy path and the
 * rejection cases (which mutate a clone before parsing).
 */
function validEpisode(): any {
  return {

    schemaVersion: 2,
    title: "Daniel and the Lions' Den",
    source: "Daniel 6",
    lesson: "God is with us even in scary places.",
    cast: [
      { characterId: "daniel", rigId: "rig:daniel", voiceId: "voice:daniel" },
      { characterId: "darius", rigId: "rig:darius", voiceId: "voice:darius" },
    ],
    shots: [
      {
        id: "shot-1",
        settingId: "setting:throne-room",
        actors: [{ characterId: "darius", x: 0.3, y: 0.5, scale: 1, pose: "neutral", facing: "right" }],
        leadIn: { text: "King Darius made a new law.", pauseAfterMs: 400 },
        dialogue: [
          {
            id: "line-1",
            speakerId: "darius",
            text: "No one may pray to anyone but me for thirty days!",
            emotion: "joy",
            pauseAfterMs: 500,
          },
        ],
        action: "",
        camera: "locked",
      },
      {
        id: "shot-2",
        settingId: "setting:upper-room",
        actors: [{ characterId: "daniel", x: 0.5, y: 0.5, scale: 1, pose: "neutral", facing: "right" }],
        leadIn: { text: "Daniel kept praying to God anyway.", pauseAfterMs: 400 },
        dialogue: [
          {
            id: "line-2",
            speakerId: "daniel",
            text: "Dear God, thank you for this day.",
            emotion: "neutral",
            pauseAfterMs: 300,
          },
        ],
        action: "",
        camera: "push-in",
      },
      {
        id: "shot-3",
        settingId: "setting:lions-den",
        actors: [
          { characterId: "daniel", x: 0.4, y: 0.6, scale: 1, pose: "neutral", facing: "right" },
          { characterId: "darius", x: 0.7, y: 0.4, scale: 1, pose: "neutral", facing: "left" },
        ],
        leadIn: { text: "Daniel was thrown into the lions' den.", pauseAfterMs: 500 },
        dialogue: [
          {
            id: "line-3",
            speakerId: "daniel",
            text: "God, please keep me safe.",
            emotion: "afraid",
            pauseAfterMs: 400,
          },
          {
            id: "line-4",
            speakerId: "darius",
            text: "I hope your God rescues you.",
            emotion: "sad",
            pauseAfterMs: 500,
          },
        ],
        action: "",
        camera: "locked",
      },
      {
        id: "shot-4",
        settingId: "setting:lions-den",
        actors: [
          { characterId: "daniel", x: 0.4, y: 0.6, scale: 1, pose: "neutral", facing: "right" },
          { characterId: "darius", x: 0.7, y: 0.4, scale: 1, pose: "neutral", facing: "left" },
        ],
        leadIn: { text: "Next morning, Daniel was safe!", pauseAfterMs: 400 },
        dialogue: [
          {
            id: "line-5",
            speakerId: "daniel",
            text: "God sent an angel to shut the lions' mouths!",
            emotion: "joy",
            pauseAfterMs: 500,
          },
          {
            id: "line-6",
            speakerId: "darius",
            text: "Your God is the true God!",
            emotion: "wonder",
            pauseAfterMs: 500,
          },
        ],
        action: "",
        camera: "push-in",
      },
    ],
  };
}

/** Deep clone helper so each rejection case starts from a known-good episode. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

test("EpisodeSchema accepts a valid v2 episode with 3+ shots and dialogue", () => {
  const ep = validEpisode();
  assert.equal(ep.schemaVersion, 2);
  assert.ok(ep.shots.length >= 3, "episode has at least 3 shots");
  assert.ok(ep.shots.every((s: any) => s.dialogue.length >= 1), "every shot has dialogue");
  assert.ok(ep.cast.length >= 1, "episode has a non-empty cast");
});

test("EpisodeSchema rejects a dialogue speaker not listed in the cast", () => {
  const ep = validEpisode();
  const bad = clone(ep);
  // Introduce a speaker (lion) that is not in the cast.
  bad.shots[0]!.dialogue[0]!.speakerId = "lion";
  assert.throws(
    () => EpisodeSchema.parse(bad),
    (err: unknown) => err instanceof Error && /cast/i.test(err.message),
    "should reject unknown speaker not in cast",
  );
});

test("EpisodeSchema rejects duplicate shot IDs", () => {
  const ep = validEpisode();
  const bad = clone(ep);
  bad.shots[1]!.id = bad.shots[0]!.id;
  assert.throws(
    () => EpisodeSchema.parse(bad),
    (err: unknown) => err instanceof Error && /shot/i.test(err.message),
    "should reject duplicate shot IDs",
  );
});

test("EpisodeSchema rejects duplicate dialogue line IDs across the episode", () => {
  const ep = validEpisode();
  const bad = clone(ep);
  // Reuse a line id from shot-1 inside shot-3.
  bad.shots[2]!.dialogue[0]!.id = bad.shots[0]!.dialogue[0]!.id;
  assert.throws(
    () => EpisodeSchema.parse(bad),
    (err: unknown) => err instanceof Error && /line/i.test(err.message),
    "should reject duplicate line IDs",
  );
});

test("EpisodeSchema rejects a dialogue speaker not present in that shot's actors", () => {
  const ep = validEpisode();
  const bad = clone(ep);
  // Shot-1 has only Darius as an actor; make the line belong to Daniel.
  bad.shots[0]!.dialogue[0]!.speakerId = "daniel";
  assert.throws(
    () => EpisodeSchema.parse(bad),
    (err: unknown) => err instanceof Error && /actor/i.test(err.message),
    "should reject a speaker who is not in the shot's actors",
  );
});

test("EpisodeSchema rejects a shot with empty dialogue", () => {
  const ep = validEpisode();
  const bad = clone(ep);
  bad.shots[0]!.dialogue = [];
  assert.throws(
    () => EpisodeSchema.parse(bad),
    (err: unknown) => err instanceof Error && /dialogue/i.test(err.message),
    "should reject a shot with no dialogue lines",
  );
});

test("EpisodeSchema rejects an episode with no cast", () => {
  const ep = validEpisode();
  const bad = clone(ep);
  bad.cast = [];
  assert.throws(
    () => EpisodeSchema.parse(bad),
    (err: unknown) => err instanceof Error && /cast/i.test(err.message),
    "should reject an episode with missing cast",
  );
});

test("EpisodeSchema rejects an episode with no shots", () => {
  const ep = validEpisode();
  const bad = clone(ep);
  bad.shots = [];
  assert.throws(
    () => EpisodeSchema.parse(bad),
    (err: unknown) => err instanceof Error,
    "should reject an episode with no shots",
  );
});

test("adaptV1Story converts a v1 Story into a valid v2 Episode", () => {
  // A minimal v1 story; adaptV1Story must turn each scene into one shot,
  // move narration into leadIn, and never fabricate dialogue.
  const v1Story: Story = {
    title: "Noah's Ark",
    source: "Genesis 6",
    lesson: "God keeps his promises.",
    characters: [
      { name: "Noah", description: "an old man with a white beard", palette: { skin: "#eab", hair: "#fff", robe: "#39f" } },
      { name: "God", description: "a voice from the sky", palette: { skin: "#ffd", hair: "#fff", robe: "#fff" } },
    ],
    scenes: [
      {
        narration: "God told Noah to build a big boat.",
        visual: "Noah with tools and wood",
        characters: ["Noah"],
        setting: "day",
      },
      {
        narration: "Noah loaded the animals two by two.",
        visual: "pairs of animals walking onto the ark",
        characters: ["Noah"],
        setting: "day",
      },
      {
        narration: "The rain fell for forty days.",
        visual: "the ark floating on flood waters",
        characters: ["Noah"],
        setting: "water",
      },
    ],
  };

  const episode = adaptV1Story(v1Story);

  // Round-trips cleanly through the v2 schema.
  const parsed = EpisodeSchema.parse(episode);
  assert.equal(parsed.title, "Noah's Ark");
  assert.equal(parsed.source, "Genesis 6");
  assert.equal(parsed.shots.length, 3, "one shot per v1 scene");

  // Each shot's narration must have moved into leadIn (not fabricated dialogue).
  for (let i = 0; i < parsed.shots.length; i++) {
    const shot = parsed.shots[i]!;
    assert.ok(shot.leadIn, `shot ${i} carries the scene narration as leadIn`);
    assert.equal(
      shot.leadIn!.text,
      v1Story.scenes[i]!.narration,
      `shot ${i} leadIn is the original scene narration`,
    );
    // Legacy adapter must NOT invent dialogue: every line must be a real spoken
    // line we choose to keep (none, for a narration-only v1 story). We assert
    // the adapter marks the shot as legacy via the action field.
    assert.match(shot.action, /legacy/i, `shot ${i} is marked as legacy`);
  }

  // Cast must be derived from the v1 characters (no fabrication).
  const castIds = parsed.cast.map((c) => c.characterId).sort();
  assert.deepEqual(castIds, ["god", "noah"], "cast is derived from v1 characters");
});

test("adaptV1Story never fabricates dialogue for narration-only v1 scenes", () => {
  const v1Story: Story = {
    title: "Baby Moses",
    source: "Exodus 2",
    lesson: "God protects little ones.",
    characters: [
      { name: "Moses", description: "a baby in a basket", palette: { skin: "#eab", hair: "#000", robe: "#fff" } },
      { name: "Miriam", description: "Moses' big sister", palette: { skin: "#eab", hair: "#321", robe: "#39f" } },
    ],
    scenes: [
      {
        narration: "Miriam hid baby Moses in a basket by the river.",
        visual: "a basket in the reeds",
        characters: ["Miriam", "Moses"],
        setting: "water",
      },
      {
        narration: "The princess found him and loved him.",
        visual: "an Egyptian princess lifting the basket",
        characters: ["Moses"],
        setting: "day",
      },
      {
        narration: "Miriam offered to find a nurse for the baby.",
        visual: "Miriam talking to the princess",
        characters: ["Miriam"],
        setting: "day",
      },
    ],
  };

  const episode = adaptV1Story(v1Story);
  const parsed = EpisodeSchema.parse(episode);

  for (const shot of parsed.shots) {
    assert.equal(
      shot.dialogue.length,
      0,
      "adapter must not fabricate dialogue lines for narration-only v1 scenes",
    );
  }
});
