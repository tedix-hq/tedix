import { expect, it } from "bun:test";
import { settlementReason } from "./backfill-commit-watch.mjs";
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
