import assert from "node:assert/strict";
import {
	FacetTurnAdmission,
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
console.log("facet-turn-admission OK");
