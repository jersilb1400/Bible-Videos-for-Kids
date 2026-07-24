import assert from "node:assert/strict";
import { test } from "node:test";
import { DirectorPromptBuilder, canonicalId } from "../src/director/promptBuilder.js";
import { fallbackDirect } from "../src/director/fallback.js";
import { directEpisode, parseLlmResponse, LlmParseError, LlmRequestError } from "../src/director/direct.js";
import { EpisodeSchema } from "../src/types.js";
import { DirectorResponseSchema } from "../src/director/types.js";
import type { ScreenplayInput, DirectorConfig } from "../src/director/types.js";
import { DEFAULT_DIRECTOR_CONFIG } from "../src/director/types.js";

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

/** A minimal 2-character, 3-scene screenplay (structurally a v1 Story). */
function sampleScreenplay(): ScreenplayInput {
  return {
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
        narration: "The rain fell for forty days, and God kept them safe!",
        visual: "the ark floating on flood waters, a rainbow appears",
        characters: ["Noah"],
        setting: "water",
      },
    ],
  };
}

const onlineConfig: DirectorConfig = {
  endpoint: "https://api.example.com/v1",
  model: "gpt-4o",
  apiKey: "test-key",
  targetAge: "3-8",
  tone: "gentle",
  pacing: "medium",
  humorLevel: "subtle",
};

// ---------------------------------------------------------------------------
// Tests: DirectorPromptBuilder.
// ---------------------------------------------------------------------------

test("DirectorPromptBuilder.build returns system + user prompts", () => {
  const builder = new DirectorPromptBuilder(onlineConfig);
  const { system, user } = builder.build(sampleScreenplay());
  assert.ok(typeof system === "string" && system.length > 100, "system prompt is a non-empty string");
  assert.ok(typeof user === "string" && user.length > 100, "user prompt is a non-empty string");
});

test("System prompt includes character positioning rules", () => {
  const builder = new DirectorPromptBuilder(onlineConfig);
  const system = builder.buildSystemPrompt();
  assert.match(system, /rule of thirds/i, "mentions rule of thirds");
  assert.match(system, /dialogue facing/i, "mentions dialogue facing");
  assert.match(system, /speaker prominence/i, "mentions speaker prominence");
});

test("System prompt includes camera language", () => {
  const builder = new DirectorPromptBuilder(onlineConfig);
  const system = builder.buildSystemPrompt();
  assert.match(system, /locked/i, "mentions locked camera");
  assert.match(system, /push-in/i, "mentions push-in camera");
  assert.match(system, /pan-left/i, "mentions pan-left");
  assert.match(system, /pan-right/i, "mentions pan-right");
});

test("System prompt includes animation suggestions", () => {
  const builder = new DirectorPromptBuilder(onlineConfig);
  const system = builder.buildSystemPrompt();
  assert.match(system, /point/i, "mentions pointing animation");
  assert.match(system, /wave/i, "mentions waving animation");
  assert.match(system, /pray/i, "mentions praying animation");
  assert.match(system, /sit/i, "mentions sitting animation");
  assert.match(system, /walk/i, "mentions walking animation");
});

test("System prompt includes gesture timing cues with pause durations", () => {
  const builder = new DirectorPromptBuilder(onlineConfig);
  const system = builder.buildSystemPrompt();
  assert.match(system, /gesture timing/i, "mentions gesture timing");
  assert.match(system, /pause/i, "mentions pauses");
  assert.match(system, /joy.*500.*700|500.*joy/i, "joy pause range mentioned"); // loose match
});

test("System prompt includes reaction shots for listening characters", () => {
  const builder = new DirectorPromptBuilder(onlineConfig);
  const system = builder.buildSystemPrompt();
  assert.match(system, /reaction shot/i, "mentions reaction shots");
  assert.match(system, /listen/i, "mentions listening characters");
});

test("System prompt includes output format with JSON shape", () => {
  const builder = new DirectorPromptBuilder(onlineConfig);
  const system = builder.buildSystemPrompt();
  assert.match(system, /"shots"/, "shows shots array in output format");
  assert.match(system, /"director"/, "shows director metadata in output format");
  assert.match(system, /"staging"/, "shows staging in output format");
  assert.match(system, /"cameraRationale"/, "shows cameraRationale in output format");
  assert.match(system, /"animationSuggestions"/, "shows animationSuggestions in output format");
});

