import assert from "node:assert/strict";
import { embeddedUserText } from "./embedded-transcript";
import {
	createLearningTelemetry,
	learningUserTextLength,
	type LearningTelemetryEvent,
} from "./learning-telemetry";

const events: LearningTelemetryEvent[] = [];
let clock = 0;
const input = {
	runId: "run-1",
	traceId: "trace-1",
	sessionKey: "embed:session-1",
	origin: "chat",
	userChars: 6,
	assistantChars: 100,
	userText: "Never emit user content",
};
const tracker = createLearningTelemetry(input, {
	now: () => clock,
	emit: (event) => events.push(event),
});
tracker.observer.status = "completed";
tracker.observer.observations = 0;
tracker.observer.durationMs = 5932;
tracker.reflector.status = "below_threshold";
tracker.reflector.inputTokens = 1;
clock = 6000;
tracker.finish("completed");
tracker.finish("failed");
assert.equal(events.length, 1, "finally cannot overwrite an emitted outcome");
assert.equal(events[0]?.elapsedMs, 6000);
assert.equal(events[0]?.observer.observations, 0);
assert.equal(
	events[0]?.reflector.durationMs,
	null,
	"a skipped reflector has no timing",
);
assert.equal(
	events[0]?.bridge,
	null,
	"missing bridge telemetry is not zero writes",
);
assert.ok(!JSON.stringify(events).includes(input.userText));
tracker.observer.observations = 10;
assert.equal(
	events[0]?.observer.observations,
	0,
	"emission snapshots mutable stages",
);

const skipped = createLearningTelemetry(input, {
	emit: (event) => events.push(event),
});
skipped.finish("skipped", "learning_disabled");
assert.equal(events[1]?.skipReason, "learning_disabled");
assert.equal(events[1]?.observer.status, "not_started");
assert.equal(events[1]?.observer.observations, null);

assert.equal(learningUserTextLength("Thanks", false), 6);
assert.equal(
	learningUserTextLength(
		`${embeddedUserText("Thanks")}\n${"host context".repeat(1000)}`,
		true,
	),
	6,
	"injected context must not make a short follow-up appear long",
);
assert.equal(learningUserTextLength(embeddedUserText(""), true), 0);
assert.equal(learningUserTextLength("legacy host envelope", true), null);
assert.equal(
	learningUserTextLength("Tedix embedded user message v1: bad JSON", true),
	null,
);
console.log(
	"PASS: learning telemetry attribution, stage outcomes, and authored lengths",
);
