import type {
	ActivityItem,
	ActivityReviewGroup,
	AppDescriptor,
	HumanActivityReview,
	TraceEvidenceSummary,
} from "@tedix/api-contract/schemas/analytics";
import {
	mergeCoverage,
	buildToolSummaries,
	buildSecurityPosture,
} from "./activity-hydration";
import {
	traceEvidenceFallback,
	markMcpTraceEvidence,
	buildTraceEvidenceCoverage,
	buildTraceFreshnessCoverage,
} from "./trace-evidence";

function reviewGroupKey(item: ActivityItem): string {
	if (item.traceId) return `trace:${item.traceId}`;
	if (item.executionId) return `execution:${item.executionId}`;
	const ts = Date.parse(item.timestamp);
	const bucket = Number.isFinite(ts) ? Math.floor(ts / 300_000) : 0;
	return `actor:${item.actorId}:${bucket}`;
}

export function buildHumanActivityReview(input: {
	items: ActivityItem[];
	windowStart: string;
	windowEnd: string;
	payloadsConfigured: boolean;
	traceEvidenceByTraceId?: Map<string, TraceEvidenceSummary>;
}): HumanActivityReview {
	const groupsMap = new Map<string, ActivityItem[]>();
	for (const item of input.items) {
		const key = reviewGroupKey(item);
		groupsMap.set(key, [...(groupsMap.get(key) ?? []), item]);
	}
	const groups: ActivityReviewGroup[] = Array.from(groupsMap.entries()).map(
		([id, groupItems]) => {
			const ordered = [...groupItems].sort((a, b) =>
				a.timestamp.localeCompare(b.timestamp),
			);
			const first = ordered[0]!;
			const apps = Array.from(
				new Map(
					ordered
						.map((item) => item.app)
						.filter((app): app is AppDescriptor => !!app)
						.map((app) => [app.id, app]),
				).values(),
			);
			const topTools = buildToolSummaries(ordered);
			const errorEvents = ordered.filter((item) => !item.success).length;
			const coverage = mergeCoverage(ordered);
			const appText =
				apps.length > 0 ? ` on ${apps.map((app) => app.label).join(", ")}` : "";
			const toolText =
				topTools.length > 0
					? topTools
							.slice(0, 3)
							.map((tool) => tool.tool.label)
							.join(", ")
					: "MCP activity";
			const runtimeTraceEvidence =
				(first.traceId
					? input.traceEvidenceByTraceId?.get(first.traceId)
					: undefined) ?? traceEvidenceFallback(first.traceId);
			const traceEvidence = markMcpTraceEvidence(
				runtimeTraceEvidence,
				ordered.filter((item) => item.action.startsWith("mcp.")).length,
			);
			const securityPosture = buildSecurityPosture(ordered);
			const titleVerb =
				securityPosture.disposition === "denied" ? "was denied" : "used";
			const title = `${first.attribution.actor.label} ${titleVerb} ${toolText}${appText}`;
			const summary = `${ordered.length} audit event(s), ${securityPosture.deniedEvents} denied, ${errorEvents} error(s). ${first.attribution.summary}.`;

			return {
				id,
				title,
				summary,
				startedAt: ordered[0]!.timestamp,
				endedAt: ordered[ordered.length - 1]!.timestamp,
				totalEvents: ordered.length,
				successfulEvents: ordered.length - errorEvents,
				errorEvents,
				traceId: first.traceId,
				executionId: first.executionId,
				actor: first.actor,
				subject: first.subject,
				agent: first.agent,
				attribution: first.attribution,
				apps,
				topTools,
				identityCoverage: coverage,
				traceEvidence,
				securityPosture,
				evidence: {
					auditEventCount: ordered.length,
					payloadsConfigured: input.payloadsConfigured,
					source: "audit_events",
				},
			};
		},
	);
	groups.sort((a, b) => b.endedAt.localeCompare(a.endedAt));
	const warnings = Array.from(
		new Set(groups.flatMap((group) => group.identityCoverage.warnings)),
	);
	const traceEvidence = buildTraceEvidenceCoverage(groups);
	const traceFreshness = buildTraceFreshnessCoverage(groups);
	const securityPosture = {
		executedGroups: groups.filter(
			(group) => group.securityPosture.disposition === "executed",
		).length,
		deniedGroups: groups.filter(
			(group) => group.securityPosture.disposition === "denied",
		).length,
		mixedGroups: groups.filter(
			(group) => group.securityPosture.disposition === "mixed",
		).length,
		executedEvents: groups.reduce(
			(total, group) => total + group.securityPosture.executedEvents,
			0,
		),
		deniedEvents: groups.reduce(
			(total, group) => total + group.securityPosture.deniedEvents,
			0,
		),
		unknownRiskEvents: groups.reduce(
			(total, group) => total + group.securityPosture.unknownRiskEvents,
			0,
		),
		denialReasons: [
			...new Set(
				groups.flatMap((group) => group.securityPosture.denialReasons),
			),
		].sort(),
	};
	return {
		windowStart: input.windowStart,
		windowEnd: input.windowEnd,
		totalEvents: input.items.length,
		groups,
		coverage: {
			totalGroups: groups.length,
			unresolvedActorGroups: groups.filter(
				(group) => !group.identityCoverage.actorResolved,
			).length,
			missingSubjectGroups: groups.filter(
				(group) => !group.identityCoverage.subjectPresent,
			).length,
			unresolvedToolGroups: groups.filter(
				(group) => !group.identityCoverage.toolResolved,
			).length,
			securityPosture,
			traceEvidence,
			traceFreshness,
			warnings,
		},
	};
}
