import {
	ListWorkCliProjectionInputSchema,
	WorkCliBoardRowSchema,
	WorkAttemptCliRowSchema,
	WorkCliLedgerInputSchema,
	WorkCliEventInputSchema,
} from "./work-items";
import { describe, expect, it } from "vite-plus/test";

import {
	CreateWorkItemInputSchema,
	UpdateWorkItemInputSchema,
	WorkItemCapabilityBundleSchema,
	WorkItemClassSchema,
	WorkItemCommentSchema,
	WorkAttemptRepositoryRequestSchema,
	WorkAttemptRepositorySchema,
	WorkAttemptRepositoryLifecycleSchema,
	ResolvedWorkEvidenceSchema,
	WorkEvidencePreviewSchema,
} from "./work-items";

describe("Work Attempt Artifacts repository", () => {
	it("normalizes a fork request and exposes secret-free provenance", () => {
		expect(
			WorkAttemptRepositoryRequestSchema.parse({
				mode: "fork",
				sourceRepositoryName: "tedix-main",
			}),
		).toMatchObject({ sourceRef: "HEAD" });
		const repository = WorkAttemptRepositorySchema.parse({
			version: 1,
			provider: "cloudflare_artifacts",
			status: "ready",
			mode: "fork",
			repositoryName: "work-12345678-11111111-1111-4111-8111-111111111111",
			repositoryId: "repo-1",
			remote:
				"https://example.artifacts.cloudflare.net/git/tedix/work-repo.git",
			defaultBranch: "main",
			sourceRepositoryName: "tedix-main",
			sourceRef: "HEAD",
			baseRevision: "a".repeat(40),
			workItemId: "22222222-2222-4222-8222-222222222222",
			workItemVersion: 3,
			admissionSpecRevision: "spec-3",
			admissionId: "33333333-3333-4333-8333-333333333333",
			attemptId: "11111111-1111-4111-8111-111111111111",
			observedAt: "2026-10-01T00:00:00.000Z",
			reason: null,
		});
		expect(repository.baseRevision).toBe("a".repeat(40));
	});

	it("rejects token material and malformed repository names", () => {
		expect(() =>
			WorkAttemptRepositoryRequestSchema.parse({
				mode: "fork",
				sourceRepositoryName: "owner/repo",
			}),
		).toThrow();
		expect(() =>
			WorkAttemptRepositorySchema.parse({
				version: 1,
				provider: "cloudflare_artifacts",
				status: "unavailable",
				mode: "create",
				repositoryName: "repo",
				repositoryId: null,
				remote: null,
				defaultBranch: null,
				sourceRepositoryName: null,
				sourceRef: null,
				baseRevision: null,
				workItemId: "22222222-2222-4222-8222-222222222222",
				workItemVersion: 1,
				admissionSpecRevision: "spec",
				admissionId: "33333333-3333-4333-8333-333333333333",
				attemptId: "11111111-1111-4111-8111-111111111111",
				observedAt: "2026-10-01T00:00:00.000Z",
				reason: "disabled",
				token: "must-not-cross-the-api",
			}),
		).toThrow();
	});

	it("requires checkable review, GitHub-main merge, and deployment receipts", () => {
		const lifecycle = WorkAttemptRepositoryLifecycleSchema.parse({
			version: 1,
			headRevision: "b".repeat(40),
			review: {
				status: "approved",
				evidenceRef: "https://github.com/tedix-hq/tedix/pull/42",
				reviewedAt: "2026-10-01T01:00:00.000Z",
			},
			merge: {
				status: "merged",
				canonicalLedger: "github_main",
				repository: "tedix-hq/tedix",
				commitSha: "c".repeat(40),
				mergedAt: "2026-10-01T01:05:00.000Z",
			},
			deployment: {
				status: "deployed",
				surface: "api",
				revision: "version-1",
				evidenceRef: "https://api.tedix.tech/health",
				observedAt: "2026-10-01T01:10:00.000Z",
			},
		});
		expect(lifecycle.merge.canonicalLedger).toBe("github_main");
		expect(() =>
			WorkAttemptRepositoryLifecycleSchema.parse({
				...lifecycle,
				merge: { ...lifecycle.merge, commitSha: null },
			}),
		).toThrow();
	});
});

