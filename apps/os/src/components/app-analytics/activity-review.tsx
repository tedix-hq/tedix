import type { HumanActivityReviewSchema } from "@tedix/api-contract/contracts/analytics";
import type {
	ActivityReviewGroup,
	PrincipalDescriptor,
} from "@tedix/api-contract/schemas/analytics";
import { Lightbulb } from "@phosphor-icons/react";
import type { z } from "zod";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Meter } from "@/components/kumo/meter";
import { Collection } from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import {
	coverageLabel,
	coverageTitle,
	formatActivityTime,
	UUID_LIKE,
} from "./format";

type HumanActivityReview = z.infer<typeof HumanActivityReviewSchema>;

// =============================================================================
// Recent Activity (audit-backed "who") + per-trace cross-lane drilldown
// =============================================================================

function principalTitle(principal: PrincipalDescriptor | null): string {
	if (!principal) return "Unknown";
	const secondary = principal.secondary ? ` · ${principal.secondary}` : "";
	return `${principal.type}:${principal.id}${secondary}`;
}

export function PrincipalName({
	principal,
	muted = false,
}: {
	principal: PrincipalDescriptor | null;
	muted?: boolean;
}) {
	if (!principal) {
		return (
			<Text as="span" role="label" tone="secondary">
				Unknown
			</Text>
		);
	}
	return (
		<Text
			as="span"
			role="label"
			tone={muted ? "secondary" : "default"}
			title={principalTitle(principal)}
		>
			{principal.label}
		</Text>
	);
}

function formatPercent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

