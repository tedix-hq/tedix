import {
	SkillWorkflowTimelineEventSchema,
	type SkillWorkflowTimelineEvent,
	type SkillWorkflowRunTimeline,
} from "@tedix/api-contract/schemas/cognitive";
import type { SkillRun, SkillRunArtifact } from "@tedix/db/schema/cognitive";

/** Read only compact receipts. Historical artifact bodies are never inferred. */
export function buildSkillWorkflowTimeline(
	run: Pick<
		SkillRun,
		"id" | "status" | "startedAt" | "completedAt" | "executionEpoch"
	>,
	artifacts: Pick<SkillRunArtifact, "path" | "contentInline">[],
): SkillWorkflowRunTimeline {
	const executionEpoch = run.executionEpoch ?? 0;
	const prefix = `timeline/epochs/${executionEpoch}/`;
	const events: SkillWorkflowTimelineEvent[] = [];
	const warnings: string[] = [];
	let covered = false;
	for (const artifact of artifacts) {
		if (!artifact.path.startsWith(prefix)) continue;
		let value: unknown;
		try {
			value = JSON.parse(artifact.contentInline ?? "null");
		} catch {
			warnings.push(`Invalid compact timeline receipt: ${artifact.path}`);
			continue;
		}
		if (artifact.path === `${prefix}coverage.json`) {
			if (
				typeof value === "object" &&
				value !== null &&
				"schemaVersion" in value &&
				value.schemaVersion === 1 &&
				"kind" in value &&
				value.kind === "coverage" &&
				"executionEpoch" in value &&
				value.executionEpoch === executionEpoch
			)
				covered = true;
			else warnings.push("Invalid timeline coverage marker.");
			continue;
		}
		const parsed = SkillWorkflowTimelineEventSchema.safeParse(value);
		if (
			!parsed.success ||
			parsed.data.executionEpoch !== executionEpoch ||
			parsed.data.id !== parsed.data.path ||
			artifact.path !== `timeline/${parsed.data.path}`
		) {
			warnings.push(`Invalid compact timeline receipt: ${artifact.path}`);
			continue;
		}
		events.push(parsed.data);
	}
	if (!covered)
		warnings.push(
			"This execution epoch has no timeline coverage marker; recorded history may be incomplete.",
		);
	if (
		["completed", "failed", "canceled"].includes(run.status) &&
		events.some((event) => event.outcome === "pending")
	) {
		warnings.push(
			"This terminal run has pending receipts; recording may have been interrupted.",
		);
	}
	events.sort(
		(a, b) =>
			(a.startedAt ?? "\uffff").localeCompare(b.startedAt ?? "\uffff") ||
			a.path.localeCompare(b.path),
	);
	const lanes = new Map<string, SkillWorkflowRunTimeline["lanes"][number]>();
	for (const event of events) {
		const lane = lanes.get(event.lane);
		if (!lane)
			lanes.set(event.lane, {
				id: event.lane,
				label: event.lane,
				kind: event.kind,
			});
		else if (lane.kind !== event.kind) lane.kind = "mixed";
	}
	const phases: SkillWorkflowRunTimeline["phases"] = [];
	for (const id of ["run", "rollback"] as const) {
		const members = events.filter(
			(event) =>
				(event.phase ?? (event.kind === "rollback" ? "rollback" : "run")) ===
				id,
		);
		if (!members.length) continue;
		const starts = members
			.flatMap((event) => (event.startedAt === null ? [] : [event.startedAt]))
			.sort();
		const ends = members
			.flatMap((event) => (event.endedAt === null ? [] : [event.endedAt]))
			.sort();
		const calls = { ok: 0, failed: 0, pending: 0 };
		for (const event of members) {
			if (event.kind !== "mcp" && event.kind !== "network") continue;
			calls[
				event.outcome === "success"
					? "ok"
					: event.outcome === "failure"
						? "failed"
						: "pending"
			]++;
		}
		phases.push({
			id,
			label: id === "run" ? "Run" : "Rollback",
			startedAt: starts[0] ?? null,
			endedAt: members.some((event) => event.endedAt === null)
				? null
				: (ends.at(-1) ?? null),
			calls,
		});
	}
	return {
		run: {
			id: run.id,
			status: run.status,
			startedAt: run.startedAt,
			completedAt: run.completedAt,
			executionEpoch,
		},
		coverage: covered && warnings.length === 0 ? "complete" : "partial",
		lanes: [...lanes.values()],
		events,
		phases,
		truncated: false,
		warnings,
	};
}
