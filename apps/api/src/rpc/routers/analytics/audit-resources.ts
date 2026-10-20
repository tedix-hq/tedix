import type {
	AppDescriptor,
	PrincipalDescriptor,
	ToolDescriptor,
} from "@tedix/api-contract/schemas/analytics";
import {
	humanizeIdentifier,
	unresolvedTool,
} from "../../../lib/audit-activity";

type AuditToolParts = {
	localToolName: string;
	namespace: string | null;
};

export function keyForTool(
	appId: string | null | undefined,
	toolName: string,
): string {
	return `${appId ?? ""}:${toolName}`;
}

function uniqueValues(values: string[]): string[] {
	return Array.from(new Set(values.filter(Boolean)));
}

function parseAuditToolName(toolName: string): AuditToolParts {
	if (toolName.startsWith("tedi:")) {
		const [, namespace, ...rest] = toolName.split(":");
		const localToolName = rest.join(":");
		if (namespace && localToolName) {
			return { localToolName, namespace };
		}
	}
	const separatorIndex = toolName.indexOf("__");
	if (separatorIndex < 0) return { localToolName: toolName, namespace: null };
	return {
		localToolName: toolName.slice(separatorIndex + 2),
		namespace: toolName.slice(0, separatorIndex),
	};
}

const AGGREGATE_TEDI_COMPUTER_TOOL_LABELS: Record<string, string> = {
	open_computer: "Open Computer",
	close_computer: "Close Computer",
	exec: "Computer Command",
	read_execution: "Read Execution",
	cancel_execution: "Cancel Execution",
	read: "Read File",
	write: "Write File",
	edit: "Edit File",
	delete: "Delete File",
	ls: "List Files",
	find: "Find Files",
	grep: "Search Files",
};

const AGGREGATE_TEDI_COMPUTER_TOOL_NAMES = new Set(
	Object.keys(AGGREGATE_TEDI_COMPUTER_TOOL_LABELS),
);

export function toolIdCandidatesForAuditResource(toolName: string): string[] {
	const { localToolName } = parseAuditToolName(toolName);
	return uniqueValues([
		toolName,
		localToolName,
		localToolName.replaceAll("-", "_"),
		localToolName.replaceAll("_", "-"),
	]);
}

export function namespaceSlugCandidatesForAuditResource(
	toolName: string,
): string[] {
	const { namespace } = parseAuditToolName(toolName);
	if (!namespace) return [];
	return uniqueValues([namespace, namespace.replaceAll("_", "-")]);
}

export function virtualResolvedTool(
	toolName: string,
	app: AppDescriptor | null,
): ToolDescriptor | null {
	if (
		toolName !== "code" &&
		toolName !== "execute_muscle_code" &&
		toolName !== "get_info"
	) {
		return null;
	}
	const fallback = unresolvedTool(toolName, app);
	if (!fallback) return null;
	return {
		...fallback,
		title: fallback.label,
		unresolved: false,
	};
}

export function normalizedNamespaceToken(
	value: string | null | undefined,
): string | null {
	return value?.replaceAll("-", "_").toLowerCase() ?? null;
}

export function tediScopedVirtualTool(
	toolName: string,
	app: AppDescriptor | null,
	principals: Array<PrincipalDescriptor | null>,
	namespaceTedis: Map<string, PrincipalDescriptor> = new Map(),
): ToolDescriptor | null {
	const { localToolName, namespace } = parseAuditToolName(toolName);
	const normalizedNamespace = normalizedNamespaceToken(namespace);
	if (!normalizedNamespace) return null;
	const principalOwner = principals.find(
		(principal) =>
			principal?.type === "tedi" &&
			!principal.unresolved &&
			normalizedNamespaceToken(principal.slug) === normalizedNamespace,
	);
	if (
		!principalOwner &&
		!AGGREGATE_TEDI_COMPUTER_TOOL_NAMES.has(localToolName)
	) {
		return null;
	}
	const owner = principalOwner ?? namespaceTedis.get(normalizedNamespace);
	if (!owner) return null;
	const label = AGGREGATE_TEDI_COMPUTER_TOOL_NAMES.has(localToolName)
		? `${owner.label} / ${
				AGGREGATE_TEDI_COMPUTER_TOOL_LABELS[localToolName] ??
				humanizeIdentifier(localToolName)
			}`
		: humanizeIdentifier(localToolName);
	return {
		id: toolName,
		label,
		toolName,
		title: label,
		appId: app?.id ?? null,
		appLabel: owner.label,
		appSlug: owner.slug,
		unresolved: false,
	};
}

export function principalKey(
	type: string | null | undefined,
	id: string | null | undefined,
): string {
	return `${normalizePrincipalType(type)}:${id ?? ""}`;
}

export function normalizePrincipalType(type: string | null | undefined) {
	if (type === "api_key") return "apiKey";
	if (
		type === "user" ||
		type === "tedi" ||
		type === "kernel" ||
		type === "m2m" ||
		type === "service" ||
		type === "apiKey" ||
		type === "external_agent" ||
		type === "anonymous"
	) {
		return type;
	}
	return "unknown";
}

const OPAQUE_PRINCIPAL_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function shortEvidenceId(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= 18) return trimmed;
	return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

function readableMachineId(id: string): string | null {
	const trimmed = id.trim();
	if (!trimmed || trimmed === "unknown") return null;
	if (OPAQUE_PRINCIPAL_ID.test(trimmed) || trimmed.length > 32) return null;
	return humanizeIdentifier(trimmed)
		.replace(/\bApi\b/g, "API")
		.replace(/\bJwt\b/g, "JWT")
		.replace(/\bMcp\b/g, "MCP")
		.replace(/\bOauth\b/g, "OAuth");
}

export function machinePrincipalDescriptor(
	id: string,
	type: Extract<
		PrincipalDescriptor["type"],
		"service" | "m2m" | "apiKey" | "anonymous"
	>,
): PrincipalDescriptor {
	const typeLabel: Record<"anonymous" | "apiKey" | "m2m" | "service", string> =
		{
			anonymous: "Anonymous caller",
			apiKey: "API key",
			m2m: "M2M client",
			service: "Service",
		};
	const readable =
		type === "service" || type === "m2m" ? readableMachineId(id) : null;
	return {
		id,
		type,
		label: readable ?? typeLabel[type],
		secondary:
			type === "anonymous"
				? null
				: `${typeLabel[type]} · ${shortEvidenceId(id)}`,
		slug: null,
		avatarUrl: null,
		unresolved: false,
	};
}

export function uniqueStrings(
	values: Array<string | null | undefined>,
): string[] {
	return Array.from(new Set(values.filter((v): v is string => !!v)));
}
