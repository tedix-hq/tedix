/**
 * Audit-backed activity feed — the "who used which tool recently" + "everything
 * in one trace" read paths.
 *
 * Both read from D1 `audit_events` (authoritative, unsampled, carries the actor),
 * NOT Analytics Engine. This is the lane an operator should use to answer
 * "is <person> using <tool>?" — answering it against the sampled/shallow lanes
 * can misattribute usage.
 *
 * @module audit-activity
 */

import type {
	ActivityItem,
	AppDescriptor,
	DelegationChain,
	IdentityCoverage,
	PrincipalDescriptor,
	ToolDescriptor,
} from "@tedix/api-contract/schemas/analytics";

/** Raw audit_events row shape projected by the activity SQL. */
export interface AuditActivityRow {
	action: string;
	actorId: string | null;
	actorType: string | null;
	resourceId: string | null;
	timestamp: Date | number | string;
	appId: string | null;
	durationMs: number | string | null;
	errorCode: string | null;
	executionId: string | null;
	traceId: string | null;
	clientId: string | null;
	subjectUserId?: string | null;
	agentTediId?: string | null;
	oauthClientId?: string | null;
	delegationMode?: string | null;
	denialReason?: string | null;
	httpStatus?: number | string | null;
	mcpMethod?: string | null;
	riskTier?: string | null;
}

/** Audit timestamps are stored as unix SECONDS (Drizzle `timestamp` mode). */
function auditTimestampToIso(value: Date | number | string): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "number") return new Date(value * 1000).toISOString();
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return new Date(numeric * 1000).toISOString();
	return new Date(value).toISOString();
}