function formatDurationOrNa(value: number | null): string {
	if (value == null) return "n/a";
	if (value < 1000) return `${Math.round(value)}ms`;
	const minutes = Math.floor(value / 60000);
	const seconds = Math.round((value % 60000) / 1000);
	if (minutes === 0) return `${seconds}s`;
	return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function HumanActivityReviewSection({
	review,
}: {
	review: HumanActivityReview;
}) {
	const warningText = review.coverage.warnings.length
		? `${review.coverage.warnings.length} coverage flag(s)`
		: "fully hydrated";
	const traceCoverage = review.coverage.traceEvidence;
	const traceFreshness = review.coverage.traceFreshness;
	const securityPosture = review.coverage.securityPosture;
	const traceCoverageTitle = [
		`${traceCoverage.proofLinkedGroups}/${review.coverage.totalGroups} episodes have at least MCP-level trace proof`,
		`${traceCoverage.auditOnlyGroups} audit-only`,
		`${traceCoverage.missingTraceGroups} missing trace`,
		traceCoverage.warnings.length
			? `warnings: ${traceCoverage.warnings.join(", ")}`
			: null,
	]
		.filter(Boolean)
		.join(" · ");
	const traceFreshnessTitle = [
		`${traceFreshness.freshGroups}/${traceFreshness.proofGroups} proof-linked episodes arrived within ${formatDurationOrNa(traceFreshness.targetMaxLagMs)}`,
		traceFreshness.staleGroups ? `${traceFreshness.staleGroups} stale` : null,
		traceFreshness.missingProofTimestampGroups
			? `${traceFreshness.missingProofTimestampGroups} missing proof timestamp`
			: null,
		traceFreshness.maxLagMs != null
			? `max lag ${formatDurationOrNa(traceFreshness.maxLagMs)}`
			: null,
		traceFreshness.warnings.length
			? `warnings: ${traceFreshness.warnings.join(", ")}`
			: null,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex flex-wrap items-center gap-2">
					Activity Review
					<Badge variant="outline" className="ml-1 font-normal">
						{review.groups.length} episodes
					</Badge>
					<Badge variant="secondary" className="font-normal">
						{warningText}
					</Badge>
					<Badge
						variant={
							securityPosture.deniedEvents > 0 ? "destructive" : "outline"
						}
						className="font-normal"
						title={
							securityPosture.denialReasons.length > 0
								? `Denied: ${securityPosture.denialReasons.join(", ")}`
								: "No pre-dispatch MCP denials in this window"
						}
					>
						{securityPosture.deniedEvents} denied
					</Badge>
					<Badge
						variant={traceEvidenceCoverageVariant(traceCoverage.status)}
						className="font-normal"
						title={traceCoverageTitle}
					>
						trace proof {formatPercent(traceCoverage.proofCoverageRate)}
					</Badge>
					<Badge
						variant={traceFreshnessCoverageVariant(traceFreshness.status)}
						className="font-normal"
						title={traceFreshnessTitle}
					>
						fresh proof {formatPercent(traceFreshness.freshnessRate)}
					</Badge>
				</CardTitle>
			</CardHeader>
			<CardContent className="px-0">
				<div className="space-y-3 border-kumo-line border-t px-4 py-3">
					<div>
						<div className="mb-2 flex items-center justify-between gap-3 text-xs">
							<Text as="span" role="label" tone="secondary">
								Trace proof target{" "}
								{formatPercent(traceCoverage.targetCoverageRate)}
							</Text>
							<Text
								as="span"
								role="label"
								tone="secondary"
								className="tabular-nums"
								title={traceCoverageTitle}
							>
								{traceEvidenceCoverageLabel(traceCoverage)}
							</Text>
						</div>
						<Meter
							label="Trace proof coverage"
							hideLabel
							value={Math.round(traceCoverage.proofCoverageRate * 100)}
							className="h-2"
						/>
					</div>
					<div>
						<div className="mb-2 flex items-center justify-between gap-3 text-xs">
							<Text as="span" role="label" tone="secondary">
								Trace proof freshness target {"<= "}
								{formatDurationOrNa(traceFreshness.targetMaxLagMs)}
							</Text>
							<Text
								as="span"
								role="label"
								tone="secondary"
								className="tabular-nums"
								title={traceFreshnessTitle}
							>
								{traceFreshnessCoverageLabel(traceFreshness)}
							</Text>
						</div>
						<Meter
							label="Trace proof freshness"
							hideLabel
							value={Math.round(traceFreshness.freshnessRate * 100)}
							className="h-2"
						/>
					</div>
				</div>
				<Collection appearance="inline" aria-label="Activity review episodes">
					{review.groups.slice(0, 8).map((group) => (
						<ActivityReviewRow key={group.id} group={group} />
					))}
				</Collection>
			</CardContent>
		</Card>
	);
}

function traceEvidenceCoverageVariant(
	status: HumanActivityReview["coverage"]["traceEvidence"]["status"],
): BadgeVariant {
	switch (status) {
		case "met":
			return "default";
		case "warning":
			return "secondary";
		case "breach":
			return "destructive";
		case "no_data":
			return "outline";
	}
}

function traceFreshnessCoverageVariant(
	status: HumanActivityReview["coverage"]["traceFreshness"]["status"],
): BadgeVariant {
	switch (status) {
		case "met":
			return "default";
		case "warning":
			return "secondary";
		case "breach":
			return "destructive";
		case "no_data":
			return "outline";
	}
}

function traceEvidenceCoverageLabel(
	coverage: HumanActivityReview["coverage"]["traceEvidence"],
) {
	if (coverage.status === "no_data") return "no activity in window";
	return `${coverage.proofLinkedGroups}/${coverage.proofLinkedGroups + coverage.auditOnlyGroups + coverage.missingTraceGroups} episodes linked`;
}

function traceFreshnessCoverageLabel(
	coverage: HumanActivityReview["coverage"]["traceFreshness"],
) {
	if (coverage.status === "no_data") return "no proof-linked episodes";
	return `${coverage.freshGroups}/${coverage.proofGroups} fresh`;
}

function ActivityReviewRow({ group }: { group: ActivityReviewGroup }) {
	const warning = coverageLabel(group.identityCoverage);
	const traceProof = traceEvidenceLabel(group.traceEvidence.status);
	const cognition = group.traceEvidence.cognition;
	const showCognition = cognition.summary !== "No cognitive evidence linked.";
	const denied = group.securityPosture.deniedEvents > 0;
	return (
		<li className="space-y-2 px-4 py-3 text-xs">
			<div className="flex flex-wrap items-center gap-2">
				<Text as="span" role="label" weight="medium">
					{group.title}
				</Text>
				<Badge
					variant={denied || group.errorEvents > 0 ? "destructive" : "default"}
				>
					{denied
						? `${group.securityPosture.deniedEvents} denied`
						: group.errorEvents > 0
							? `${group.errorEvents} error`
							: "OK"}
				</Badge>
				{group.securityPosture.denialReasons.map((reason) => (
					<Badge
						key={reason}
						variant="outline"
						className="font-normal"
						title={[
							...group.securityPosture.mcpMethods,
							...group.securityPosture.riskTiers,
						].join(" · ")}
					>
						{reason.replaceAll("_", " ")}
					</Badge>
				))}
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="ml-auto tabular-nums"
				>
					{formatActivityTime(group.endedAt)}
				</Text>
			</div>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-kumo-subtle">
				<PrincipalName principal={group.subject ?? group.actor} muted />
				{group.agent && (
					<>
						<span>-&gt;</span>
						<PrincipalName principal={group.agent} muted />
					</>
				)}
				<span>·</span>
				<span>{group.totalEvents} audit events</span>
				<span>·</span>
				<span>
					{group.evidence.payloadsConfigured
						? "payload lane on"
						: "payload lane off"}
				</span>
				<span>·</span>
				<span
					title={[
						...group.traceEvidence.warnings,
						...(group.traceEvidence.cloudflare.sampled
							? [
									`Cloudflare trace ${group.traceEvidence.cloudflare.traceId}; ${group.traceEvidence.cloudflare.serviceNames.join(", ")}`,
								]
							: []),
					].join(", ")}
				>
					{traceProof}
					{group.traceEvidence.mcpEvents > 0
						? ` · ${group.traceEvidence.mcpEvents} mcp`
						: ""}
					{group.traceEvidence.cognitiveEvents > 0
						? ` · ${group.traceEvidence.cognitiveEvents} cognitive`
						: ""}
					{group.traceEvidence.cloudflare.sampled
						? ` · ${group.traceEvidence.cloudflare.spanCount} CF spans`
						: ""}
				</span>
				{warning && (
					<>
						<span>·</span>
						<span title={coverageTitle(group.identityCoverage)}>{warning}</span>
					</>
				)}
			</div>
			{showCognition && (
				<div
					className="flex flex-wrap items-center gap-x-2 gap-y-1 text-kumo-subtle"
					title={cognitionEvidenceTitle(cognition)}
				>
					<Lightbulb size={14} aria-hidden className="text-kumo-link" />
					<span>{cognition.summary}</span>
				</div>
			)}
			{group.topTools.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{group.topTools.map((tool) => (
						<Badge
							key={tool.tool.toolName}
							variant="outline"
							className="font-normal"
							title={tool.tool.toolName}
						>
							{tool.tool.label} x{tool.count}
						</Badge>
					))}
				</div>
			)}
		</li>
	);
}

