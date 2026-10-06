import { kernelRuntimeRuns } from "@tedix/db/schema";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import {
	type WorkstationDispatchDeps,
	composeWorkstationWorkOrderMessage,
	dispatchWorkstationWorkOrder,
	mintWorkstationChildRunId,
	workstationDispatchIdentity,
} from "./workstation-dispatch";

type RunUpdate = { set: Record<string, unknown>; table: unknown };

function createFakeDb() {
	const updates: RunUpdate[] = [];
	const db = {
		update(table: unknown) {
			const entry: RunUpdate = { set: {}, table };
			return {
				set(values: Record<string, unknown>) {
					entry.set = values;
					return this;
				},
				where() {
					updates.push(entry);
					return Promise.resolve([]);
				},
			};
		},
	};
	return { db: db as unknown as BaseContext["db"], updates };
}

function createDeps(overrides?: Partial<WorkstationDispatchDeps>) {
	const fake = createFakeDb();
	const enqueue = vi.fn(
		async (input: { childRunId: string }) =>
			({
				childRunId: input.childRunId,
				childConversationId: "agent:main:main",
				status: "queued",
			}) as const,
	);
	const recordDispatchFailure = vi.fn(async () => {});
	const deps: WorkstationDispatchDeps = {
		db: fake.db,
		enqueue,
		recordDispatchFailure,
		now: () => "2026-06-12T10:00:00.000Z",
		...overrides,
	};
	return { deps, enqueue, recordDispatchFailure, updates: fake.updates };
}

const RICH_WORK_ORDER = {
	id: "work-order:home-run-1",
	kind: "workstation.attach",
	status: "approved_waiting_certified_dispatch",
	objective: "Rotate the staging API keys before Friday.",
	outputContract: "Return: the rotated key ids and a rollback note.",
	toolGuidance: ['Use your "infra" scope group for this work.'],
	boundaries: [
		"Do not exceed your assigned scopes; if the task needs access you lack, stop and report it.",
	],
	sourceContent: "please rotate the staging API keys",
	targetTediId: "tedi-cto",
};

describe("mintWorkstationChildRunId", () => {
	it("mints the deterministic {homeRunId}:workstation:{tediId} id", () => {
		expect(
			mintWorkstationChildRunId({
				homeRunId: "home-run-1",
				tediId: "tedi-cto",
			}),
		).toBe("home-run-1:workstation:tedi-cto");
	});

	it("sanitizes segments the same way isolate turn keys are sanitized", () => {
		expect(
			mintWorkstationChildRunId({
				homeRunId: "<home:run 1>",
				tediId: "tedi-cto",
			}),
		).toBe("home_run_1:workstation:tedi-cto");
	});

	it("throws when the home run id sanitizes to nothing", () => {
		expect(() =>
			mintWorkstationChildRunId({ homeRunId: "<>", tediId: "tedi-cto" }),
		).toThrow(/stable home run id/);
	});
});

describe("composeWorkstationWorkOrderMessage", () => {
	it("renders the rich delegation fields as a bracketed work-order block", () => {
		const message = composeWorkstationWorkOrderMessage({
			content: "please rotate the staging API keys",
			homeRunId: "home-run-1",
			workOrder: RICH_WORK_ORDER,
		});
		expect(message).toContain(
			"[HOME WORKSTATION WORK ORDER work-order:home-run-1]",
		);
		expect(message).toContain(
			"Objective: Rotate the staging API keys before Friday.",
		);
		expect(message).toContain(
			"Output contract: Return: the rotated key ids and a rollback note.",
		);
		expect(message).toContain('- Use your "infra" scope group for this work.');
		expect(message).toContain("- Do not exceed your assigned scopes");
		expect(message).toContain("please rotate the staging API keys");
		expect(message).toContain("[END HOME WORKSTATION WORK ORDER]");
		// Ends with the completion instruction.
		expect(message.trimEnd().endsWith("satisfies the output contract.")).toBe(
			true,
		);
	});

	it("falls back to the verbatim request for the lean workstation work order shape", () => {
		const message = composeWorkstationWorkOrderMessage({
			content: "check the deploy logs",
			homeRunId: "home-run-2",
			workOrder: {
				id: "work-order:home-run-2",
				kind: "workstation.attach",
				requestPreview: "check the deploy logs",
			},
		});
		expect(message).toContain(
			"[HOME WORKSTATION WORK ORDER work-order:home-run-2]",
		);
		expect(message).toContain(
			'Objective: Deliver on this request from the Home operator: "check the deploy logs"',
		);
		expect(message).toContain("Output contract: Return a concise result");
		expect(message).toContain("Source request:\ncheck the deploy logs");
		expect(message).not.toContain("Tool guidance:");
	});
});

