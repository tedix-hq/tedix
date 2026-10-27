import { expect, it } from "bun:test";
import {
	settlementReason,
	listWorkProgram,
	cancelWorkProgram,
} from "./backfill-commit-watch.mjs";
const now = "2026-10-26T12:00:00Z";
const push = {
	id: "push",
	orgId: "org-example",
	projectId: "project-example",
	disposition: "proposed",
	createdAt: "2026-10-24T12:00:00Z",
	metadata: {
		repositoryObserver: 1,
		event: {
			kind: "push",
			repository: "example/repo",
			branch: "main",
			sha: "a".repeat(40),
		},
	},
};
it("settles all reported or aged pushes, preserving active and ordinary work", () => {
	expect(settlementReason(push, [], now)).toContain("24 hours");
	expect(settlementReason({ ...push, createdAt: now }, [], now)).toBeNull();
	expect(
		settlementReason({ ...push, activeAttempt: { id: "attempt" } }, [], now),
	).toBeNull();
	expect(settlementReason({ ...push, metadata: {} }, [], now)).toBeNull();
	expect(
		settlementReason({ ...push, disposition: "cancelled" }, [], now),
	).toBeNull();
	for (const stillRed of [undefined, false, true])
		expect(
			settlementReason(
				{
					...push,
					createdAt: now,
					metadata: { ...push.metadata, report: { stillRed } },
				},
				[],
				now,
			),
		).toContain("reported");
	expect(
		settlementReason(
			{
				...push,
				metadata: {
					...push.metadata,
					report: {},
					latestReport: { stillRed: true },
				},
			},
			[],
			now,
		),
	).toContain("reported");
});
it("only open red follow-ups in the same tenant, project, repository, branch and commit block aging", () => {
	const red = {
		...push,
		id: "red",
		metadata: {
			...push.metadata,
			event: { ...push.metadata.event, kind: "ci_red" },
		},
	};
	expect(settlementReason(push, [red], now)).toBeNull();
	for (const disposition of ["completed", "cancelled"])
		expect(settlementReason(push, [{ ...red, disposition }], now)).toContain(
			"24 hours",
		);
	for (const field of ["orgId", "projectId"])
		expect(
			settlementReason(push, [{ ...red, [field]: "other" }], now),
		).toContain("24 hours");
	for (const field of ["repository", "branch", "sha"])
		expect(
			settlementReason(
				push,
				[
					{
						...red,
						metadata: {
							...red.metadata,
							event: { ...red.metadata.event, [field]: "other" },
						},
					},
				],
				now,
			),
		).toContain("24 hours");
});

it("keeps backfill list scope inside arguments", async () => {
	const hostile =
		'"; throw new Error("escaped"); // ` ${escape()} </script>\u2028\u2029';
	const source = listWorkProgram(hostile, "proposed", 100);
	expect(source).not.toContain("</script>");
	expect(source).not.toMatch(/[\u2028\u2029]/);
	let calls = 0;
	const result = await new Function("work", `return (${source})()`)({
		list_work_items: (input: unknown) => {
			calls++;
			expect(input).toEqual({
				projectId: hostile,
				disposition: "proposed",
				limit: 100,
				offset: 100,
			});
			return { data: [], pagination: { hasMore: false } };
		},
	});
	expect(result).toEqual({ data: [], hasMore: false });
	expect(calls).toBe(1);
});

it("keeps backfill lookup IDs and cancellation reasons inside arguments", async () => {
	const hostile =
		'"; throw new Error("escaped"); // ` ${escape()} </script>\u2028\u2029';
	const row = { id: hostile, reason: hostile, version: 3 };
	const source = cancelWorkProgram(row);
	expect(source).not.toContain("</script>");
	expect(source).not.toMatch(/[\u2028\u2029]/);
	let cancelled = 0;
	const work = {
		get_work_items_by_id: (input: unknown) => {
			expect(input).toEqual({ id: hostile });
			return { workItem: { ...row, disposition: "proposed" } };
		},
	};
	const ceo = {
		cancel_work_item: (input: unknown) => {
			cancelled++;
			expect(input).toEqual({ id: hostile, reason: hostile });
			return { id: hostile, disposition: "cancelled" };
		},
	};
	expect(
		await new Function("work", "ceo", `return (${source})()`)(work, ceo),
	).toEqual({ id: hostile, status: "cancelled" });
	expect(cancelled).toBe(1);
});

it("compares a hostile backfill version as data and skips changed rows", async () => {
	const version =
		'"; throw new Error("escaped"); // ` ${escape()} </script>\u2028\u2029';
	const source = cancelWorkProgram({ id: "sample", version, reason: "sample" });
	expect(source).not.toContain("</script>");
	expect(source).not.toMatch(/[\u2028\u2029]/);
	const result = await new Function("work", "ceo", `return (${source})()`)(
		{
			get_work_items_by_id: () => ({
				workItem: { id: "sample", version: 1, disposition: "proposed" },
			}),
		},
		{
			cancel_work_item: () => {
				throw new Error("changed row must not be cancelled");
			},
		},
	);
	expect(result).toEqual({ id: "sample", status: "changed" });
});
