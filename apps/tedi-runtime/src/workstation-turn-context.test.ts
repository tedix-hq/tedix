import { traceBundleId } from "@tedix/context-core/harness-version";
import assert from "node:assert/strict";
import {
	captureWorkstationTurnContext,
	resolveWorkstationTurnIdentity,
	withWorkstationTurnContext,
	workstationProcessConversationProvenance,
} from "./workstation-turn-context";

assert.deepEqual(
	resolveWorkstationTurnIdentity(
		{
			conversationId: "cto:cron",
			runId: "cto:cron:run",
			workItemId: "cron-work",
		},
		{
			conversationId: "cto:delegation",
			homeRunId: "home-run",
			runId: "cto:child-run",
			traceId: "cto:child-run",
			workItemId: "child-work",
		},
	),
	{
		conversationId: "cto:delegation",
		homeRunId: "home-run",
		runId: "cto:child-run",
		traceId: "cto:child-run",
		workItemId: "child-work",
	},
);

const ambient = {
	conversationId: "cto:stale-turn",
	homeRunId: "stale-home-run",
	runId: "stale-kernel-run",
	traceId: "stale-trace",
	workItemId: "stale-work-item",
};

assert.deepEqual(
	withWorkstationTurnContext({ workItemId: "direct-work-item" }, ambient),
	{ workItemId: "direct-work-item" },
	"an explicit Work Item never inherits stale ambient Kernel correlation",
);
console.log(
	"PASS: explicit Work Item preserved; stale ambient Kernel correlation excluded",
);

assert.deepEqual(
	withWorkstationTurnContext({ kernelRunId: "direct-kernel-run" }, ambient),
	{ kernelRunId: "direct-kernel-run" },
	"an explicit Kernel run never inherits an unrelated ambient Work Item",
);
console.log(
	"PASS: explicit Kernel run preserved; stale ambient Work Item excluded",
);

assert.deepEqual(withWorkstationTurnContext({ leaseId: "lease-1" }, ambient), {
	leaseId: "lease-1",
	kernelRunId: "stale-kernel-run",
	traceId: "stale-trace",
	workItemId: "stale-work-item",
	traceBundleId: "stale-home-run:bundle",
});
assert.deepEqual(
	workstationProcessConversationProvenance(
		{ kernelRunId: ambient.runId },
		ambient,
	),
	{ conversationId: ambient.conversationId, runId: ambient.runId },
);
assert.equal(
	workstationProcessConversationProvenance(
		{ kernelRunId: "another-run" },
		ambient,
	),
	null,
	"a different explicit run cannot inherit the active conversation",
);
console.log("PASS: scope-free delegated call inherits its active turn binding");

assert.deepEqual(
	resolveWorkstationTurnIdentity(
		{
			conversationId: "cto:delegation",
			homeRunId: "home-run",
			runId: "cto:child-run",
			workItemId: "child-work",
		},
		{
			conversationId: "cto:delegation",
			runId: "cto:child-run",
		},
	),
	{
		conversationId: "cto:delegation",
		homeRunId: "home-run",
		runId: "cto:child-run",
		workItemId: "child-work",
	},
);

console.log(
	"PASS: workstation turn context remains bound to the calling child",
);

// Dispatch correlation remains available without an MCP/platform binding.
const independentDispatch = {
	conversationId: "home",
	runId: "child",
	workItemId: "5eed0016-0000-4000-8000-000000000016",
};
assert.deepEqual(
	withWorkstationTurnContext(
		{ command: "git status" },
		resolveWorkstationTurnIdentity(null, independentDispatch),
	),
	{
		command: "git status",
		kernelRunId: "child",
		workItemId: independentDispatch.workItemId,
		traceId: "child",
		traceBundleId: traceBundleId("child"),
	},
);

// Captured session identity survives mutation of the source turn object.
{
	const dispatch = {
		conversationId: "home:child",
		runId: "child-run",
		sessionKey: "owning-session",
		workItemId: "owned-work",
		homeRunId: "home-run",
	};
	const captured = captureWorkstationTurnContext(dispatch);
	dispatch.sessionKey = "another-session";
	assert.deepEqual(captured, {
		conversationId: "home:child",
		runId: "child-run",
		sessionKey: "owning-session",
		workItemId: "owned-work",
		homeRunId: "home-run",
		traceId: "child-run",
	});
	assert.equal(
		resolveWorkstationTurnIdentity(null, captured)?.sessionKey,
		"owning-session",
	);
}