const baseComment = {
	workItemId: "5eed0017-0000-4000-8000-000000000017",
	orgId: "0f0f0f0f-0000-4000-8000-000000000001",
	authorType: "tedi" as const,
	authorId: "5eed0038-0000-4000-8000-000000000038",
	body: "Delegated tedi completed with proof.",
	eventType: "completed",
	metadata: {},
	createdAt: "2026-07-17T21:41:40.317Z",
};

describe("WorkItemCommentSchema", () => {
	it("accepts deterministic kernel reconciliation ids", () => {
		for (const id of [
			"5f0d4df4-1208-49a3-90ed-f36c0d9c3a21",
			`${baseComment.workItemId}:heartbeat:${baseComment.createdAt}`,
			`${baseComment.workItemId}:terminal:completed`,
		]) {
			expect(WorkItemCommentSchema.parse({ ...baseComment, id }).id).toBe(id);
		}
	});

	it("still rejects an empty comment id", () => {
		expect(() =>
			WorkItemCommentSchema.parse({ ...baseComment, id: "" }),
		).toThrow();
	});
});

describe("resolved Work evidence", () => {
	it("distinguishes manifest identity from preview bytes and keeps external evidence unverified", () => {
		const row = ResolvedWorkEvidenceSchema.parse({
			id: "11111111-1111-4111-8111-111111111111",
			workItemId: "22222222-2222-4222-8222-222222222222",
			orgId: "33333333-3333-4333-8333-333333333333",
			attemptId: null,
			claimKey: "result",
			kind: "artifact",
			uri: "artifact://bundle%3Aone",
			digest: "a".repeat(64),
			mediaType: "application/json",
			label: null,
			submittedByType: "user",
			submittedById: "user-1",
			submittedBySessionId: null,
			disposition: "pending",
			reviewedByType: null,
			reviewedById: null,
			reviewedBySessionId: null,
			reviewReason: null,
			submittedAt: "2026-09-22T00:00:00.000Z",
			reviewedAt: null,
			version: 1,
			metadata: {},
			reference: {
				kind: "artifact",
				status: "available",
				canonicalUri: "artifact://bundle%3Aone",
				artifactId: "bundle:one",
				digest: "a".repeat(64),
				mediaType: "application/json",
				reason: null,
				bundleDigestKind: "manifest",
			},
		});
		expect(row.reference).toMatchObject({ bundleDigestKind: "manifest" });
		expect(
			WorkEvidencePreviewSchema.parse({
				status: "external",
				href: "https://example.com/x",
				trust: "unverified_external",
			}).status,
		).toBe("external");
	});
});

describe("Work Item purpose contract", () => {
	it("keeps the classification vocabulary closed", () => {
		for (const value of ["objective", "maintenance", "incident", "hygiene"]) {
			expect(WorkItemClassSchema.parse(value)).toBe(value);
		}
		expect(() => WorkItemClassSchema.parse("miscellaneous")).toThrow();
	});

	it("accepts a time-bounded operational classification on create", () => {
		const parsed = CreateWorkItemInputSchema.parse({
			title: "Rebuild the failed search index",
			workClass: "incident",
			purposeExceptionExpiresAt: "2026-07-27T00:00:00.000Z",
		});
		expect(parsed.workClass).toBe("incident");
	});

	it("rejects a non-ISO purpose exception expiry", () => {
		expect(() =>
			UpdateWorkItemInputSchema.parse({
				id: "5eed0017-0000-4000-8000-000000000017",
				purposeExceptionExpiresAt: "next week",
			}),
		).toThrow();
	});
});

describe("WorkItemCapabilityBundleSchema", () => {
	it("defaults bounded requirement lists and preserves typed execution intent", () => {
		const parsed = WorkItemCapabilityBundleSchema.parse({
			version: 1,
			requiredCapabilities: ["browser_session", "live_verify"],
			tools: [{ appSlug: "github", toolId: "list_commits" }],
			connections: [{ providerId: "github" }],
		});
		expect(parsed).toMatchObject({
			version: 1,
			requiredCapabilities: ["browser_session", "live_verify"],
			prohibitedSurfaces: [],
			connections: [{ providerId: "github", tokenScope: "either", scopes: [] }],
		});
	});

	it("rejects duplicate tool and capability requirements", () => {
		expect(() =>
			WorkItemCapabilityBundleSchema.parse({
				version: 1,
				requiredCapabilities: ["tests", "tests"],
				tools: [
					{ appSlug: "github", toolId: "list_commits" },
					{ appSlug: "github", toolId: "list_commits" },
				],
			}),
		).toThrow();
	});
});

