import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import { describe, expect, it } from "vite-plus/test";
import type { ConversationStreamFrame } from "./conversation-stream";
import {
	approvalRequestIdOf,
	createProjectionEnvelope,
} from "./projection-envelope";

const CONVERSATION_ID = "home:main";
const RUN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/**
 * A frame as the Cap'n lane produces it: run-local offsets and the
 * `{conversationId}:{runId}:{offset}` dedupe id from `capnFrameId`. Kernel rows
 * carry NO top-level toolCallId — `kernelStreamRow()` in
 * `run-reads-streams.ts` hard-nulls it; only delegated child rows
 * (`childStreamRow`, `tedi_runtime_events`) populate the column.
 */
function capnFrame(
	event: Partial<RuntimeStreamEvent> & { kind: string },
	runId = RUN_A,
	offset = 0,
): ConversationStreamFrame {
	return {
		offset,
		eventId: `${CONVERSATION_ID}:${runId}:${offset}`,
		event: {
			id: `evt-${offset}`,
			conversationId: CONVERSATION_ID,
			runId,
			createdAt: "2026-08-16T10:00:00.000Z",
			...event,
		},
	};
}

describe("approvalRequestIdOf", () => {
	it("reads the payload, which is where the wire actually puts it", () => {
		const event = capnFrame({
			kind: "approval.requested",
			payload: { approvalRequestId: "apr-1" },
		}).event;
		expect(approvalRequestIdOf(event)).toBe("apr-1");
	});

	it("is null on a frame that carries no approval id anywhere", () => {
		expect(
			approvalRequestIdOf(capnFrame({ kind: "approval.requested" }).event),
		).toBeNull();
	});
});

describe("createProjectionEnvelope", () => {
	it("stamps delivery generation, event kind and creation time", () => {
		const envelope = createProjectionEnvelope({
			generation: 3,
			replay: false,
			frame: capnFrame({ kind: "run.started" }, RUN_A, 7),
		});
		expect(envelope).toMatchObject({
			generation: 3,
			replay: false,
			kind: "run.started",
			createdAt: "2026-08-16T10:00:00.000Z",
		});
	});

	it("marks a buffer replay as replay", () => {
		const envelope = createProjectionEnvelope({
			generation: 1,
			replay: true,
			frame: capnFrame({ kind: "run.started" }, RUN_B, 0),
		});
		expect(envelope.replay).toBe(true);
	});
});
