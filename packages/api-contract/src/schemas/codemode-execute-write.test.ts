import { describe, expect, it } from "vite-plus/test";
import {
	CODEMODE_EXECUTE_WRITE_KIND,
	parseCodemodeExecuteWritePayload,
} from "./codemode-execute-write";

const basePayload = {
	kind: CODEMODE_EXECUTE_WRITE_KIND,
	organizationId: "org-1",
	tediId: "tedi-1",
	conversationId: "conversation-1",
	sessionKey: "session-1",
	executionId: "execution-1",
	codeHash: "hash-1",
	riskTier: "high" as const,
};

describe("parseCodemodeExecuteWritePayload", () => {
	it("preserves the legacy session replay payload", () => {
		expect(parseCodemodeExecuteWritePayload(basePayload)).toEqual(basePayload);
	});

	it("requires complete parent and pending-call correlation for durable calls", () => {
		const durablePayload = {
			...basePayload,
			executionMode: "durable_call" as const,
			homeRunId: "home-run-1",
			childRunId: "child-run-1",
			pendingSeq: 0,
			connector: "workspace",
			method: "write_file",
		};

		expect(parseCodemodeExecuteWritePayload(durablePayload)).toEqual(
			durablePayload,
		);
		expect(
			parseCodemodeExecuteWritePayload({
				...durablePayload,
				childRunId: undefined,
			}),
		).toBeNull();
	});
});
