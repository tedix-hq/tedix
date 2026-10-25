import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { organizations } from "@tedix/db/schema/organizations";
import { tedis } from "@tedix/db/schema/tedis";
import { kernelRuntimeRuns } from "@tedix/db/schema/cognitive-runtime";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import type { KernelTurnWorkInput } from "../rpc/routers/kernel/turn-work-context";

vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }));
vi.mock("agents", () => ({ isDurableObjectMemoryLimitReset: () => false }));

const input: KernelTurnWorkInput = {
	organizationId: "fictional-org",
	conversationId: "fictional-conversation",
	runId: "fictional-run",
	content: "Saved question",
	userMessageId: "user",
	assistantMessageId: "assistant",
	createdAt: "2026-10-20T00:00:00.000Z",
	assistantAt: "2026-10-20T00:00:00.001Z",
	completedAt: "2026-10-20T00:00:00.002Z",
	approvalRequestId: null,
	delegationWorkOrder: null,
	homePlan: null,
	runtimeMetadata: {},
	runRowMetadata: {},
};

async function fixture(
	status = "queued",
	metadata: Record<string, unknown> = {},
) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, tedis, kernelRuntimeRuns));
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(organizations).values({
		id: input.organizationId,
		name: "Fictional",
		slug: "fictional",
		descopeTenantId: "fictional",
	});
	await db.insert(kernelRuntimeRuns).values({
		id: input.runId,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		status,
		metadata: {
			routeRetryAt: "2026-10-20T00:00:20.000Z",
			redriveInput: input,
			...metadata,
		},
	});
	const { KernelDOv4 } = await import("./kernel-do");
	const fake = {
		turnContext: async () => ({ db }),
		schedule: vi.fn(async () => ({ id: "schedule" })),
		runPlannerStep: vi.fn(async () => ({})),
	};
	return { sqlite, db, fake, methods: KernelDOv4.prototype };
}

describe("durable route redrive", () => {
	it("uses a 20-second alarm and claims the saved run once across duplicate callbacks", async () => {
		const { sqlite, db, fake, methods } = await fixture();
		try {
			await methods.scheduleRouteRedrive.call(fake as never, input);
			expect(fake.schedule).toHaveBeenCalledWith(20, "redriveRoute", input);
			await Promise.all([
				methods.redriveRoute.call(fake as never, input),
				methods.redriveRoute.call(fake as never, input),
			]);
			expect(fake.runPlannerStep).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					content: input.content,
					runId: input.runId,
					assistantMessageId: "assistant:route-redrive",
					runRowMetadata: expect.objectContaining({
						routeRetryCount: 1,
						redriveCount: 1,
						routeRetryAt: null,
					}),
				}),
			);
			expect(
				(
					await getKernelRuntimeRun(db, {
						id: input.runId,
						organizationId: input.organizationId,
					})
				)?.status,
			).toBe("running");
		} finally {
			sqlite.close();
		}
	});
	it.each(["canceled", "completed", "failed"])(
		"does not replay a %s run",
		async (status) => {
			const { sqlite, fake, methods } = await fixture(status);
			try {
				await methods.redriveRoute.call(fake as never, input);
				expect(fake.runPlannerStep).not.toHaveBeenCalled();
			} finally {
				sqlite.close();
			}
		},
	);
	it.each([
		{ routeRetryCount: 1 },
		{ abortRequestedAt: "2026-10-20T00:00:01.000Z" },
	])("honors durable retry and abort fences: %o", async (metadata) => {
		const { sqlite, fake, methods } = await fixture("queued", metadata);
		try {
			await methods.redriveRoute.call(fake as never, input);
			expect(fake.runPlannerStep).not.toHaveBeenCalled();
		} finally {
			sqlite.close();
		}
	});
});
