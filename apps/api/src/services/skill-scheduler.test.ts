import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const getTediByIdMock = vi.fn();
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediById: (...args: unknown[]) => getTediByIdMock(...args),
}));

import {
	makeTediBudgetProbe,
	scheduledBudgetClassForSkillSlug,
	scheduledSkillWorkflowIdempotencyKey,
} from "./skill-scheduler";

describe("skill scheduler", () => {
	it("derives one stable admission identity per skill and scheduled fire", () => {
		const first = scheduledSkillWorkflowIdempotencyKey(
			"skill-1",
			"2026-07-20T08:00:00.000Z",
		);
		expect(first).toBe("skill-schedule:skill-1:2026-07-20T08:00:00.000Z");
		expect(
			scheduledSkillWorkflowIdempotencyKey(
				"skill-1",
				"2026-07-20T08:00:00.000Z",
			),
		).toBe(first);
		expect(
			scheduledSkillWorkflowIdempotencyKey(
				"skill-1",
				"2026-07-27T08:00:00.000Z",
			),
		).not.toBe(first);
	});

	it("routes only canonical cognitive skills through governed-learning capacity", () => {
		expect(
			scheduledBudgetClassForSkillSlug("platform-brain-reflection-dogfood"),
		).toBe("governed_learning");
		expect(
			scheduledBudgetClassForSkillSlug("platform-grounding-review-dogfood"),
		).toBe("governed_learning");
		expect(scheduledBudgetClassForSkillSlug("content-operations")).toBe(
			"background",
		);
		expect(scheduledBudgetClassForSkillSlug(null)).toBe("background");
	});
});

function budgetEnv(fetchImpl: (url: string) => Promise<Response> | Response) {
	return {
		TEDI_SERVICE: {
			fetch: (input: string | URL | Request) =>
				Promise.resolve(fetchImpl(String(input))),
		},
	} as unknown as CloudflareEnv;
}

const fakeDb = {} as ReturnType<
	typeof import("@tedix/db/client").createDbClient
>;

describe("tedi budget probe (scheduler suppression gate)", () => {
	beforeEach(() => {
		getTediByIdMock.mockReset();
		getTediByIdMock.mockResolvedValue({ slug: "cto" });
	});

	it("reports exhausted only when the runtime says backgroundExhausted", async () => {
		const probeTrue = await makeTediBudgetProbe(
			budgetEnv(
				() => new Response(JSON.stringify({ backgroundExhausted: true })),
			),
			fakeDb,
		);
		expect(await probeTrue("tedi-1")).toMatchObject({
			admissionClass: "background",
			exhausted: true,
			reason: "background inference budget exhausted",
		});

		const probeFalse = await makeTediBudgetProbe(
			budgetEnv(
				() => new Response(JSON.stringify({ backgroundExhausted: false })),
			),
			fakeDb,
		);
		expect(await probeFalse("tedi-1")).toEqual({
			admissionClass: "background",
			exhausted: false,
			reason: null,
			resetAt: null,
		});
	});

	it("uses the class-aware verdict for governed learning and fails open against an old runtime", async () => {
		const requestedUrls: string[] = [];
		const probe = await makeTediBudgetProbe(
			budgetEnv((url) => {
				requestedUrls.push(url);
				return new Response(
					JSON.stringify({
						admissionClass: "governed_learning",
						exhausted: true,
						backgroundExhausted: true,
						reason: "protected learning slice exhausted",
						resetAt: "2026-07-26T00:00:00.000Z",
					}),
				);
			}),
			fakeDb,
		);
		expect(await probe("tedi-1", "governed_learning")).toEqual({
			admissionClass: "governed_learning",
			exhausted: true,
			reason: "protected learning slice exhausted",
			resetAt: "2026-07-26T00:00:00.000Z",
		});
		expect(requestedUrls[0]).toContain("admissionClass=governed_learning");

		const rollingProbe = await makeTediBudgetProbe(
			budgetEnv(
				() => new Response(JSON.stringify({ backgroundExhausted: true })),
			),
			fakeDb,
		);
		expect((await rollingProbe("tedi-1", "governed_learning")).exhausted).toBe(
			false,
		);
	});

	it("fails OPEN (not exhausted) on non-2xx, thrown fetch, or missing slug", async () => {
		const probe500 = await makeTediBudgetProbe(
			budgetEnv(() => new Response("boom", { status: 500 })),
			fakeDb,
		);
		expect((await probe500("tedi-1")).exhausted).toBe(false);

		const probeThrow = await makeTediBudgetProbe(
			budgetEnv(() => {
				throw new Error("binding unavailable");
			}),
			fakeDb,
		);
		expect((await probeThrow("tedi-1")).exhausted).toBe(false);

		getTediByIdMock.mockResolvedValue({ slug: null });
		const probeNoSlug = await makeTediBudgetProbe(
			budgetEnv(
				() => new Response(JSON.stringify({ backgroundExhausted: true })),
			),
			fakeDb,
		);
		expect((await probeNoSlug("tedi-1")).exhausted).toBe(false);
	});

	it("memoizes per tedi so each distinct tedi is probed at most once", async () => {
		let calls = 0;
		const probe = await makeTediBudgetProbe(
			budgetEnv(() => {
				calls++;
				return new Response(JSON.stringify({ backgroundExhausted: true }));
			}),
			fakeDb,
		);
		expect((await probe("tedi-1")).exhausted).toBe(true);
		expect((await probe("tedi-1")).exhausted).toBe(true);
		expect(calls).toBe(1);
		expect(getTediByIdMock).toHaveBeenCalledTimes(1);

		expect((await probe("tedi-1", "governed_learning")).exhausted).toBe(false);
		expect(calls).toBe(2);
		expect(
			getTediByIdMock,
			"each tedi and admission class needs an independent probe",
		).toHaveBeenCalledTimes(2);
	});
});
