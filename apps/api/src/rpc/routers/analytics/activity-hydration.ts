import type {
	ActivityItem,
	ActivityReviewGroup,
	AppDescriptor,
	IdentityCoverage,
	PrincipalDescriptor,
	ToolDescriptor,
} from "@tedix/api-contract/schemas/analytics";
import {
	listAnalyticsAppsByIds,
	listAnalyticsAppsBySlugs,
	listAnalyticsOrganizationMembers,
	listAnalyticsTedis,
	listAnalyticsTools,
	listAnalyticsUsers,
} from "@tedix/db/queries/analytics-hydration";
import { listExternalAgentPrincipalsByIds } from "@tedix/db/queries/external-agent-identity/principals";
import {
	type AuditActivityRow,
	buildDelegationChain,
	buildIdentityCoverage,
	mapAuditActivityRows,
	unresolvedApp,
	unresolvedPrincipal,
	unresolvedTool,
} from "../../../lib/audit-activity";
import { type BaseContext } from "../../orpc";
import {
	keyForTool,
	toolIdCandidatesForAuditResource,
	namespaceSlugCandidatesForAuditResource,
	virtualResolvedTool,
	normalizedNamespaceToken,
	tediScopedVirtualTool,
	principalKey,
	normalizePrincipalType,
	machinePrincipalDescriptor,
	uniqueStrings,
} from "./audit-resources";

type HydrationMaps = {
	apps: Map<string, AppDescriptor>;
	namespaceTedis: Map<string, PrincipalDescriptor>;
	tools: Map<string, ToolDescriptor>;
	principals: Map<string, PrincipalDescriptor>;
};

