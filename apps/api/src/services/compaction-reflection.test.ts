import { describe, expect, it } from "vite-plus/test";
import {
	buildCompactionReflectionInstanceId,
	COMPACTION_EVENT_KIND,
	isCompactionEventKind,
	isDuplicateInstanceError,
	startCompactionReflection,
} from "./compaction-reflection";

/** The real shape emitted by `runCompaction`: `{tediId}:compaction:{markerTs}:compaction:{firstKeptEntryId}`. */
const EVENT_ID = "tedi-abc:compaction:1754130000000:compaction:entry-42";

function fakeWorkflow(impl?: () => Promise<{ id: string }>) {
	const calls: Array<{ id: string; params: Record<string, unknown> }> = [];
	return {
		calls,
		create: async (options: {
			id: string;
			params: Record<string, unknown>;
		}) => {
			calls.push(options);
			return impl ? await impl() : { id: options.id };
		},
	};
}

describe("isCompactionEventKind", () => {
	it("matches only the canonical compaction event", () => {
		expect(isCompactionEventKind(COMPACTION_EVENT_KIND)).toBe(true);
		expect(isCompactionEventKind("context.compacted")).toBe(true);
		expect(isCompactionEventKind("run.completed")).toBe(false);
		expect(isCompactionEventKind("message.delta")).toBe(false);
	});
});

describe("buildCompactionReflectionInstanceId", () => {
	it("strips colons, which Cloudflare Workflow instance ids reject", () => {
		const id = buildCompactionReflectionInstanceId(EVENT_ID);
		expect(id).not.toContain(":");
		expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
	});

	it("is deterministic — the same cut always maps to the same instance", () => {
		expect(buildCompactionReflectionInstanceId(EVENT_ID)).toBe(
			buildCompactionReflectionInstanceId(EVENT_ID),
		);
	});

	it("separates distinct cuts", () => {
		expect(buildCompactionReflectionInstanceId(EVENT_ID)).not.toBe(
			buildCompactionReflectionInstanceId(`${EVENT_ID}-other`),
		);
	});

	it("bounds the id length", () => {
		const id = buildCompactionReflectionInstanceId("x".repeat(500));
		expect(id.length).toBeLessThanOrEqual(100);
	});

	/**
	 * Production-shaped ids. They are ~160 chars and share a long common prefix — tediId, marker, session key — so a
	 * plain truncation would collapse distinct cuts onto one instance and
	 * silently skip the second reflection.
	 */
	const LIVE_IDS = [
		"11111111-2222-4333-8444-555555555555:compaction:1785519893813:compaction:agent:main:main:11111111-2222-4333-8444-555555555555:cron:cron_r0_EcCdzH_1784451600:0",
		"11111111-2222-4333-8444-555555555555:compaction:1784765723541:compaction:agent:main:main:11111111-2222-4333-8444-555555555555:cron:cron_tgMv4jjiw_1784450400:0",
		"11111111-2222-4333-8444-555555555555:compaction:1784501693658:compaction:agent:main:main:11111111-2222-4333-8444-555555555555:cron:cron_r0_EcCdzH_1784449800:0",
	];

	it("keeps production-shaped event ids within the cap", () => {
		for (const eventId of LIVE_IDS) {
			const id = buildCompactionReflectionInstanceId(eventId);
			expect(id.length).toBeLessThanOrEqual(100);
			expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
		}
	});

	it("keeps distinct real cuts distinct after truncation", () => {
		const ids = LIVE_IDS.map(buildCompactionReflectionInstanceId);
		expect(new Set(ids).size).toBe(LIVE_IDS.length);
	});

	it("distinguishes ids differing ONLY in the truncated tail", () => {
		const base = `${"a".repeat(200)}:tail-one`;
		const other = `${"a".repeat(200)}:tail-two`;
		expect(buildCompactionReflectionInstanceId(base)).not.toBe(
			buildCompactionReflectionInstanceId(other),
		);
	});

	it("stays deterministic for a truncated id (a retried cut must dedupe)", () => {
		expect(buildCompactionReflectionInstanceId(LIVE_IDS[0] ?? "")).toBe(
			buildCompactionReflectionInstanceId(LIVE_IDS[0] ?? ""),
		);
	});
});

describe("startCompactionReflection", () => {
	it("starts a tedi-scoped recent reflection", async () => {
		const workflow = fakeWorkflow();
		const outcome = await startCompactionReflection({
			workflow,
			eventId: EVENT_ID,
			organizationId: "org-1",
			tediId: "tedi-abc",
		});
		expect(outcome.status).toBe("started");
		expect(workflow.calls).toHaveLength(1);
		expect(workflow.calls[0]?.params).toEqual({
			organizationId: "org-1",
			tediId: "tedi-abc",
			scope: "recent",
		});
	});

	it("uses scope 'recent', never 'full' — the nightly sweep owns the org-wide pass", async () => {
		const workflow = fakeWorkflow();
		await startCompactionReflection({
			workflow,
			eventId: EVENT_ID,
			organizationId: "org-1",
			tediId: "tedi-abc",
		});
		expect(workflow.calls[0]?.params.scope).toBe("recent");
	});

	it("treats a duplicate instance as success, not an error", async () => {
		const workflow = fakeWorkflow(async () => {
			throw new Error("instance with id already exists");
		});
		const outcome = await startCompactionReflection({
			workflow,
			eventId: EVENT_ID,
			organizationId: "org-1",
			tediId: "tedi-abc",
		});
		expect(outcome.status).toBe("duplicate");
	});

	it("never throws when the workflow rejects for another reason", async () => {
		const workflow = fakeWorkflow(async () => {
			throw new Error("workflows service unavailable");
		});
		const outcome = await startCompactionReflection({
			workflow,
			eventId: EVENT_ID,
			organizationId: "org-1",
			tediId: "tedi-abc",
		});
		expect(outcome.status).toBe("failed");
	});

	it("skips cleanly when the binding is absent", async () => {
		const outcome = await startCompactionReflection({
			workflow: undefined,
			eventId: EVENT_ID,
			organizationId: "org-1",
			tediId: "tedi-abc",
		});
		expect(outcome).toEqual({ status: "skipped", reason: "no_binding" });
	});
});

describe("isDuplicateInstanceError", () => {
	it("recognizes the Workflows duplicate-instance rejection", () => {
		expect(isDuplicateInstanceError(new Error("instance already exists"))).toBe(
			true,
		);
		expect(
			isDuplicateInstanceError(new Error("duplicate instance id supplied")),
		).toBe(true);
		expect(isDuplicateInstanceError(new Error("network unreachable"))).toBe(
			false,
		);
	});
});
