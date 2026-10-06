import assert from "node:assert/strict";
import { shouldDisableAdaptiveLearningForTurn } from "./adaptive-learning";

assert.equal(
	shouldDisableAdaptiveLearningForTurn({
		userText:
			"Inspect your own brain. Do not create, update, delete, or promote any memory facts or rationale records. Read only.",
	}),
	true,
	"read-only brain inspection disables adaptive learning",
);

assert.equal(
	shouldDisableAdaptiveLearningForTurn({
		userText:
			"Clean up these procedural memory facts without creating new memory facts or rationale records.",
	}),
	true,
	"cleanup tasks that forbid new cognitive writes disable adaptive learning",
);

assert.equal(
	shouldDisableAdaptiveLearningForTurn({
		userText:
			"Write exactly one tedi-scoped evidence memory fact for this workflow.",
	}),
	true,
	"explicit cognitive-write tasks suppress automatic after-turn learning",
);

assert.equal(
	shouldDisableAdaptiveLearningForTurn({
		userText:
			"Draft a new homepage section for the CMS and explain the changes.",
	}),
	false,
	"ordinary work keeps adaptive learning enabled",
);

console.log("PASS: adaptive learning turn gates");