function nullableNumber(value: unknown): number | null {
	if (value == null) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

export function unresolvedPrincipal(
	id: string | null | undefined,
	type: string | null | undefined,
): PrincipalDescriptor {
	const safeId = id || "unknown";
	const normalizedType = type === "api_key" ? "apiKey" : type;
	const safeType = (
		[
			"user",
			"tedi",
			"kernel",
			"m2m",
			"service",
			"apiKey",
			"external_agent",
			"anonymous",
		].includes(normalizedType ?? "")
			? normalizedType
			: "unknown"
	) as PrincipalDescriptor["type"];
	return {
		id: safeId,
		type: safeType,
		label: safeId === "unknown" ? "Unknown actor" : safeId,
		secondary: safeType,
		slug: null,
		avatarUrl: null,
		unresolved: safeId !== "anonymous",
	};
}

export function unresolvedApp(
	id: string | null | undefined,
): AppDescriptor | null {
	if (!id) return null;
	return { id, label: id, slug: null, unresolved: true };
}

export function humanizeIdentifier(value: string): string {
	const localName = value.includes("__") ? value.split("__").pop()! : value;
	return localName
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function unresolvedTool(
	toolName: string | null | undefined,
	app: AppDescriptor | null,
): ToolDescriptor | null {
	if (!toolName) return null;
	return {
		id: toolName,
		label: humanizeIdentifier(toolName),
		toolName,
		title: null,
		appId: app?.id ?? null,
		appLabel: app?.label ?? null,
		appSlug: app?.slug ?? null,
		unresolved: true,
	};
}

type IdentityCoverageWarningDetail = IdentityCoverage["warningDetails"][number];

const IDENTITY_COVERAGE_WARNING_DETAILS: Record<
	string,
	Omit<IdentityCoverageWarningDetail, "code">
> = {
	actor_unresolved: {
		label: "Actor unresolved",
		severity: "warning",
		message:
			"The audit row has an actor id/type, but Activity Review could not hydrate it to a known user, tedi, service, or API key.",
		recommendedAction:
			"Check actorId/actorType in audit metadata and the organization member or tedi identity rows.",
	},
	subject_missing: {
		label: "No human subject",
		severity: "info",
		message:
			"The episode was emitted without subjectUserId, so there is no separate human principal to show.",
		recommendedAction:
			"Expected for service-only jobs; add subjectUserId when a human delegates the action.",
	},
	subject_unresolved: {
		label: "Subject unresolved",
		severity: "warning",
		message:
			"The audit row names a human subject, but that id did not hydrate to a known organization member or user.",
		recommendedAction:
			"Check subjectUserId and organization membership synchronization.",
	},
	agent_unresolved: {
		label: "Agent unresolved",
		severity: "warning",
		message:
			"The audit row names an agent tedi, but that id did not hydrate to a current tedi record.",
		recommendedAction: "Check agentTediId and the tedi identity mapping.",
	},
	app_unresolved: {
		label: "App unresolved",
		severity: "warning",
		message:
			"The audit row has an appId, but Activity Review could not hydrate the app descriptor.",
		recommendedAction: "Check the appId in audit metadata and the apps table.",
	},
	tool_unresolved: {
		label: "Tool unresolved",
		severity: "warning",
		message:
			"The audit row has a tool/resource id, but Activity Review could not hydrate the tool descriptor.",
		recommendedAction:
			"Check app_tools metadata, aggregate namespace mapping, and the emitted resourceId.",
	},
};

function identityCoverageWarningDetail(
	code: string,
): IdentityCoverageWarningDetail {
	const detail = IDENTITY_COVERAGE_WARNING_DETAILS[code];
	if (!detail) {
		return {
			code,
			label: humanizeIdentifier(code),
			severity: "warning",
			message: "Activity Review emitted an attribution warning.",
			recommendedAction: null,
		};
	}
	return { code, ...detail };
}

export function buildIdentityCoverage(input: {
	actor: PrincipalDescriptor;
	subject: PrincipalDescriptor | null;
	agent: PrincipalDescriptor | null;
	app: AppDescriptor | null;
	tool: ToolDescriptor | null;
	clientId: string | null | undefined;
	subjectPresent?: boolean;
	agentPresent?: boolean;
}): IdentityCoverage {
	const subjectPresent = input.subjectPresent ?? !!input.subject;
	const agentPresent = input.agentPresent ?? !!input.agent;
	const warnings: string[] = [];
	if (input.actor.unresolved) warnings.push("actor_unresolved");
	if (subjectPresent && (!input.subject || input.subject.unresolved)) {
		warnings.push("subject_unresolved");
	}
	if (agentPresent && (!input.agent || input.agent.unresolved)) {
		warnings.push("agent_unresolved");
	}
	if (input.app?.unresolved) warnings.push("app_unresolved");
	if (input.tool?.unresolved) warnings.push("tool_unresolved");
	if (!subjectPresent) warnings.push("subject_missing");
	const warningDetails = warnings.map(identityCoverageWarningDetail);
	return {
		actorResolved: !input.actor.unresolved,
		subjectPresent,
		subjectResolved: !!input.subject && !input.subject.unresolved,
		agentPresent,
		agentResolved: !!input.agent && !input.agent.unresolved,
		appResolved: input.app?.unresolved !== true,
		toolResolved: input.tool?.unresolved !== true,
		clientPresent: !!input.clientId,
		warnings,
		warningDetails,
	};
}

export function buildDelegationChain(input: {
	mode: string | null | undefined;
	actor: PrincipalDescriptor;
	subject: PrincipalDescriptor | null;
	agent: PrincipalDescriptor | null;
	clientId: string | null | undefined;
}): DelegationChain {
	const client = input.clientId
		? { id: input.clientId, label: redactClientIdForDisplay(input.clientId) }
		: null;
	const parts = [input.subject, input.agent, input.actor]
		.filter((p): p is PrincipalDescriptor => !!p)
		.map((p) => p.label);
	const uniqueParts = Array.from(new Set(parts));
	const via = client ? ` via ${client.label}` : "";
	return {
		mode: input.mode ?? null,
		actor: input.actor,
		subject: input.subject,
		agent: input.agent,
		client,
		summary: `${uniqueParts.join(" -> ")}${via}`,
	};
}

function redactClientIdForDisplay(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= 16) return trimmed;
	return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

/** Map one audit_events row into the contract `ActivityItem` shape. */
export function mapAuditActivityRow(row: AuditActivityRow): ActivityItem {
	const actor = unresolvedPrincipal(row.actorId, row.actorType);
	const subject = row.subjectUserId
		? unresolvedPrincipal(row.subjectUserId, "user")
		: null;
	const agent = row.agentTediId
		? unresolvedPrincipal(row.agentTediId, "tedi")
		: null;
	const app = unresolvedApp(row.appId);
	const tool = unresolvedTool(row.resourceId, app);
	const clientId = row.clientId ?? row.oauthClientId ?? null;
	const delegationMode = row.delegationMode ?? null;
	const attribution = buildDelegationChain({
		mode: delegationMode,
		actor,
		subject,
		agent,
		clientId,
	});
	const denied = row.action === "mcp.access.denied";
	const riskTier = [
		"read",
		"bounded_write",
		"high_impact_write",
		"external_side_effect",
	].includes(row.riskTier ?? "")
		? (row.riskTier as ActivityItem["securityDecision"]["riskTier"])
		: null;
	return {
		timestamp: auditTimestampToIso(row.timestamp),
		actorId: row.actorId ?? "",
		actorType: row.actorType ?? "",
		actor,
		subject,
		agent,
		attribution,
		identityCoverage: buildIdentityCoverage({
			actor,
			subject,
			agent,
			app,
			tool,
			clientId,
			subjectPresent: !!row.subjectUserId,
			agentPresent: !!row.agentTediId,
		}),
		action: row.action,
		// `.execute` = success, `.error` = failure (the action verb encodes it).
		success: row.action.endsWith(".execute"),
		toolName: row.resourceId ?? null,
		tool,
		appId: row.appId ?? null,
		app,
		executionId: row.executionId ?? null,
		traceId: row.traceId ?? null,
		clientId,
		delegationMode,
		durationMs: nullableNumber(row.durationMs),
		errorCode: row.errorCode ?? null,
		securityDecision: {
			disposition: denied ? "denied" : "executed",
			denialReason: denied ? (row.denialReason ?? row.errorCode ?? null) : null,
			httpStatus: nullableNumber(row.httpStatus),
			mcpMethod: row.mcpMethod ?? null,
			riskTier,
		},
	};
}

export function mapAuditActivityRows(rows: AuditActivityRow[]): ActivityItem[] {
	return rows.map(mapAuditActivityRow);
}