async function loadHydrationMaps(
	context: BaseContext,
	rows: AuditActivityRow[],
	organizationId: string | undefined,
): Promise<HydrationMaps> {
	const appIds = uniqueStrings(rows.map((r) => r.appId));
	const toolNames = uniqueStrings(rows.map((r) => r.resourceId));
	const toolIdCandidates = uniqueStrings(
		toolNames.flatMap(toolIdCandidatesForAuditResource),
	);
	const namespaceSlugCandidates = uniqueStrings(
		toolNames.flatMap(namespaceSlugCandidatesForAuditResource),
	);
	const userIds = uniqueStrings(
		rows.flatMap((r) => [
			normalizePrincipalType(r.actorType) === "user" ||
			normalizePrincipalType(r.actorType) === "kernel"
				? r.actorId
				: null,
			r.subjectUserId,
		]),
	);
	const tediIds = uniqueStrings(
		rows.flatMap((r) => [
			normalizePrincipalType(r.actorType) === "tedi" ? r.actorId : null,
			r.agentTediId,
		]),
	);
	const externalAgentIds = uniqueStrings(
		rows.map((row) =>
			normalizePrincipalType(row.actorType) === "external_agent"
				? row.actorId
				: null,
		),
	);
	const allPrincipalIds = uniqueStrings([...userIds, ...tediIds]);

	const apps = new Map<string, AppDescriptor>();
	if (appIds.length > 0) {
		const appRows = await listAnalyticsAppsByIds(context.db, appIds);
		for (const app of appRows) {
			apps.set(app.id, {
				id: app.id,
				label: app.name || app.slug || app.id,
				slug: app.slug ?? null,
				unresolved: false,
			});
		}
	}

	const namespaceApps = new Map<string, AppDescriptor>();
	const namespaceLookupAppIds = new Map<string, string[]>();
	if (namespaceSlugCandidates.length > 0) {
		const namespaceAppRows = await listAnalyticsAppsBySlugs(
			context.db,
			namespaceSlugCandidates,
		);
		const sourceAppIds = uniqueStrings(
			namespaceAppRows.map((app) => app.sourceAppId),
		);
		const sourceApps =
			sourceAppIds.length > 0
				? await listAnalyticsAppsByIds(context.db, sourceAppIds)
				: [];
		for (const app of sourceApps) {
			apps.set(app.id, {
				id: app.id,
				label: app.name || app.slug || app.id,
				slug: app.slug ?? null,
				unresolved: false,
			});
		}
		for (const app of namespaceAppRows) {
			const descriptor: AppDescriptor = {
				id: app.id,
				label: app.name || app.slug || app.id,
				slug: app.slug ?? null,
				unresolved: false,
			};
			apps.set(app.id, descriptor);
			if (app.slug) {
				namespaceApps.set(app.slug, descriptor);
				namespaceApps.set(app.slug.replaceAll("-", "_"), descriptor);
				const lookupIds = uniqueStrings([app.id, app.sourceAppId]);
				namespaceLookupAppIds.set(app.slug, lookupIds);
				namespaceLookupAppIds.set(app.slug.replaceAll("-", "_"), lookupIds);
			}
		}
	}

	const tools = new Map<string, ToolDescriptor>();
	const lookupAppIds = uniqueStrings([
		...appIds,
		...Array.from(namespaceApps.values(), (app) => app.id),
		...Array.from(namespaceLookupAppIds.values()).flat(),
	]);
	if (lookupAppIds.length > 0 && toolIdCandidates.length > 0) {
		const toolRows = await listAnalyticsTools(context.db, {
			appIds: lookupAppIds,
			toolIds: toolIdCandidates,
		});
		for (const tool of toolRows) {
			const app = apps.get(tool.appId) ?? unresolvedApp(tool.appId);
			tools.set(keyForTool(tool.appId, tool.toolId), {
				id: tool.toolId,
				label: tool.title || tool.toolId,
				toolName: tool.toolId,
				title: tool.title ?? null,
				appId: tool.appId,
				appLabel: app?.label ?? null,
				appSlug: app?.slug ?? null,
				unresolved: false,
			});
		}
	}
	for (const row of rows) {
		if (!row.resourceId) continue;
		const servedKey = keyForTool(row.appId, row.resourceId);
		if (tools.has(servedKey)) continue;
		const servedApp = row.appId
			? (apps.get(row.appId) ?? unresolvedApp(row.appId))
			: null;
		const virtual = virtualResolvedTool(row.resourceId, servedApp);
		if (virtual) {
			tools.set(servedKey, virtual);
			continue;
		}
		for (const namespaceSlug of namespaceSlugCandidatesForAuditResource(
			row.resourceId,
		)) {
			const lookupIds = namespaceLookupAppIds.get(namespaceSlug) ?? [];
			for (const lookupAppId of lookupIds) {
				for (const candidate of toolIdCandidatesForAuditResource(
					row.resourceId,
				)) {
					const sourceTool = tools.get(keyForTool(lookupAppId, candidate));
					if (!sourceTool) continue;
					tools.set(servedKey, {
						...sourceTool,
						id: row.resourceId,
						toolName: row.resourceId,
					});
					break;
				}
				if (tools.has(servedKey)) break;
			}
			if (tools.has(servedKey)) break;
		}
	}

	const principals = new Map<string, PrincipalDescriptor>();
	const namespaceTedis = new Map<string, PrincipalDescriptor>();
	if (externalAgentIds.length > 0) {
		const externalAgents = await listExternalAgentPrincipalsByIds(context.db, {
			principalIds: externalAgentIds,
			organizationId,
		});
		for (const principal of externalAgents) {
			if (!externalAgentIds.includes(principal.id)) continue;
			principals.set(principalKey("external_agent", principal.id), {
				id: principal.id,
				type: "external_agent",
				label: principal.displayName || principal.key || principal.id,
				secondary: principal.key ?? null,
				slug: principal.key ?? null,
				avatarUrl: null,
				unresolved: false,
			});
		}
	}
	if (userIds.length > 0) {
		const memberRows = await listAnalyticsOrganizationMembers(context.db, {
			userIds,
			organizationId,
		});
		for (const member of memberRows) {
			const label = member.name || member.email || member.descopeUserId;
			principals.set(principalKey("user", member.descopeUserId), {
				id: member.descopeUserId,
				type: "user",
				label,
				secondary: member.email ?? member.role ?? null,
				slug: null,
				avatarUrl: member.avatarUrl ?? null,
				unresolved: false,
			});
			principals.set(principalKey("kernel", member.descopeUserId), {
				id: member.descopeUserId,
				type: "kernel",
				label: "Home Kernel",
				secondary: `acting for ${label}`,
				slug: null,
				avatarUrl: member.avatarUrl ?? null,
				unresolved: false,
			});
		}

		const userRows = await listAnalyticsUsers(context.db, userIds);
		for (const user of userRows) {
			if (!principals.has(principalKey("user", user.id))) {
				const label = user.name || user.email || user.id;
				principals.set(principalKey("user", user.id), {
					id: user.id,
					type: "user",
					label,
					secondary: user.email ?? null,
					slug: null,
					avatarUrl: user.avatarUrl ?? null,
					unresolved: false,
				});
			}
			if (!principals.has(principalKey("kernel", user.id))) {
				const label = user.name || user.email || user.id;
				principals.set(principalKey("kernel", user.id), {
					id: user.id,
					type: "kernel",
					label: "Home Kernel",
					secondary: `acting for ${label}`,
					slug: null,
					avatarUrl: user.avatarUrl ?? null,
					unresolved: false,
				});
			}
		}
	}

	if (allPrincipalIds.length > 0 || namespaceSlugCandidates.length > 0) {
		const tediRows = await listAnalyticsTedis(context.db, {
			principalIds: allPrincipalIds,
			tediIds,
			slugs: namespaceSlugCandidates,
			organizationId,
		});
		for (const tedi of tediRows) {
			const label = tedi.displayName || tedi.name || tedi.slug || tedi.id;
			const descriptor: PrincipalDescriptor = {
				id: tedi.id,
				type: "tedi",
				label,
				secondary: tedi.slug ?? tedi.descopeUserId ?? null,
				slug: tedi.slug ?? null,
				avatarUrl: tedi.avatar ?? null,
				unresolved: false,
			};
			principals.set(principalKey("tedi", tedi.id), descriptor);
			const normalizedSlug = normalizedNamespaceToken(tedi.slug);
			if (normalizedSlug) namespaceTedis.set(normalizedSlug, descriptor);
			if (tedi.descopeUserId) {
				const descopeDescriptor: PrincipalDescriptor = {
					...descriptor,
					id: tedi.descopeUserId,
				};
				principals.set(
					principalKey("tedi", tedi.descopeUserId),
					descopeDescriptor,
				);
				if (!principals.has(principalKey("user", tedi.descopeUserId))) {
					principals.set(
						principalKey("user", tedi.descopeUserId),
						descopeDescriptor,
					);
				}
			}
		}
	}

	return { apps, namespaceTedis, tools, principals };
}

