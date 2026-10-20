import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { organizations } from "@tedix/db/schema/organizations";
import { tedis } from "@tedix/db/schema/tedis";
import {
	kernelRuntimeRuns,
	kernelRuntimeEvents,
} from "@tedix/db/schema/cognitive-runtime";
import { kernelFallbackHooks } from "./model-fallback";
import { PLATFORM_MODEL_FALLBACK } from "@tedix/api-contract/schemas/model-fallback";

const step = {
	from: "cloudflare/auto",
	to: "azure-openai/gpt-6-luna",
	reason: "credits_exhausted" as const,
	ordinal: 1,
	policyVersion: 1 as const,
};
describe("kernel fallback ledger boundary", () => {
	it("reads org policy and records the exact run before returning; refuses missing, cross-org and canceled runs", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec(
				schemaDdl(organizations, tedis, kernelRuntimeRuns, kernelRuntimeEvents),
			);
			const binding = createD1Facade(sqlite);
			const db = createDbClient(binding);
			for (const id of ["fictional-a", "fictional-b"])
				await db.insert(organizations).values({
					id,
					name: id,
					slug: id,
					descopeTenantId: id,
					metadata:
						id === "fictional-b"
							? {
									modelFallback: {
										version: 1,
										maxTransitions: 0,
										ladder: {},
									},
								}
							: {},
				});
			await db.insert(kernelRuntimeRuns).values({
				id: "fictional-run",
				organizationId: "fictional-a",
				conversationId: "fictional-conversation",
				status: "running",
			});
			const hooks = kernelFallbackHooks(binding, {
				organizationId: "fictional-a",
				runId: "fictional-run",
			});
			expect(await hooks.load()).toEqual(PLATFORM_MODEL_FALLBACK);
			await hooks.record(step);
			const events = await db.select().from(kernelRuntimeEvents);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				organizationId: "fictional-a",
				runId: "fictional-run",
				conversationId: "fictional-conversation",
				kind: "step.retry",
				payload: { operation: "model_fallback", ...step },
			});
			const other = kernelFallbackHooks(binding, {
				organizationId: "fictional-b",
				runId: "fictional-run",
			});
			expect((await other.load()).maxTransitions).toBe(0);
			await expect(other.record(step)).rejects.toThrow("unavailable");
			await expect(
				kernelFallbackHooks(binding, {
					organizationId: "fictional-a",
					runId: "missing",
				}).record(step),
			).rejects.toThrow("unavailable");
			await db.update(kernelRuntimeRuns).set({ status: "canceled" });
			await expect(hooks.record(step)).rejects.toThrow("unavailable");
			expect(await db.select().from(kernelRuntimeEvents)).toHaveLength(1);
		} finally {
			sqlite.close();
		}
	});
});
