import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import { readChildRunEvidenceRows } from "./child-run-reads";
import { requireDelegatedChildTerminalReceipt } from "./delegation-recovery";

vi.mock("./child-run-reads", () => ({ readChildRunEvidenceRows: vi.fn() }));

const context = {} as BaseContext;
const input = {
	organizationId: "org-1",
	delegatedTediId: "tedi-1",
	childRunId: "child-1",
};

describe("delegation recovery", () => {
	it.each([
		{ eventRows: [] },
		{ eventRows: [{ kind: "run.started" }] },
		{ eventRows: [{ kind: "approval.requested" }] },
		{ eventRows: [{ kind: "message.completed" }] },
	])(
		"blocks a retry without a child terminal receipt: %j",
		async ({ eventRows }) => {
			vi.mocked(readChildRunEvidenceRows).mockResolvedValue({
				eventRows,
				eventReadAvailable: true,
			} as Awaited<ReturnType<typeof readChildRunEvidenceRows>>);
			await expect(
				requireDelegatedChildTerminalReceipt(context, input),
			).rejects.toMatchObject({ code: "CONFLICT" });
		},
	);
	it.each(["run.completed", "run.failed", "run.canceled"])(
		"accepts a canonical %s receipt",
		async (kind) => {
			vi.mocked(readChildRunEvidenceRows).mockResolvedValue({
				eventRows: [{ kind }],
				eventReadAvailable: true,
			} as Awaited<ReturnType<typeof readChildRunEvidenceRows>>);
			await expect(
				requireDelegatedChildTerminalReceipt(context, input),
			).resolves.toBeUndefined();
			expect(readChildRunEvidenceRows).toHaveBeenLastCalledWith(
				context,
				expect.objectContaining({
					organizationId: "org-1",
					tediId: "tedi-1",
					runId: "child-1",
					includeMappedWorkstationRun: true,
				}),
			);
		},
	);
	it("blocks unavailable telemetry even if partial rows include a terminal event", async () => {
		vi.mocked(readChildRunEvidenceRows).mockResolvedValue({
			eventRows: [{ kind: "run.failed" }],
			eventReadAvailable: false,
		} as Awaited<ReturnType<typeof readChildRunEvidenceRows>>);
		await expect(
			requireDelegatedChildTerminalReceipt(context, input),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("blocks an absent child identity", async () => {
		await expect(
			requireDelegatedChildTerminalReceipt(context, {
				...input,
				childRunId: null,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});