describe("dispatchWorkstationWorkOrder", () => {
	const input = {
		content: "please rotate the staging API keys",
		conversationId: "home:test",
		existingMetadata: {
			idempotencyKey: "home-run-1",
			workItemId: "work-item-1",
		},
		existingRuntimeMetadata: { source: "kernelRuntime.enqueueMessage" },
		organizationId: "org-1",
		runId: "home-run-1",
		targetTediId: "tedi-cto",
		trigger: "policy-auto-approval" as const,
		userMessageId: "home-run-1:input",
		workOrder: RICH_WORK_ORDER,
	};

	it("enqueues the composed work order under the minted childRunId and stamps the run row", async () => {
		const { deps, enqueue, recordDispatchFailure, updates } = createDeps();

		const result = await dispatchWorkstationWorkOrder(deps, input);

		expect(result).toEqual({
			childConversationId: "agent:main:main",
			childRunId: "home-run-1:workstation:tedi-cto",
			status: "dispatched",
		});
		expect(enqueue).toHaveBeenCalledTimes(1);
		const enqueueArgs = enqueue.mock.calls[0]?.[0] as {
			childRunId: string;
			content: string;
			delegateToTediId: string;
			metadata: Record<string, unknown>;
		};
		expect(enqueueArgs.childRunId).toBe("home-run-1:workstation:tedi-cto");
		expect(enqueueArgs.delegateToTediId).toBe("tedi-cto");
		expect(enqueueArgs.content).toContain("[HOME WORKSTATION WORK ORDER");
		expect(enqueueArgs.metadata).toMatchObject({
			source: "kernelRuntime.workstationDispatch",
			dispatchMode: "async",
			homeRunId: "home-run-1",
			homeConversationId: "home:test",
			homeMessageId: "home-run-1:input",
			dispatchTrigger: "policy-auto-approval",
			delegationWorkOrder: { id: "work-order:home-run-1" },
			workItemId: "work-item-1",
		});

		expect(recordDispatchFailure).not.toHaveBeenCalled();
		expect(updates).toHaveLength(1);
		expect(updates[0]?.table).toBe(kernelRuntimeRuns);
		expect(updates[0]?.set).toMatchObject({
			status: "queued",
			delegatedTediId: "tedi-cto",
			childRunId: "home-run-1:workstation:tedi-cto",
			childConversationId: "agent:main:main",
			startedAt: "2026-06-12T10:00:00.000Z",
			updatedAt: "2026-06-12T10:00:00.000Z",
			runtimeMetadata: {
				source: "kernelRuntime.enqueueMessage",
				childRunId: "home-run-1:workstation:tedi-cto",
				dispatch: "workstation-dispatched",
				workItemId: "work-item-1",
			},
			metadata: {
				idempotencyKey: "home-run-1",
				workItemId: "work-item-1",
				childRunId: "home-run-1:workstation:tedi-cto",
				delegatedTediId: "tedi-cto",
				delegationStatus: "queued",
				delegationWorkOrder: { status: "dispatched" },
				workstationDispatch: { trigger: "policy-auto-approval" },
			},
		});
	});

	it("supervises the acknowledged runtime run while retaining the deterministic delivery key", async () => {
		const acknowledgedChildRunId =
			"tedi-cto:mcp:home-run-1_workstation_tedi-cto";
		const enqueue = vi.fn(async () => ({
			childRunId: acknowledgedChildRunId,
			status: "queued" as const,
		}));
		const { deps, updates } = createDeps({ enqueue });

		const result = await dispatchWorkstationWorkOrder(deps, input);

		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				childRunId: "home-run-1:workstation:tedi-cto",
			}),
		);
		expect(result.childRunId).toBe(acknowledgedChildRunId);
		expect(updates[0]?.set).toMatchObject({
			childRunId: acknowledgedChildRunId,
			metadata: { childRunId: acknowledgedChildRunId },
			runtimeMetadata: { childRunId: acknowledgedChildRunId },
		});
	});

	it("records a dispatch failure when the enqueue is rejected by the runtime", async () => {
		const { deps, recordDispatchFailure, updates } = createDeps({
			enqueue: vi.fn(async (args: { childRunId: string }) => ({
				childRunId: args.childRunId,
				error: "tedi gateway rejected the enqueue",
				status: "failed" as const,
			})),
		});

		const result = await dispatchWorkstationWorkOrder(deps, input);

		expect(result).toEqual({
			childRunId: "home-run-1:workstation:tedi-cto",
			error: "tedi gateway rejected the enqueue",
			status: "failed",
		});
		expect(updates).toHaveLength(0);
		expect(recordDispatchFailure).toHaveBeenCalledTimes(1);
		expect(recordDispatchFailure.mock.calls[0]?.[0]).toMatchObject({
			childRunId: "home-run-1:workstation:tedi-cto",
			conversationId: "home:test",
			delegatedTediId: "tedi-cto",
			error: "tedi gateway rejected the enqueue",
			organizationId: "org-1",
			runId: "home-run-1",
		});
	});

	it("records a dispatch failure when the enqueue throws", async () => {
		const { deps, recordDispatchFailure, updates } = createDeps({
			enqueue: vi.fn(async () => {
				throw new Error("network exploded");
			}),
		});

		const result = await dispatchWorkstationWorkOrder(deps, input);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("network exploded");
		expect(updates).toHaveLength(0);
		expect(recordDispatchFailure).toHaveBeenCalledWith(
			expect.objectContaining({ error: "network exploded" }),
		);
	});
});

describe("workstationDispatchIdentity", () => {
	it.each([
		{ id: "tedi-db", isolateAgentId: "runtime-do", slug: "cto" },
		{ id: "tedi-db", isolateAgentId: null, slug: "cto" },
		{ id: "tedi-db", isolateAgentId: null, slug: null },
	] as const)(
		"keeps primary-key run identity independent of the DO routing key: %j",
		(target) => {
			expect(
				workstationDispatchIdentity({ homeRunId: "home-1", target }),
			).toEqual({
				deliveryKey: "home-1:workstation:tedi-db",
				runtimeRunId: "tedi-db:mcp:home-1_workstation_tedi-db",
			});
		},
	);

	it("matches the acknowledged UUID run after a DO rebind", () => {
		const target = {
			id: "11111111-1111-4111-8111-111111111111",
			isolateAgentId: "cto-rebind-1782139014003",
			slug: "cto",
		};
		expect(
			workstationDispatchIdentity({ homeRunId: "home-1", target }),
		).toEqual({
			deliveryKey: "home-1:workstation:11111111-1111-4111-8111-111111111111",
			runtimeRunId:
				"11111111-1111-4111-8111-111111111111:mcp:home-1_workstation_11111111-1111-4111-8111-111111111111",
		});
	});
});
