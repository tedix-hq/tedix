import type { TediAppAssignmentRole } from "@tedix/api-contract/schemas/tedi-app-assignments";
import {
	type McpCapabilityProfile,
	PLATFORM_SCOPES,
	resolveTediScopes,
	TEDI_MCP_SCOPES,
} from "@tedix/mcp-shared/auth/scopes";

export { PLATFORM_SCOPES, resolveTediScopes, TEDI_MCP_SCOPES };

export type McpAppAssignmentMode = "manual" | "profile-default";

export interface McpAppAssignmentConfig {
	mode?: McpAppAssignmentMode;
	role?: TediAppAssignmentRole;
	capabilityProfiles?: McpCapabilityProfile[];
	requiredTediTags?: string[];
	excludedTediTags?: string[];
	rules?: McpAppAssignmentRule[];
}

export interface McpAppAssignmentRule {
	role?: TediAppAssignmentRole;
	capabilityProfiles?: McpCapabilityProfile[];
	requiredTediTags?: string[];
	excludedTediTags?: string[];
}

export type NormalizedMcpAppAssignmentRule = Required<McpAppAssignmentRule>;

export interface NormalizedMcpAppAssignmentConfig extends Required<
	Omit<McpAppAssignmentConfig, "rules">
> {
	rules: NormalizedMcpAppAssignmentRule[];
}

interface AppAssignmentMetadataLike {
	mcpConfig?: {
		assignmentConfig?: unknown;
	} | null;
}

export interface ManagedAssignmentApp {
	id: string;
	name: string;
	slug: string;
	metadata?: AppAssignmentMetadataLike | null;
}

export interface ManagedAssignmentTedi {
	id: string;
	slug?: string | null;
	mcpCapabilityProfile?: string | null;
	tags?: string[] | null;
}

export interface ManagedAssignmentDecision {
	appId: string;
	appSlug: string;
	appName: string;
	role: TediAppAssignmentRole;
	config: NormalizedMcpAppAssignmentConfig;
	rule: NormalizedMcpAppAssignmentRule;
}

const DEFAULT_ASSIGNMENT_CONFIG: NormalizedMcpAppAssignmentConfig = {
	mode: "manual",
	role: "operator",
	capabilityProfiles: [],
	requiredTediTags: [],
	excludedTediTags: [],
	rules: [],
};

const DEFAULT_ASSIGNMENT_RULE: NormalizedMcpAppAssignmentRule = {
	role: "operator",
	capabilityProfiles: [],
	requiredTediTags: [],
	excludedTediTags: [],
};

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter(
			(entry): entry is string =>
				typeof entry === "string" && entry.trim().length > 0,
		)
		.map((entry) => entry.trim());
}

export function getMcpAppAssignmentConfig(
	mcpConfig: { assignmentConfig?: unknown } | null | undefined,
): NormalizedMcpAppAssignmentConfig {
	const raw = mcpConfig?.assignmentConfig;
	if (!raw || typeof raw !== "object") {
		return { ...DEFAULT_ASSIGNMENT_CONFIG };
	}

	const config = raw as Record<string, unknown>;
	const mode = config.mode === "profile-default" ? "profile-default" : "manual";
	const role = config.role === "observer" ? "observer" : "operator";
	const rules: NormalizedMcpAppAssignmentRule[] = Array.isArray(config.rules)
		? config.rules
				.filter(
					(rule): rule is Record<string, unknown> =>
						!!rule && typeof rule === "object" && !Array.isArray(rule),
				)
				.map((rule) => ({
					role: rule.role === "observer" ? "observer" : role,
					capabilityProfiles: normalizeStringArray(
						rule.capabilityProfiles,
					) as McpCapabilityProfile[],
					requiredTediTags: normalizeStringArray(rule.requiredTediTags),
					excludedTediTags: normalizeStringArray(rule.excludedTediTags),
				}))
		: [];

	return {
		mode,
		role,
		capabilityProfiles: normalizeStringArray(
			config.capabilityProfiles,
		) as McpCapabilityProfile[],
		requiredTediTags: normalizeStringArray(config.requiredTediTags),
		excludedTediTags: normalizeStringArray(config.excludedTediTags),
		rules,
	};
}

function matchesManagedAssignmentRule(
	rule: NormalizedMcpAppAssignmentRule,
	tedi: ManagedAssignmentTedi,
): boolean {
	const profile = (tedi.mcpCapabilityProfile ??
		"standard") as McpCapabilityProfile;
	if (
		rule.capabilityProfiles.length > 0 &&
		!rule.capabilityProfiles.includes(profile)
	) {
		return false;
	}

	const tediTags = new Set(normalizeStringArray(tedi.tags));
	if (rule.requiredTediTags.some((tag) => !tediTags.has(tag))) {
		return false;
	}
	if (rule.excludedTediTags.some((tag) => tediTags.has(tag))) {
		return false;
	}

	return true;
}

export function getMatchingManagedAssignmentRule(
	config: NormalizedMcpAppAssignmentConfig,
	tedi: ManagedAssignmentTedi,
): NormalizedMcpAppAssignmentRule | null {
	if (config.mode !== "profile-default") return null;

	const rules =
		config.rules.length > 0
			? config.rules
			: [
					{
						...DEFAULT_ASSIGNMENT_RULE,
						role: config.role,
						capabilityProfiles: config.capabilityProfiles,
						requiredTediTags: config.requiredTediTags,
						excludedTediTags: config.excludedTediTags,
					},
				];

	return rules.find((rule) => matchesManagedAssignmentRule(rule, tedi)) ?? null;
}

export function matchesManagedAssignmentConfig(
	config: NormalizedMcpAppAssignmentConfig,
	tedi: ManagedAssignmentTedi,
): boolean {
	return getMatchingManagedAssignmentRule(config, tedi) !== null;
}

export function resolveManagedAssignmentForApp(
	app: ManagedAssignmentApp,
	tedi: ManagedAssignmentTedi,
): ManagedAssignmentDecision | null {
	const config = getMcpAppAssignmentConfig(app.metadata?.mcpConfig);
	const rule = getMatchingManagedAssignmentRule(config, tedi);
	if (!rule) {
		return null;
	}

	return {
		appId: app.id,
		appSlug: app.slug,
		appName: app.name,
		role: rule.role,
		config,
		rule,
	};
}

export function computeManagedAssignmentsForTedi(
	apps: ManagedAssignmentApp[],
	tedi: ManagedAssignmentTedi,
): ManagedAssignmentDecision[] {
	return apps
		.map((app) => resolveManagedAssignmentForApp(app, tedi))
		.filter(
			(decision): decision is ManagedAssignmentDecision => decision !== null,
		)
		.sort((left, right) => left.appName.localeCompare(right.appName));
}
