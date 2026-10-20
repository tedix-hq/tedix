import { computeManagedAssignmentsForTedi } from "@tedix/auth/app-assignment-policy";
import { getManagementClient } from "@tedix/auth/client";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import { getAppMetadataJson } from "@tedix/db/queries/app-records";
import { listAllSkillsForOrg } from "@tedix/db/queries/cognitive/skill-inventory";
import { mcpNamespaceSlugCandidates } from "@tedix/db/queries/cognitive/skill-mcp-bindings";
import { parseSkillFrontmatterCapabilities } from "@tedix/db/queries/cognitive/skill-tool-metadata";
import { listSetupToolsForOrganization } from "@tedix/db/queries/tools";
import { ConnectionInventoryInputSchema } from "@tedix/api-contract/schemas/connections";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	deriveTediSetup,
	type SetupConfig,
} from "../../../services/tedi-setup";
import { readConnectionsOverview } from "../connections/inventory";
import {
	AUTHZ,
	authedTedisOs,
	requireTediAccess,
	createError,
	ErrorCodes,
} from "./helpers";
import { requireOrgId } from "../../org-scope";

export const getSetupProcedure = authedTedisOs.getSetup
	.use(AUTHZ.tedisAppsRead)
	.use(AUTHZ.appsRead)
	.handler(async ({ context, input }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		if (tedi.organizationId !== requireOrgId(context))
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Tedi not found in this organization",
			);
		const apps = await getAppsByOrganization(context.db, tedi.organizationId);
		const tools = await listSetupToolsForOrganization(
			context.db,
			tedi.organizationId,
		);
		const skills: SetupConfig["skills"] = [];
		for (let offset = 0; ; offset += 200) {
			const page = await listAllSkillsForOrg(context.db, tedi.organizationId, {
				tediId: tedi.id,
				limit: 200,
				offset,
			});
			for (const skill of page.entries) {
				if (
					skill.lifecycleState === "archived" ||
					skill.lifecycleState === "draft"
				)
					continue;
				const toolIds = [...(skill.toolIds ?? [])];
				const requires = [...(skill.preconditions?.requires ?? [])];
				const capabilities = parseSkillFrontmatterCapabilities(
					skill.files?.["SKILL.md"] ?? skill.agentSkillsFormat ?? "",
				);
				for (const [namespace, methods] of Object.entries(capabilities.mcp)) {
					const binding = skill.mcpAppBindings?.[namespace];
					const app = binding
						? apps.find((a) => a.id === binding)
						: apps.find((a) =>
								mcpNamespaceSlugCandidates(namespace).includes(a.slug),
							);
					for (const method of methods) {
						if (method === "*" && app) {
							toolIds.push(
								...tools
									.filter((tool) => tool.appId === app.id)
									.map((tool) => tool.id),
							);
							continue;
						}
						const tool = app
							? tools.find((t) => t.appId === app.id && t.toolId === method)
							: undefined;
						if (tool) toolIds.push(tool.id);
						else if (app) toolIds.push(`${namespace}.${method}`);
						else requires.push(`Verify capability ${namespace}.${method}`);
					}
				}
				skills.push({
					id: skill.id,
					title: skill.title,
					slug: skill.slug,
					toolIds: [...new Set(toolIds)],
					requires: [...new Set(requires)],
				});
			}
			if (offset + page.entries.length >= page.total) break;
		}
		const assigned = new Set(
			computeManagedAssignmentsForTedi(
				apps.map((app) => ({ ...app, metadata: getAppMetadataJson(app) })),
				tedi,
			).map((a) => a.appId),
		);
		let assignmentsComplete = apps.length === 0;
		if (tedi.descopeUserId && context.env.DESCOPE_MANAGEMENT_KEY) {
			try {
				const client = getManagementClient(context.env);
				assignmentsComplete = true;
				for (let offset = 0; offset < apps.length; offset += 25) {
					const tuples = apps.slice(offset, offset + 25).flatMap((app) =>
						["operator", "observer"].map((relation) => ({
							resource: app.id,
							resourceType: "app",
							relation,
							target: tedi.descopeUserId!,
							targetType: "user",
						})),
					);
					const response = await client.management.fga.check(tuples);
					if (!response.ok || !response.data) {
						assignmentsComplete = false;
						continue;
					}
					for (const tuple of tuples) {
						const matches = response.data.filter(
							(row) =>
								row.tuple.resource === tuple.resource &&
								row.tuple.target === tuple.target &&
								row.tuple.relation === tuple.relation,
						);
						if (matches.length !== 1) assignmentsComplete = false;
						if (matches.some((row) => row.allowed))
							assigned.add(tuple.resource);
					}
				}
			} catch {
				assignmentsComplete = false;
			}
		}
		const requiredIds = new Set(skills.flatMap((s) => s.toolIds));
		const connectionSources: NonNullable<SetupConfig["connectionSources"]> = [];
		for (const app of apps) {
			if (
				!assigned.has(app.id) &&
				!tools.some((tool) => tool.appId === app.id && requiredIds.has(tool.id))
			)
				continue;
			const mcp = getAppMetadataJson(app)?.mcpConfig;
			const references: unknown[] = [
				mcp,
				mcp?.openApiSync,
				mcp?.googleDiscoverySync,
				...(Array.isArray(mcp?.aggregateApps) ? mcp.aggregateApps : []),
			];
			for (const [index, ref] of references.entries()) {
				if (!isRecord(ref) || typeof ref.connectionProviderId !== "string")
					continue;
				connectionSources.push({
					id: `app:${app.id}:${index}`,
					appId: app.id,
					title: app.name,
					config: {
						auth: {
							type: "connection",
							connectionId: ref.connectionProviderId,
							connectionInstanceId: ref.connectionInstanceId,
							scope: ref.connectionScope ?? "tenant",
							scopes: ref.connectionScopes ?? ref.authScopes ?? [],
						},
					},
				});
			}
		}
		const providers = new Set<string>();
		for (const tool of [
			...tools.filter(
				(tool) => assigned.has(tool.appId) || requiredIds.has(tool.id),
			),
			...connectionSources,
		]) {
			const auth =
				isRecord(tool.config) && isRecord(tool.config.auth)
					? tool.config.auth
					: null;
			if (auth?.type === "connection" && typeof auth.connectionId === "string")
				providers.add(auth.connectionId);
		}
		const accounts: SetupConfig["accounts"] = [];
		if (providers.size > 0) {
			let incomplete = false;
			try {
				const inventory = await readConnectionsOverview(
					context,
					ConnectionInventoryInputSchema.parse({ limit: 100 }),
					providers,
				);
				accounts.push(
					...inventory.rows.map((row) => ({
						providerId: row.provider.appId,
						scope: row.scope,
						instanceId: row.connectionInstanceId ?? null,
						state: row.accountState,
						connected: row.connection?.status === "connected",
						scopes: row.connection?.scopes ?? [],
					})),
				);
				incomplete = inventory.hasMore || !inventory.verificationComplete;
			} catch {
				incomplete = true;
			}
			if (incomplete)
				for (const providerId of providers)
					accounts.push({
						providerId,
						scope: "tenant",
						instanceId: "*",
						state: "unknown",
						connected: false,
						scopes: [],
					});
		}
		return deriveTediSetup({
			tediId: tedi.id,
			tools,
			assignedAppIds: [...assigned],
			connectionSources,
			skills,
			accounts,
			assignmentsComplete,
		});
	});