describe("CreateWorkItemInputSchema due-date and deadline instants", () => {
	const base = { title: "Ship the bounded urgency fix" };

	it("accepts ISO-8601 instants", () => {
		const parsed = CreateWorkItemInputSchema.parse({
			...base,
			dueDate: "2026-08-26T09:00:00.000Z",
			deadline: "2026-08-27T09:00:00Z",
		});
		expect(parsed.dueDate).toBe("2026-08-26T09:00:00.000Z");
		expect(parsed.deadline).toBe("2026-08-27T09:00:00Z");
	});

	it("keeps the board's dominant legitimate form: a bare calendar date", () => {
		// Stored rows commonly carry `YYYY-MM-DD`; `Date.parse` resolves it to
		// UTC midnight and the scheduler ranks it correctly.
		const parsed = CreateWorkItemInputSchema.parse({
			...base,
			dueDate: "2026-07-13",
			deadline: "2026-07-14",
		});
		expect(parsed.dueDate).toBe("2026-07-13");
		expect(parsed.deadline).toBe("2026-07-14");
	});

	it("rejects every free-text due date production actually collected", () => {
		for (const value of [
			"today",
			"Today",
			"now",
			"immediate",
			"immediately",
			"daily",
			"Friday",
			"regular Friday meeting",
			"next scheduled cycle",
			"after verified writes",
			"90s",
			"90s after run start",
			"within 90 seconds of the echo send",
			"~8 minutes after run start if no terminal",
			"~10 minutes of wall clock",
			"2026-05-31 15:42 UTC",
		]) {
			expect(() =>
				CreateWorkItemInputSchema.parse({ ...base, dueDate: value }),
			).toThrow();
			expect(() =>
				CreateWorkItemInputSchema.parse({ ...base, deadline: value }),
			).toThrow();
		}
	});

	it("rejects a Date.parse-able value that is not an ISO form", () => {
		// `Date.parse` accepts these, so the scheduler would rank them, but they
		// are locale-dependent and are not what this board stores.
		for (const value of [
			"June 3, 2026",
			"2026/06/03",
			"2026-05-31 15:42 UTC",
		]) {
			expect(() =>
				CreateWorkItemInputSchema.parse({ ...base, dueDate: value }),
			).toThrow();
		}
	});

	it("carries the same constraint into the derived update input", () => {
		const id = "5eed0017-0000-4000-8000-000000000017";
		expect(
			UpdateWorkItemInputSchema.parse({
				id,
				deadline: "2026-08-27T09:00:00.000Z",
			}).deadline,
		).toBe("2026-08-27T09:00:00.000Z");
		expect(() =>
			UpdateWorkItemInputSchema.parse({ id, deadline: "next Friday" }),
		).toThrow();
	});
});

describe("bounded CLI read contracts", () => {
	it("refuses unknown views, filters, oversized pages and malformed ledger cursors", () => {
		expect(
			ListWorkCliProjectionInputSchema.parse({ view: "board" }),
		).toMatchObject({ limit: 50, offset: 0 });
		for (const v of [
			{ view: "other" },
			{ view: "board", status: "open" },
			{ view: "board", limit: 51 },
		])
			expect(ListWorkCliProjectionInputSchema.safeParse(v).success).toBe(false);
		expect(
			WorkCliLedgerInputSchema.safeParse({
				id: "00000000-0000-4000-8000-000000000001",
				cursor: { at: "not-time", id: "unknown" },
			}).success,
		).toBe(false);
		expect(
			WorkCliEventInputSchema.safeParse({
				id: "00000000-0000-4000-8000-000000000001",
				limit: 101,
			}).success,
		).toBe(false);
	});
	it("rejects full data in a compact row rather than silently dropping a leaked policy", () => {
		const row = {
			id: "00000000-0000-4000-8000-000000000001",
			workKind: "coding",
			disposition: "accepted",
			riskLevel: "high",
			priority: "high",
			title: "Title",
			projectId: null,
			createdAt: "2026-10-07T00:00:00.000Z",
			activeAttempt: null,
		};
		expect(WorkCliBoardRowSchema.parse(row)).toEqual(row);
		expect(
			WorkCliBoardRowSchema.safeParse({
				...row,
				metadata: { secret: "not part of CLI" },
			}).success,
		).toBe(false);
		expect(WorkAttemptCliRowSchema.shape).not.toHaveProperty("metadata");
	});
});
