import assert from "node:assert/strict";
import { TediRuntimeEventSchema } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { DelegationAuthorityEnvelope } from "@tedix/api-contract/schemas/kernel-runtime";
import {
	delegationAuthorityRuntimeEvent,
	emitDelegationAuthorityRuntimeEvent,
} from "./delegation-authority-telemetry";

const envelope: DelegationAuthorityEnvelope = {
	version: "earned-delegation.v1",
	grantId: "grant-invoice-read",
	grantRevision: 3,
	decisionId: "decision-invoice-read",
	activityId: "invoice-read",
	activityVersion: 2,
	taskFamily: "acme.invoices.list",
	riskLevel: "medium",
	environment: "production",
	allowedToolIds: ["repo_load", "acme_tedix.list_invoices"],
	expiresAt: null,
};

const event = delegationAuthorityRuntimeEvent({
	tediId: "tedi-1",
	runId: "run-1",
	stepNumber: 2,
	tool: "tedix_mcp_call_tool",
	mode: "shadow",
	envelope,
	verdict: {
		allowed: true,
		wouldHaveDenied: true,
		requestedSurface: "gmail.send_message",
		reason: "outside delegated activity",
	},
	createdAt: "2026-08-10T00:00:00.000Z",
});

assert.deepEqual(TediRuntimeEventSchema.parse(event), event);
assert.equal(event.kind, "delegation.authority.evaluated");
assert.deepEqual(
	event.payload,
	{
		source: "delegation-authority",
		mode: "shadow",
		enforced: false,
		allowed: true,
		wouldHaveDenied: true,
		requestedSurface: "gmail.send_message",
		requestedTool: "tedix_mcp_call_tool",
		activityId: "invoice-read",
		grantId: "grant-invoice-read",
		reason: "outside delegated activity",
	},
	"every verdict names the real grant and activity it was evaluated against",
);

let recorded: unknown;
await emitDelegationAuthorityRuntimeEvent({
	getRecorder: async () => ({
		recordRuntimeEvent: async (value) => {
			recorded = value;
		},
	}),
	tediId: "tedi-1",
	runId: "run-1",
	stepNumber: 2,
	tool: "tedix_mcp_call_tool",
	mode: "shadow",
	envelope,
	verdict: {
		allowed: true,
		wouldHaveDenied: true,
		requestedSurface: "gmail.send_message",
		reason: "outside delegated activity",
	},
	createdAt: "2026-08-10T00:00:00.000Z",
});
assert.deepEqual(recorded, event);

const originalWarn = console.warn;
let warning: unknown[] | undefined;
console.warn = (...args: unknown[]) => {
	warning = args;
};
try {
	await emitDelegationAuthorityRuntimeEvent({
		getRecorder: async () => {
			throw new Error("recorder unavailable");
		},
		tediId: "tedi-1",
		runId: "run-1",
		stepNumber: 3,
		tool: "repo_load",
		mode: "shadow",
		envelope,
		verdict: {
			allowed: true,
			wouldHaveDenied: false,
			requestedSurface: "repo_load",
		},
	});
} finally {
	console.warn = originalWarn;
}
assert.equal(warning?.[0], "[delegation-authority] verdict emit failed");
// The reason now rides a field rather than a raw Error: passing the Error
// itself loses its message in Workers Logs, which is the whole point of the
// change. Assert the reason, not the object's stringification.
assert.match(
	String((warning?.[1] as { error?: unknown } | undefined)?.error),
	/recorder unavailable/,
);

console.log("All delegation authority telemetry tests passed.");
