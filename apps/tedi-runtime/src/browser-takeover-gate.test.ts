import { strict as assert } from "node:assert";
import {
	decideBrowserTakeoverGate,
	type BrowserTakeoverGate,
} from "./browser-takeover-gate";

const gate: BrowserTakeoverGate = {
	approvalRequestId: "approval-1",
	expiresAt: "2026-08-12T13:00:00.000Z",
	sessionId: "session-1",
};
const row = (status: string) => ({
	status,
	tediId: "tedi-1",
	payload: JSON.stringify({
		kind: "browser_live_view_takeover",
		sessionId: "session-1",
	}),
});
const now = Date.parse("2026-08-12T12:00:00.000Z");

assert.deepEqual(
	decideBrowserTakeoverGate({
		gate,
		row: row("pending"),
		tediId: "tedi-1",
		now,
	}),
	{ action: "wait", reason: "pending" },
);
assert.deepEqual(
	decideBrowserTakeoverGate({
		gate,
		row: row("approved"),
		tediId: "tedi-1",
		now,
	}),
	{ action: "allow", reason: "approved" },
);
assert.equal(
	decideBrowserTakeoverGate({
		gate,
		row: row("rejected"),
		tediId: "tedi-1",
		now,
	}).action,
	"close",
);
assert.equal(
	decideBrowserTakeoverGate({
		gate,
		row: { ...row("approved"), tediId: "another-tedi" },
		tediId: "tedi-1",
		now,
	}).reason,
	"invalid_approval",
);
assert.equal(
	decideBrowserTakeoverGate({
		gate: { ...gate, expiresAt: "2026-08-12T11:59:59.000Z" },
		row: row("approved"),
		tediId: "tedi-1",
		now,
	}).reason,
	"expired",
);
assert.equal(
	decideBrowserTakeoverGate({
		gate,
		row: { ...row("approved"), payload: "not-json" },
		tediId: "tedi-1",
		now,
	}).reason,
	"invalid_approval",
);

console.log("browser-takeover-gate tests passed");
