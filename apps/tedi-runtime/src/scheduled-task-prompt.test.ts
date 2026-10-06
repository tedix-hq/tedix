/**
 * The scheduled-turn envelope must always carry the autonomous notice and
 * render identity, drift and recurrence legibly.
 */
import assert from "node:assert/strict";
import {
	AUTONOMOUS_NOTICE,
	formatScheduledTaskPrompt,
} from "./scheduled-task-prompt";

const SCHEDULED_FOR = Date.UTC(2026, 7, 2, 9, 0, 0);
const FIRED_AT = Date.UTC(2026, 7, 2, 9, 4, 30);

// (1) A recurring cron fire carries identity, drift, recurrence, and the notice.
const cronEnvelope = formatScheduledTaskPrompt({
	name: "objective-review",
	prompt: "Review open objectives and consolidate memory.",
	scheduledForMs: SCHEDULED_FOR,
	currentTimeMs: FIRED_AT,
	recurrence: { type: "cron", expr: "0 9 * * *" },
});
assert.ok(
	cronEnvelope.includes('Scheduled task "objective-review" is firing.'),
	"envelope names the job",
);
assert.ok(
	cronEnvelope.includes("Scheduled for: 2026-08-02T09:00:00.000Z"),
	"intended occurrence is visible",
);
assert.ok(
	cronEnvelope.includes("Current time: 2026-08-02T09:04:30.000Z"),
	"actual fire time is visible so drift is legible",
);
assert.ok(
	cronEnvelope.includes("(cron: 0 9 * * *)"),
	"recurrence carries the expression",
);
assert.ok(
	cronEnvelope.includes(AUTONOMOUS_NOTICE),
	"the autonomous notice is always present",
);
assert.ok(
	cronEnvelope.includes("no user is watching this turn"),
	"the notice states nobody is reading",
);
assert.ok(
	cronEnvelope.includes("the deliverable is the tool work"),
	"the notice names the deliverable (tool work, not prose)",
);

// (2) Interval schedules render.
const everyEnvelope = formatScheduledTaskPrompt({
	name: "poller",
	prompt: "Poll the queue.",
	scheduledForMs: null,
	currentTimeMs: FIRED_AT,
	recurrence: { type: "every", everyMs: 900_000 },
});
assert.ok(everyEnvelope.includes("(every 900000ms)"));
assert.ok(
	!everyEnvelope.includes("Scheduled for:"),
	"an absent occurrence is omitted rather than rendered as epoch",
);

// (3) An unnamed job still produces a valid envelope.
const unnamed = formatScheduledTaskPrompt({
	name: null,
	prompt: "do the thing",
	scheduledForMs: SCHEDULED_FOR,
	currentTimeMs: FIRED_AT,
	recurrence: { type: "one-off" },
});
assert.ok(
	unnamed.includes('Scheduled task "unnamed" is firing.'),
	"an unnamed job renders the unnamed placeholder",
);

console.log("scheduled-task-prompt.test.ts: all assertions passed");