test("System prompt enforces content safety for kids", () => {
  const builder = new DirectorPromptBuilder(onlineConfig);
  const system = builder.buildSystemPrompt();
  assert.match(system, /children ages 3.?8/i, "mentions target age range");
  assert.match(system, /gentle|safe|joyful/i, "mentions content safety");
});

test("User prompt includes screenplay title, source, lesson, characters, and scenes", () => {
  const builder = new DirectorPromptBuilder(onlineConfig);
  const sp = sampleScreenplay();
  const user = builder.buildUserPrompt(sp);
  assert.match(user, /Noah's Ark/, "includes title");
  assert.match(user, /Genesis 6/, "includes source");
  assert.match(user, /God keeps his promises/, "includes lesson");
  assert.match(user, /Noah/, "includes character name");
  assert.match(user, /build a big boat/, "includes scene narration");
  assert.match(user, /Scene 1/, "labels scenes");
});

test("User prompt includes directing style parameters from config", () => {
  const builder = new DirectorPromptBuilder(onlineConfig);
  const user = builder.buildUserPrompt(sampleScreenplay());
  assert.match(user, /ages 3-8/, "includes target age");
  assert.match(user, /tone: gentle/i, "includes tone");
  assert.match(user, /pacing: medium/i, "includes pacing");
  assert.match(user, /humour level: subtle/i, "includes humor level");
});

test("canonicalId lowercases, trims, and hyphenates names", () => {
  assert.equal(canonicalId("Noah"), "noah");
  assert.equal(canonicalId("  King Darius  "), "king-darius");
  assert.equal(canonicalId("Baby Moses"), "baby-moses");
});

// ---------------------------------------------------------------------------
// Tests: Fallback deterministic director.
// ---------------------------------------------------------------------------

test("fallbackDirect produces a valid DirectedEpisode from a screenplay", () => {
  const episode = fallbackDirect(sampleScreenplay(), DEFAULT_DIRECTOR_CONFIG);
  assert.equal(episode.schemaVersion, 2);
  assert.equal(episode.title, "Noah's Ark");
  assert.equal(episode.shots.length, 3, "one shot per scene");
  assert.ok(episode.cast.length >= 1, "has cast");

  // Validates cleanly through the v2 EpisodeSchema.
  const stripped = {
    schemaVersion: 2 as const,
    title: episode.title,
    source: episode.source,
    lesson: episode.lesson,
    cast: episode.cast,
    shots: episode.shots.map((s) => {
      const { director: _d, ...rest } = s;
      return rest;
    }),
  };
  EpisodeSchema.parse(stripped);
});

test("fallbackDirect centre-stages sole characters", () => {
  const episode = fallbackDirect(sampleScreenplay(), DEFAULT_DIRECTOR_CONFIG);
  // Scene 1 has only Noah → he's at x=0.5.
  const shot1 = episode.shots[0]!;
  assert.equal(shot1.actors.length, 1, "shot 1 has one actor");
  assert.equal(shot1.actors[0]!.characterId, "noah");
  assert.equal(shot1.actors[0]!.x, 0.5, "sole actor is centred");
});

test("fallbackDirect uses push-in for joy/wonder and locked for neutral", () => {
  const episode = fallbackDirect(sampleScreenplay(), DEFAULT_DIRECTOR_CONFIG);
  // Scene 1: "God told Noah to build a big boat" → neutral → locked.
  const shot1 = episode.shots[0]!;
  assert.equal(shot1.camera, "locked", "neutral scene → locked camera");
  // Scene 3: "God kept them safe!" → joy → push-in.
  const shot3 = episode.shots[2]!;
  assert.equal(shot3.camera, "push-in", "joy scene → push-in camera");
});

test("fallbackDirect assigns speaker prominence (scale > 1 for first actor)", () => {
  const episode = fallbackDirect(sampleScreenplay(), DEFAULT_DIRECTOR_CONFIG);
  // In every shot, the first actor (speaker) should have scale > 1.
  for (const shot of episode.shots) {
    if (shot.actors.length >= 1) {
      assert.ok(
        shot.actors[0]!.scale >= 1.1,
        `first actor (speaker) has prominence scale ${shot.actors[0]!.scale}`,
      );
    }
  }
});

test("fallbackDirect fills director metadata on every shot", () => {
  const episode = fallbackDirect(sampleScreenplay(), DEFAULT_DIRECTOR_CONFIG);
  for (let i = 0; i < episode.shots.length; i++) {
    const shot = episode.shots[i]!;
    assert.ok(shot.director, `shot ${i} has director metadata`);
    assert.ok(typeof shot.director.staging === "string" && shot.director.staging.length > 0, `shot ${i} has staging`);
    assert.ok(typeof shot.director.cameraRationale === "string" && shot.director.cameraRationale.length > 0, `shot ${i} has cameraRationale`);
    assert.ok(Array.isArray(shot.director.animationSuggestions), `shot ${i} has animationSuggestions array`);
    assert.ok(Array.isArray(shot.director.gestureTiming), `shot ${i} has gestureTiming array`);
    assert.ok(Array.isArray(shot.director.reactionShots), `shot ${i} has reactionShots array`);
    // Every actor should have an animation suggestion.
    assert.equal(
      shot.director.animationSuggestions.length,
      shot.actors.length,
      `shot ${i}: one animation suggestion per actor`,
    );
  }
});

test("fallbackDirect assigns emotion to dialogue lines", () => {
  const episode = fallbackDirect(sampleScreenplay(), DEFAULT_DIRECTOR_CONFIG);
  // Scene 3 has "God kept them safe!" → joy.
  const shot3 = episode.shots[2]!;
  assert.ok(shot3.dialogue.length >= 1, "shot 3 has dialogue");
  const emotion = shot3.dialogue[0]!.emotion;
  assert.ok(
    emotion === "joy" || emotion === "wonder",
    `scene 3 emotion is joy/wonder (got ${emotion})`,
  );
});

test("fallbackDirect pause durations match emotion rules", () => {
  const episode = fallbackDirect(sampleScreenplay(), DEFAULT_DIRECTOR_CONFIG);
  // Neutral scene → 300ms pause.
  const shot1Pause = episode.shots[0]!.dialogue[0]!.pauseAfterMs;
  assert.equal(shot1Pause, 300, "neutral scene → 300ms pause");
  // Joy scene → 500ms pause.
  const shot3Pause = episode.shots[2]!.dialogue[0]!.pauseAfterMs;
  assert.equal(shot3Pause, 500, "joy scene → 500ms pause");
});

test("fallbackDirect handles multi-character scenes with rule-of-thirds spacing", () => {
  const sp: ScreenplayInput = {
    title: "Daniel and the Lions",
    source: "Daniel 6",
    lesson: "God protects us.",
    characters: [
      { name: "Daniel", description: "a young man", palette: { skin: "#eab", hair: "#321", robe: "#39f" } },
      { name: "Darius", description: "a king", palette: { skin: "#eab", hair: "#000", robe: "#933" } },
    ],
    scenes: [
      {
        narration: "King Darius made a new law. No one may pray to anyone but me!",
        visual: "King Darius on his throne",
        characters: ["Darius", "Daniel"],
        setting: "indoor",
      },
      {
        narration: "Daniel bravely kept praying to God three times a day.",
        visual: "Daniel kneeling to pray",
        characters: ["Daniel"],
        setting: "indoor",
      },
      {
        narration: "God sent an angel to shut the lions' mouths. Daniel was safe and joyful!",
        visual: "Daniel and King Darius celebrate in the lions' den",
        characters: ["Daniel", "Darius"],
        setting: "indoor",
      },
    ],
  };
  const episode = fallbackDirect(sp, DEFAULT_DIRECTOR_CONFIG);

  // Shot 1: two actors, spread across thirds.
  const shot1 = episode.shots[0]!;
  assert.equal(shot1.actors.length, 2, "shot 1 has two actors");
  assert.ok(shot1.actors[0]!.x < shot1.actors[1]!.x, "first actor left of second");
  assert.ok(shot1.actors[0]!.x > 0, "first actor not at edge");
  assert.ok(shot1.actors[1]!.x < 1, "second actor not at edge");
  // They face each other.
  assert.notEqual(shot1.actors[0]!.facing, shot1.actors[1]!.facing, "actors face different directions");

  // Shot 2: single character centered.
  const shot2 = episode.shots[1]!;
  assert.equal(shot2.actors.length, 1, "shot 2 has one actor");
  assert.equal(shot2.actors[0]!.x, 0.5, "sole actor centered");
  // "bravely" → brave emotion → 350ms pause.
  assert.equal(shot2.dialogue[0]!.emotion, "brave", "brave keyword detected");
  assert.equal(shot2.dialogue[0]!.pauseAfterMs, 350, "brave → 350ms pause");

  // Shot 3: "safe and joyful" → joy → push-in.
  const shot3 = episode.shots[2]!;
  assert.equal(shot3.camera, "push-in", "joy detected → push-in");
  assert.equal(shot3.dialogue[0]!.pauseAfterMs, 500, "joy → 500ms pause");
});

test("fallbackDirect reaction shots target non-speaking actors", () => {
  const sp: ScreenplayInput = {
    title: "Daniel and the Lions",
    source: "Daniel 6",
    lesson: "God protects us.",
    characters: [
      { name: "Daniel", description: "a young man", palette: { skin: "#eab", hair: "#321", robe: "#39f" } },
      { name: "Darius", description: "a king", palette: { skin: "#eab", hair: "#000", robe: "#933" } },
    ],
    scenes: [
      {
        narration: "King Darius made a new law!",
        visual: "King Darius on his throne",
        characters: ["Darius", "Daniel"],
        setting: "indoor",
      },
    ],
  };
  const episode = fallbackDirect(sp, DEFAULT_DIRECTOR_CONFIG);
  const shot1 = episode.shots[0]!;
  // Speaker is the first listed character, Darius. Daniel should get a reaction.
  assert.ok(shot1.director.reactionShots.length >= 1, "at least one reaction shot for the listener");
  const reaction = shot1.director.reactionShots[0]!;
  assert.equal(reaction.characterId, "daniel", "reaction targets the listening character");
  assert.equal(reaction.triggerLineId, shot1.dialogue[0]!.id, "reaction is keyed to the line id");
});

test("fallbackDirect derives animation poses from scene content", () => {
  const sp: ScreenplayInput = {
    title: "Prayer Test",
    source: "Daniel 6",
    lesson: "God hears our prayers.",
    characters: [
      { name: "Daniel", description: "a young man", palette: { skin: "#eab", hair: "#321", robe: "#39f" } },
    ],
    scenes: [
      { narration: "Daniel prayed to God three times a day.", visual: "Daniel kneeling in prayer", characters: ["Daniel"], setting: "indoor" },
      { narration: "Daniel waved hello to his friends.", visual: "Daniel greeting friends", characters: ["Daniel"], setting: "day" },
      { narration: "Daniel pointed at the beautiful rainbow.", visual: "Daniel showing a rainbow", characters: ["Daniel"], setting: "day" },
    ],
  };
  const episode = fallbackDirect(sp, DEFAULT_DIRECTOR_CONFIG);
  // Scene 1 → pray pose.
  assert.equal(episode.shots[0]!.actors[0]!.pose, "pray", "prayer scene → pray pose");
  // Scene 2 → wave pose.
  assert.equal(episode.shots[1]!.actors[0]!.pose, "wave", "greeting scene → wave pose");
  // Scene 3 → point pose.
  assert.equal(episode.shots[2]!.actors[0]!.pose, "point", "directing attention → point pose");
});

// ---------------------------------------------------------------------------
// Tests: LLM response parser (parseLlmResponse).
// ---------------------------------------------------------------------------

/** A valid LLM response JSON string matching DirectorResponseSchema. */
function validLlmResponse(): string {
  return JSON.stringify({
    shots: [
      {
        id: "shot-1",
        settingId: "indoor",
        actors: [
          { characterId: "noah", x: 0.5, y: 0.5, scale: 1.2, pose: "wave", facing: "right" },
        ],
        leadIn: { text: "Noah built an ark.", pauseAfterMs: 400 },
        dialogue: [
          { id: "line-1", speakerId: "noah", text: "Let's build a big boat!", emotion: "joy", pauseAfterMs: 500 },
        ],
        action: "Noah waves",
        camera: "push-in",
        director: {
          staging: "Noah centred, sole focus.",
          cameraRationale: "Joy detected, push-in for emotional beat.",
          animationSuggestions: [
            { characterId: "noah", clipId: "wave", reasoning: "Greeting scene." },
          ],
          gestureTiming: [
            { lineId: "line-1", startMs: 0, durationMs: 800, gesture: "wave" },
          ],
          reactionShots: [],
        },
      },
      {
        id: "shot-2",
        settingId: "water",
        actors: [
          { characterId: "noah", x: 0.5, y: 0.5, scale: 1.0, pose: "neutral", facing: "right" },
        ],
        dialogue: [
          { id: "line-2", speakerId: "noah", text: "The flood waters came.", emotion: "sad", pauseAfterMs: 400 },
        ],
        action: "",
        camera: "locked",
        director: {
          staging: "Noah centred.",
          cameraRationale: "Sad moment, locked camera.",
          animationSuggestions: [],
          gestureTiming: [],
          reactionShots: [],
        },
      },
    ],
  });
}

test("parseLlmResponse accepts a valid LLM JSON response", () => {
  const shots = parseLlmResponse(validLlmResponse());
  assert.equal(shots.length, 2, "parsed two shots");
  assert.equal(shots[0]!.id, "shot-1");
  assert.ok(shots[0]!.director, "shot 1 has director metadata");
  assert.equal(shots[0]!.director.staging, "Noah centred, sole focus.");
  assert.equal(shots[0]!.director.animationSuggestions.length, 1);
  assert.equal(shots[0]!.director.animationSuggestions[0]!.clipId, "wave");
});

test("parseLlmResponse strips markdown code fences", () => {
  const fenced = "```json\n" + validLlmResponse() + "\n```";
  const shots = parseLlmResponse(fenced);
  assert.equal(shots.length, 2, "parsed despite markdown fences");
});

test("parseLlmResponse handles extra unknown fields gracefully", () => {
  const raw = validLlmResponse();
  const obj = JSON.parse(raw);
  // Add extra unknown fields at shot and director level.
  obj.shots[0].unexpectedField = "ignore me";
  obj.shots[0].director.unknownMeta = 42;
  obj.unusedTopLevel = true;
  const shots = parseLlmResponse(JSON.stringify(obj));
  assert.equal(shots.length, 2, "extra fields don't break parsing");
  // Zod .strip() removes unknown keys.
  assert.ok(
    !("unexpectedField" in shots[0]!),
    "unknown shot-level field is stripped",
  );
  assert.ok(
    !("unknownMeta" in (shots[0]!.director as any)),
    "unknown director field is stripped",
  );
});

test("parseLlmResponse throws LlmParseError on malformed JSON", () => {
  const bad = "this is not json at all";
  assert.throws(
    () => parseLlmResponse(bad),
    (err: unknown) => err instanceof LlmParseError,
    "malformed JSON throws LlmParseError",
  );
});

test("parseLlmResponse throws LlmParseError on valid JSON with missing required fields", () => {
  // Missing required `shots` array.
  const missingShots = JSON.stringify({ title: "Test" });
  assert.throws(
    () => parseLlmResponse(missingShots),
    (err: unknown) => err instanceof LlmParseError,
    "missing shots array throws LlmParseError",
  );

  // Shots array present but shot missing required `id`.
  const missingId = JSON.stringify({
    shots: [
      { settingId: "indoor", actors: [], dialogue: [], camera: "locked" },
    ],
  });
  assert.throws(
    () => parseLlmResponse(missingId),
    (err: unknown) => err instanceof LlmParseError,
    "missing shot id throws LlmParseError",
  );
});

test("parseLlmResponse throws LlmParseError on shots array with zero items", () => {
  const emptyShots = JSON.stringify({ shots: [] });
  assert.throws(
    () => parseLlmResponse(emptyShots),
    (err: unknown) => err instanceof LlmParseError,
    "empty shots array throws LlmParseError",
  );
});

test("parseLlmResponse fills defaults for missing optional director fields", () => {
  const raw = JSON.stringify({
    shots: [
      {
        id: "shot-1",
        settingId: "indoor",
        actors: [
          { characterId: "noah", x: 0.5, y: 0.5, scale: 1, pose: "neutral", facing: "right" },
        ],
        dialogue: [
          { id: "line-1", speakerId: "noah", text: "Hello!", emotion: "neutral", pauseAfterMs: 300 },
        ],
        action: "",
        camera: "locked",
        // No director block at all.
      },
    ],
  });
  const shots = parseLlmResponse(raw);
  assert.ok(shots[0]!.director, "director metadata is filled with defaults");
  assert.equal(shots[0]!.director.staging, "", "default staging is empty string");
  assert.equal(shots[0]!.director.animationSuggestions.length, 0, "default animations is empty array");
  assert.equal(shots[0]!.director.gestureTiming.length, 0, "default gestureTiming is empty array");
  assert.equal(shots[0]!.director.reactionShots.length, 0, "default reactionShots is empty array");
});

// ---------------------------------------------------------------------------
// Tests: directEpisode (integration: LLM call + fallback).
// ---------------------------------------------------------------------------

/** A mock fetch that returns a canned valid LLM response.
 * Wraps the DirectorResponse JSON in an OpenAI chat-completion envelope
 * so callLlmForShots can extract choices[0].message.content.
 */
function mockFetchValid(): typeof fetch {
  return (async (_url: string | URL | Request, _init?: RequestInit) => {
    const envelope = JSON.stringify({
      choices: [
        { message: { content: validLlmResponse() }, finish_reason: "stop" },
      ],
    });
    return new Response(envelope, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

/** A mock fetch that returns a 500 error. */
function mockFetchError(): typeof fetch {
  return (async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response("Internal Server Error", { status: 500 });
  }) as typeof fetch;
}

test("directEpisode uses fallback when no endpoint is configured", async () => {
  const ep = await directEpisode(sampleScreenplay(), DEFAULT_DIRECTOR_CONFIG);
  assert.equal(ep.title, "Noah's Ark");
  assert.equal(ep.shots.length, 3, "fallback produces one shot per scene");
  assert.ok(ep.shots.every((s) => s.director), "all shots have director metadata");
});

test("directEpisode uses fallback when endpoint is empty string", async () => {
  const cfg: DirectorConfig = { ...DEFAULT_DIRECTOR_CONFIG, endpoint: "", model: "", apiKey: "" };
  const ep = await directEpisode(sampleScreenplay(), cfg);
  assert.equal(ep.shots.length, 3, "empty config → fallback → 3 shots");
});

test("directEpisode uses fallback when apiKey is empty", async () => {
  const cfg: DirectorConfig = { ...onlineConfig, apiKey: "" };
  const ep = await directEpisode(sampleScreenplay(), cfg, { fetchImpl: mockFetchValid() });
  assert.equal(ep.shots.length, 3, "no apiKey → fallback → 3 shots from screenplay");
});

test("directEpisode parses LLM response when endpoint is configured", async () => {
  const ep = await directEpisode(sampleScreenplay(), onlineConfig, {
    fetchImpl: mockFetchValid(),
  });
  assert.equal(ep.title, "Noah's Ark");
  assert.equal(ep.shots.length, 2, "LLM response has 2 shots");
  assert.ok(ep.shots[0]!.director, "LLM shot has director metadata");
  assert.equal(ep.shots[0]!.director.animationSuggestions[0]!.clipId, "wave");
});

test("directEpisode falls back to deterministic director on LLM HTTP error", async () => {
  const ep = await directEpisode(sampleScreenplay(), onlineConfig, {
    fetchImpl: mockFetchError(),
    useFallbackOnFailure: true,
  });
  assert.equal(ep.shots.length, 3, "LLM error → fallback → 3 shots from screenplay");
  assert.equal(ep.shots[0]!.id, "shot-1", "fallback shot ids are deterministic");
});

test("directEpisode throws LlmRequestError when useFallbackOnFailure is false and LLM fails", async () => {
  await assert.rejects(
    () => directEpisode(sampleScreenplay(), onlineConfig, {
      fetchImpl: mockFetchError(),
      useFallbackOnFailure: false,
    }),
    (err: unknown) => err instanceof LlmRequestError,
    "non-fallback mode surfaces LLM errors",
  );
});

test("directEpisode produces episodes that validate through EpisodeSchema", async () => {
  // Test both the fallback path and the LLM path.
  const fallbackEp = await directEpisode(sampleScreenplay(), DEFAULT_DIRECTOR_CONFIG);
  const stripped = {
    schemaVersion: 2 as const,
    title: fallbackEp.title,
    source: fallbackEp.source,
    lesson: fallbackEp.lesson,
    cast: fallbackEp.cast,
    shots: fallbackEp.shots.map((s) => {
      const { director: _d, ...rest } = s;
      return rest;
    }),
  };
  EpisodeSchema.parse(stripped);

  const llmEp = await directEpisode(sampleScreenplay(), onlineConfig, {
    fetchImpl: mockFetchValid(),
  });
  const stripped2 = {
    schemaVersion: 2 as const,
    title: llmEp.title,
    source: llmEp.source,
    lesson: llmEp.lesson,
    cast: llmEp.cast,
    shots: llmEp.shots.map((s) => {
      const { director: _d, ...rest } = s;
      return rest;
    }),
  };
  EpisodeSchema.parse(stripped2);
});