function describePrincipal(
	id: string | null | undefined,
	type: string | null | undefined,
	maps: HydrationMaps,
): PrincipalDescriptor {
	const normalizedType = normalizePrincipalType(type);
	if (!id) return unresolvedPrincipal(id, normalizedType);
	const hydrated = maps.principals.get(principalKey(normalizedType, id));
	if (hydrated) return hydrated;
	if (
		normalizedType === "service" ||
		normalizedType === "m2m" ||
		normalizedType === "apiKey" ||
		normalizedType === "anonymous"
	) {
		return machinePrincipalDescriptor(id, normalizedType);
	}
	return unresolvedPrincipal(id, normalizedType);
}

function hydrateActivityItem(
	item: ActivityItem,
	row: AuditActivityRow,
	maps: HydrationMaps,
): ActivityItem {
	const actor = describePrincipal(row.actorId, row.actorType, maps);
	let subject = row.subjectUserId
		? describePrincipal(row.subjectUserId, "user", maps)
		: null;
	const agent = row.agentTediId
		? describePrincipal(row.agentTediId, "tedi", maps)
		: null;
	const tediAgentSubject =
		actor.type === "tedi" &&
		!actor.unresolved &&
		agent?.type === "tedi" &&
		!agent.unresolved &&
		actor.id === agent.id &&
		(row.delegationMode === "agent" || row.actorType === "tedi");
	if (tediAgentSubject && (!subject || subject.unresolved)) {
		subject = agent;
	}
	const app = row.appId
		? (maps.apps.get(row.appId) ?? unresolvedApp(row.appId))
		: null;
	let tool = row.resourceId
		? (maps.tools.get(keyForTool(row.appId, row.resourceId)) ??
			unresolvedTool(row.resourceId, app))
		: null;
	const clientId = row.clientId ?? row.oauthClientId ?? item.clientId;
	const delegationMode = row.delegationMode ?? item.delegationMode;
	if (row.resourceId && (!tool || tool.unresolved)) {
		tool =
			tediScopedVirtualTool(
				row.resourceId,
				app,
				[agent, actor],
				maps.namespaceTedis,
			) ?? tool;
	}
	const attribution = buildDelegationChain({
		mode: delegationMode,
		actor,
		subject,
		agent,
		clientId,
	});
	const identityCoverage = buildIdentityCoverage({
		actor,
		subject,
		agent,
		app,
		tool,
		clientId,
		subjectPresent: !!row.subjectUserId || tediAgentSubject,
		agentPresent: !!row.agentTediId,
	});
	return {
		...item,
		actor,
		subject,
		agent,
		app,
		tool,
		clientId,
		delegationMode,
		attribution,
		identityCoverage,
	};
}

