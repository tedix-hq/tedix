import assert from "node:assert/strict";
import {
	FacetTurnAdmission,
	PERSON_TURN_RETRY_SECONDS,
	turnRetryDelaySeconds,
} from "./facet-turn-admission";

assert.throws(() => new FacetTurnAdmission(0), /Invalid/);
const admission = new FacetTurnAdmission(1);
let release!: () => void;
let entered = 0;
const original = admission.run("same-run", async () => {
	entered++;
	await new Promise<void>((resolve) => {
		release = resolve;
	});
	throw new Error("failed original");
});
const failed = assert.rejects(original, /failed original/);
assert.equal(
	(
		await admission.run("same-run", async () => {
			entered++;
			return { stopReason: "unexpected" };
		})
	).stopReason,
	"turn_deferred",
);
assert.equal(
	(
		await admission.run("other-run", async () => {
			entered++;
			return { stopReason: "unexpected" };
		})
	).stopReason,
	"turn_deferred",
);
assert.equal(
	entered,
	1,
	"neither duplicate nor independent denial can enter the turn",
);
release();
await failed;
assert.equal(
	await admission.run("after-failure", async () => "ran later"),
	"ran later",
);
const delays = Array.from({ length: 100 }, (_, i) =>
	turnRetryDelaySeconds(`run-${i}`),
);
assert.ok(delays.every((delay) => delay >= 15 && delay <= 30));
assert.ok(
	new Set(delays).size > 8,
	"burst retries are spread across time slots",
);
assert.equal(turnRetryDelaySeconds("stable"), turnRetryDelaySeconds("stable"));
// A person's chat turn goes before a waiting scheduled turn when a slot frees.
{
	let nowMs = 0;
	const gate = new FacetTurnAdmission(1, () => nowMs);
	let finish!: () => void;
	const holder = gate.run(
		"scheduled-1",
		() => new Promise<void>((resolve) => (finish = resolve)),
	);
	const deferredPerson = await gate.run("person", async () => "ran", {
		person: true,
	});
	assert.deepEqual(
		[
			(deferredPerson as { stopReason: string }).stopReason,
			(deferredPerson as { retryAfterSeconds: number }).retryAfterSeconds,
		],
		["turn_deferred", PERSON_TURN_RETRY_SECONDS],
	);
	finish();
	await holder;
	assert.equal(
		(
			(await gate.run("scheduled-2", async () => "ran")) as {
				stopReason?: string;
			}
		).stopReason,
		"turn_deferred",
		"the freed slot is kept for the waiting person",
	);
	assert.equal(
		await gate.run("person", async () => "ran", { person: true }),
		"ran",
	);
	assert.equal(await gate.run("scheduled-2", async () => "ran"), "ran");
	// A person's turn that stopped asking does not hold the slot back for good.
	const again = gate.run(
		"scheduled-3",
		() => new Promise<void>((resolve) => (finish = resolve)),
	);
	await gate.run("gone", async () => "ran", { person: true });
	finish();
	await again;
	nowMs += 60_000;
	assert.equal(await gate.run("scheduled-4", async () => "ran"), "ran");
}
// Long background turns leave a slot free for a person's turn.
{
	const gate = new FacetTurnAdmission(2);
	let finish!: () => void;
	const holder = gate.run(
		"observer-1",
		() => new Promise<void>((resolve) => (finish = resolve)),
	);
	assert.equal(
		(
			(await gate.run("observer-2", async () => "ran")) as {
				stopReason?: string;
			}
		).stopReason,
		"turn_deferred",
		"a second background turn cannot take the last slot",
	);
	assert.equal(
		await gate.run("home-delegation", async () => "ran", { person: true }),
		"ran",
	);
	finish();
	await holder;
}
console.log("facet-turn-admission OK");
