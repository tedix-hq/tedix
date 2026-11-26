import { describe, expect, it } from "vite-plus/test";
import { workItemsContract } from "./work-items";
import { zodToToolInputJsonSchema } from "../utils/tool-json-schema";
import {
	CreateWorkItemInputSchema,
	WorkItemReadinessSchema,
} from "../schemas/work-items";

describe("Work Item factory contract", () => {
	function inputSchema(name: keyof typeof workItemsContract) {
		return workItemsContract[name]["~orpc"].inputSchemas[0]!;
	}

	it("exposes full commit IDs on the settlement input", () => {
		const schema = inputSchema("settleAttempt");
		const input = {
			id: "11111111-1111-4111-8111-111111111111",
			attemptId: "22222222-2222-4222-8222-222222222222",
			outcome: "succeeded",
		};
		expect(
			schema.safeParse({
				...input,
				complete: { expectedWorkItemVersion: 2 },
				settlement: { mode: "commit", commitShas: ["a".repeat(40)] },
			}).success,
		).toBe(true);
		expect(
			schema.safeParse({
				...input,
				settlement: { mode: "commit", commitShas: ["abc"] },
			}).success,
		).toBe(false);
		expect(
			schema.safeParse({ ...input, commitShas: ["a".repeat(40)] }).success,
		).toBe(false);
	});

	it("accepts project objective classification without accepting a client objective", () => {
		const schema = inputSchema("updateSpecification");
		const input = {
			id: "11111111-1111-4111-8111-111111111111",
			workClass: "objective",
		};
		expect(schema.parse(input)).toEqual(input);
		expect(zodToToolInputJsonSchema(schema)).toMatchObject({
			properties: {
				workClass: {
					enum: ["objective", "maintenance", "incident", "hygiene"],
				},
			},
			additionalProperties: false,
		});
		expect(
			schema.safeParse({
				...input,
				objectiveId: "22222222-2222-4222-8222-222222222222",
			}).success,
		).toBe(false);
	});

	it("updates and clears planning dates without changing disposition", () => {
		const schema = inputSchema("updateSpecification");
		const id = "11111111-1111-4111-8111-111111111111";
		expect(schema.parse({ id, dueDate: "2026-10-20" })).toEqual({
			id,
			dueDate: "2026-10-20",
		});
		expect(schema.parse({ id, dueDate: null })).toEqual({ id, dueDate: null });
		expect(schema.safeParse({ id, dueDate: "next week" }).success).toBe(false);
	});
	it("carries atomic hygiene guards and rejects shortened human protection", () => {
		const schema = inputSchema("cancel");
		const id = "11111111-1111-4111-8111-111111111111";
		const hygiene = {
			expectedWorkItemVersion: 3,
			humanQuietHours: 48,
			noAttempts: true,
		};
		expect(schema.parse({ id, hygiene })).toEqual({ id, hygiene });
		expect(schema.parse({ id })).toEqual({ id });
		expect(
			schema.safeParse({ id, hygiene: { ...hygiene, humanQuietHours: 47 } })
				.success,
		).toBe(false);
	});

	it("accepts an optional exact resource key without changing ordinary paging", () => {
		const schema = inputSchema("listResourcePools");
		const resourceKey = "file:tedix:src/My File.ts";
		expect(schema.parse({ resourceKey, limit: 1 })).toEqual({
			resourceKey,
			limit: 1,
		});
		expect(schema.parse({ limit: 20 })).toEqual({ limit: 20 });
		expect(schema.safeParse(undefined).success).toBe(true);
		for (const value of ["", "a".repeat(301), null, [resourceKey]])
			expect(schema.safeParse({ resourceKey: value }).success).toBe(false);
		expect(
			schema.parse({ resourceKey: "a".repeat(300) }).resourceKey,
		).toHaveLength(300);
	});

	it("publishes bounded per-attempt repository inspection", () => {
		expect(
			inputSchema("inspectAttemptRepository").parse({
				id: "11111111-1111-4111-8111-111111111111",
				attemptId: "22222222-2222-4222-8222-222222222222",
				operation: "diff",
				path: "src/index.ts",
			}),
		).toMatchObject({ operation: "diff", path: "src/index.ts" });
	});

	it("types bounded keyset filters for org-wide factory projections", () => {
		const cursor = {
			at: "2026-08-20T12:00:00.000Z",
			id: "00000000-0000-4000-8000-000000000001",
		};
		expect(
			inputSchema("listAttemptProjection").safeParse({
				cursor,
				limit: 100,
				runtimeStates: ["running", "expired"],
				executorType: "external_agent",
			}).success,
		).toBe(true);
		expect(
			inputSchema("listRecoveryProjection").safeParse({
				signal: "latest_attempt_expired",
				limit: 101,
			}).success,
		).toBe(false);
	});

	it("bounds the accepted queue readiness projection to stable keyset pages", () => {
		const schema = inputSchema("listReadinessProjection");
		const cursor = {
			at: "2026-08-20T12:00:00.000Z",
			id: "00000000-0000-4000-8000-000000000001",
		};
		expect(
			schema.safeParse({
				projectId: "00000000-0000-4000-8000-000000000002",
				workKind: "operations",
				cursor,
				limit: 50,
			}).success,
		).toBe(true);
		expect(schema.safeParse({ cursor, limit: 51 }).success).toBe(false);
		expect(schema.safeParse({ cursor: { at: cursor.at } }).success).toBe(false);
	});

	it("uses bounded keyset pages for case and item-detail ledgers", () => {
		const cursor = {
			at: "2026-08-20T12:00:00.000Z",
			id: "00000000-0000-4000-8000-000000000001",
		};
		for (const operation of [
			"listCases",
			"listAttempts",
			"listEvidence",
		] as const) {
			expect(
				inputSchema(operation).safeParse({
					...(operation === "listCases"
						? {}
						: { id: "00000000-0000-4000-8000-000000000002" }),
					cursor,
					limit: 100,
				}).success,
			).toBe(true);
			expect(
				inputSchema(operation).safeParse({
					...(operation === "listCases"
						? {}
						: { id: "00000000-0000-4000-8000-000000000002" }),
					limit: 101,
				}).success,
			).toBe(false);
		}
	});

	it("rejects lifecycle state on create", () => {
		expect(
			CreateWorkItemInputSchema.safeParse({
				title: "Implement artifact-neutral evidence",
				status: "in_progress",
			}),
		).toMatchObject({ success: false });
		expect(
			CreateWorkItemInputSchema.safeParse({
				title: "Implement artifact-neutral evidence",
				disposition: "completed",
			}),
		).toMatchObject({ success: false });
	});

	it("derives executor identity and keeps the attempt fence server-authoritative", () => {
		const start = inputSchema("startAttempt").parse({
			id: "11111111-1111-4111-8111-111111111111",
			tediId: "22222222-2222-4222-8222-222222222222",
		});
		expect(start).not.toHaveProperty("tediId");
		expect(start).not.toHaveProperty("expiresAt");

		const systemEvidence = inputSchema("submitEvidence").parse({
			id: "11111111-1111-4111-8111-111111111111",
			claimKey: "delivery_receipt",
			kind: "email_receipt",
			uri: "artifact://receipt/1",
		});
		expect(systemEvidence.attemptId).toBeUndefined();
	});

	it("distinguishes unevaluated constrained readiness from a failed gate", () => {
		expect(
			WorkItemReadinessSchema.safeParse({
				workItemId: "00000000-0000-4000-8000-000000000001",
				ready: false,
				state: "evaluation_required",
				reasons: [
					{
						code: "evaluation_required",
						detail:
							"Budget or resource eligibility requires current evaluation",
					},
				],
				gates: [],
				derivedAt: "2026-08-20T12:00:00.000Z",
			}).success,
		).toBe(true);
	});

	it("accepts non-code evidence kinds on the same lifecycle", () => {
		const parsed = inputSchema("submitEvidence").parse({
			id: "11111111-1111-4111-8111-111111111111",
			attemptId: "22222222-2222-4222-8222-222222222222",
			claimKey: "customer_contacted",
			kind: "email_receipt",
			uri: "artifact://receipt/1",
		});
		expect(parsed.kind).toBe("email_receipt");
	});

	it("rejects raw tedi deliverable storage paths but keeps canonical and non-artifact locators", () => {
		const schema = inputSchema("submitEvidence");
		const base = {
			id: "11111111-1111-4111-8111-111111111111",
			claimKey: "delivery_receipt",
			kind: "artifact",
		};
		expect(
			schema.safeParse({
				...base,
				uri: "r2://test-tedi-artifacts/tedi-1/artifacts/deliverable/report.md",
			}).success,
		).toBe(false);
		expect(
			schema.safeParse({ ...base, uri: "artifact://artifact-123" }).success,
		).toBe(true);
		expect(
			schema.safeParse({
				...base,
				uri: "r2://test-tedi-artifacts/tedi-1/other-evidence/report.json",
			}).success,
		).toBe(true);
	});
});

it("mounts the five distinct strict bounded Work CLI procedures", () => {
	expect(Object.keys(workItemsContract)).toEqual(
		expect.arrayContaining([
			"listCliProjection",
			"getCheckpointProjection",
			"listAttemptCliProjection",
			"listEvidenceCliProjection",
			"listEventCliProjection",
		]),
	);
});