export async function hydrateActivityRows(
	context: BaseContext,
	rows: AuditActivityRow[],
	organizationId: string | undefined,
): Promise<ActivityItem[]> {
	const items = mapAuditActivityRows(rows);
	if (rows.length === 0) return items;
	const maps = await loadHydrationMaps(context, rows, organizationId);
	return items.map((item, index) =>
		hydrateActivityItem(item, rows[index]!, maps),
	);
}

export function mergeCoverage(items: ActivityItem[]): IdentityCoverage {
	const warnings = Array.from(
		new Set(items.flatMap((item) => item.identityCoverage.warnings)),
	);
	return {
		actorResolved: items.every((item) => item.identityCoverage.actorResolved),
		subjectPresent: items.some((item) => item.identityCoverage.subjectPresent),
		subjectResolved: items
			.filter((item) => item.identityCoverage.subjectPresent)
			.every((item) => item.identityCoverage.subjectResolved),
		agentPresent: items.some((item) => item.identityCoverage.agentPresent),
		agentResolved: items
			.filter((item) => item.identityCoverage.agentPresent)
			.every((item) => item.identityCoverage.agentResolved),
		appResolved: items.every((item) => item.identityCoverage.appResolved),
		toolResolved: items.every((item) => item.identityCoverage.toolResolved),
		clientPresent: items.some((item) => item.identityCoverage.clientPresent),
		warnings,
		warningDetails: Array.from(
			new Map(
				items
					.flatMap((item) => item.identityCoverage.warningDetails)
					.map((detail) => [detail.code, detail]),
			).values(),
		),
	};
}

export function buildToolSummaries(items: ActivityItem[]) {
	const byTool = new Map<
		string,
		{ tool: ToolDescriptor; count: number; errors: number }
	>();
	for (const item of items) {
		if (!item.tool) continue;
		const existing = byTool.get(item.tool.toolName) ?? {
			tool: item.tool,
			count: 0,
			errors: 0,
		};
		existing.count += 1;
		if (!item.success) existing.errors += 1;
		byTool.set(item.tool.toolName, existing);
	}
	return Array.from(byTool.values())
		.sort((a, b) => b.count - a.count || b.errors - a.errors)
		.slice(0, 6);
}

export function buildSecurityPosture(
	items: ActivityItem[],
): ActivityReviewGroup["securityPosture"] {
	const deniedEvents = items.filter(
		(item) => item.securityDecision.disposition === "denied",
	).length;
	const executedEvents = items.length - deniedEvents;
	return {
		disposition:
			deniedEvents === 0
				? "executed"
				: executedEvents === 0
					? "denied"
					: "mixed",
		executedEvents,
		deniedEvents,
		denialReasons: [
			...new Set(
				items.flatMap((item) =>
					item.securityDecision.denialReason
						? [item.securityDecision.denialReason]
						: [],
				),
			),
		].sort(),
		mcpMethods: [
			...new Set(
				items.flatMap((item) =>
					item.securityDecision.mcpMethod
						? [item.securityDecision.mcpMethod]
						: [],
				),
			),
		].sort(),
		riskTiers: [
			...new Set(
				items.flatMap((item) =>
					item.securityDecision.riskTier
						? [item.securityDecision.riskTier]
						: [],
				),
			),
		].sort(),
		unknownRiskEvents: items.filter(
			(item) => item.securityDecision.riskTier === null,
		).length,
	};
}