function cognitionEvidenceTitle(
	cognition: ActivityReviewGroup["traceEvidence"]["cognition"],
) {
	const parts = [
		formatEvidenceIdSummary("Retrieved facts", cognition.retrievedFactIds),
		formatEvidenceIdSummary("Cited facts", cognition.citedFactIds),
		formatEvidenceIdSummary("Ignored facts", cognition.ignoredFactIds),
		formatEvidenceIdSummary("Decisions", cognition.decisionIds),
		latestDecisionTitle(cognition.latestDecision),
		retrievalEvidenceTitle(cognition.retrieval),
		graphEvidenceTitle(cognition.graph),
		cognition.warnings.length
			? `Warnings: ${cognition.warnings.join(", ")}`
			: null,
	];
	return parts.filter(Boolean).join("\n");
}

function formatEvidenceIdSummary(label: string, ids: string[]): string {
	if (ids.length === 0) return `${label}: none`;
	const preview = ids.slice(0, 4).map(shortEvidenceId).join(", ");
	const more = ids.length > 4 ? `, +${ids.length - 4} more` : "";
	return `${label}: ${ids.length} (${preview}${more})`;
}

function shortEvidenceId(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "blank";
	if (trimmed.length <= 18 && !UUID_LIKE.test(trimmed)) return trimmed;
	return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

function latestDecisionTitle(
	decision: ActivityReviewGroup["traceEvidence"]["cognition"]["latestDecision"],
): string {
	if (!decision) return "Latest decision: none";
	const confidence =
		decision.confidence == null
			? null
			: `confidence ${formatPercent(decision.confidence)}`;
	const status = decision.outcomeStatus ?? "pending";
	return [
		`Latest decision: ${shortEvidenceId(decision.id)}`,
		decision.category,
		status,
		confidence,
		decision.source,
	]
		.filter(Boolean)
		.join(" · ");
}

function retrievalEvidenceTitle(
	retrieval: ActivityReviewGroup["traceEvidence"]["cognition"]["retrieval"],
): string {
	const parts = [
		retrieval.topK == null ? null : `topK ${retrieval.topK}`,
		retrieval.returnedCount == null
			? null
			: `${retrieval.returnedCount} returned`,
		retrieval.vectorEnabled == null
			? null
			: retrieval.vectorEnabled
				? "vector on"
				: "vector off",
		retrieval.vectorMs == null
			? null
			: `vector ${formatDurationOrNa(retrieval.vectorMs)}`,
		retrieval.hydrateFactsMs == null
			? null
			: `hydrate ${formatDurationOrNa(retrieval.hydrateFactsMs)}`,
	].filter(Boolean);
	return parts.length ? `Retrieval: ${parts.join(" · ")}` : "Retrieval: none";
}

function graphEvidenceTitle(
	graph: ActivityReviewGroup["traceEvidence"]["cognition"]["graph"],
): string {
	const projected = formatEvidenceIdSummary(
		"projected decisions",
		graph.projectedDecisionIds,
	);
	return `Graph: ${graph.status}; ${projected}`;
}

function traceEvidenceLabel(
	status: ActivityReviewGroup["traceEvidence"]["status"],
) {
	switch (status) {
		case "retrieval_decision_linked":
			return "retrieval+decision proof";
		case "cognitive_linked":
			return "cognitive proof";
		case "runtime_linked":
			return "runtime proof";
		case "mcp_linked":
			return "mcp proof";
		case "audit_only":
			return "audit only";
		case "missing_trace":
			return "trace missing";
	}
}
