import { describe, expect, mock, test } from "bun:test";
import type { HomeRunSummary } from "./home-client";
import { commitInkSendResult } from "./interactive-ink";

const context = { json: false, color: { enabled: false }, poll: true };

function complete(overrides: Partial<HomeRunSummary> = {}) {
	const bridge = {
		markMessageSeen: mock((_id: string) => {}),
		markRunSeen: mock((_id: string) => {}),
		commitLines: mock((_speaker: string, _lines: string[]) => {}),
	};
	const onTediLabel = mock((_id: string, _label: string) => {});
	commitInkSendResult(
		{
			homeRunId: "run-1",
			status: "completed",
			assistantText: "Done",
			...overrides,
		},
		context,
		bridge,
		onTediLabel,
	);
	return { bridge, onTediLabel };
}

describe("shared Ink answer completion", () => {
	test("a direct answer commits once and suppresses its transcript replay", () => {
		const { bridge } = complete();
		expect(bridge.commitLines).toHaveBeenCalledTimes(1);
		expect(bridge.commitLines.mock.calls[0]![0]).toBe("kernel");
		expect(bridge.commitLines.mock.calls[0]![1].join("\n")).toContain("Done");
		expect(bridge.markMessageSeen).toHaveBeenCalledWith("run-1:assistant");
		expect(bridge.markRunSeen).toHaveBeenCalledWith("run-1");
	});

	test("a promoted child answer keeps worker attribution and suppresses replay", () => {
		const { bridge, onTediLabel } = complete({
			delegatedTediId: "tedi-1",
			targetTediLabel: " CTO ",
			childRunPreview: "Done",
		});
		expect(bridge.commitLines.mock.calls[0]![0]).toBe("CTO");
		expect(onTediLabel).toHaveBeenCalledWith("run-1", "CTO");
		expect(bridge.markRunSeen).toHaveBeenCalledWith("run-1");
	});

	test("a delegation acknowledgement leaves the later worker answer visible", () => {
		const { bridge, onTediLabel } = complete({
			delegatedTediId: "tedi-1",
			targetTediLabel: "CTO",
			assistantText: "Delegating now",
			childRunPreview: "Work is underway",
		});
		expect(bridge.commitLines.mock.calls[0]![0]).toBe("kernel");
		expect(onTediLabel).toHaveBeenCalledWith("run-1", "CTO");
		expect(bridge.markMessageSeen).toHaveBeenCalledWith("run-1:assistant");
		expect(bridge.markRunSeen).not.toHaveBeenCalled();
	});

	test("a declined write retains its diagnostic alongside the answer", () => {
		const { bridge } = complete({
			writeDeclined: { stage: "approval", detail: "Declined by user" },
		});
		const lines = bridge.commitLines.mock.calls[0]![1].join("\n");
		expect(lines).toContain("Done");
		expect(lines).toContain("Write not performed");
		expect(lines).toContain("Declined by user");
	});

	test("a failed delegation commits a terminal result without claiming worker authorship", () => {
		const { bridge, onTediLabel } = complete({
			status: "failed",
			delegatedTediId: "tedi-1",
			targetTediLabel: "CTO",
		});
		expect(bridge.commitLines.mock.calls[0]![0]).toBe("kernel");
		expect(bridge.markRunSeen).toHaveBeenCalledWith("run-1");
		expect(onTediLabel).not.toHaveBeenCalled();
	});

	test("formatting never changes the process console", () => {
		const log = console.log;
		const error = console.error;
		const bridge = {
			markMessageSeen: mock(() => {}),
			markRunSeen: mock(() => {}),
			commitLines: mock(() => {}),
		};
		commitInkSendResult(
			{
				homeRunId: "run-1",
				status: "completed",
				get assistantText() {
					expect(console.log).toBe(log);
					expect(console.error).toBe(error);
					return "Done";
				},
			},
			context,
			bridge,
		);
		expect(bridge.commitLines).toHaveBeenCalledTimes(1);
	});
});
