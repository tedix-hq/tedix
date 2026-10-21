import { registerDescopeMcpResource } from "@tedix/auth/aih-client";
import {
	computeManagedAssignmentsForTedi,
	TEDI_MCP_SCOPES,
} from "@tedix/auth/app-assignment-policy";
import { getManagementClient } from "@tedix/auth/client";
import { grantAppObserver, grantAppOperator } from "@tedix/auth/fga";
import { getAppMetadataJson } from "@tedix/db/queries/app-records";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import { upsertTediSecret } from "@tedix/db/queries/tedi-secrets";
import { updateTedi } from "@tedix/db/queries/tedis";
import { encryptTediSecret } from "@tedix/db/utils/secrets-encryption";
import { invalidateConfig } from "@tedix/provisioning";
import { ensureTediAihClientForApp } from "../../../lib/tedi-aih-client-sync";
import {
	type BaseContext,
	getPlatformDomain,
	getProvisioningConfig,
	requireTediAccess,
} from "./helpers";

// =============================================================================
// TEDI MCP scopes
// =============================================================================

// The AIH MCP-server approved-scope envelope must cover every scope any tedi
// client can be synced with. Derive it from the single source of truth
// (TEDI_MCP_SCOPES) rather than hand-copying — a hand-copy previously omitted
// tedi:browser.read/.write, so observer clients synced with those scopes could
// exceed the approved envelope (Descope E113121).
const TEDI_MCP_SCOPE_NAMES = TEDI_MCP_SCOPES;

export async function storeEncryptedTediSecret(
	masterKey: string,
	context: BaseContext,
	tediId: string,
	name: string,
	plaintext: string,
) {
	const encrypted = await encryptTediSecret(masterKey, tediId, plaintext);
	await upsertTediSecret(context.db, tediId, name, encrypted, null, null);
}

export async function materializeManagedAppAssignments(
	context: BaseContext,
	tedi: {
		id: string;
		organizationId: string;
		name: string;
		slug: string;
		descopeUserId?: string | null;
		mcpCapabilityProfile?: string | null;
		tags?: string[] | null;
	},
): Promise<void> {
	if (!tedi.descopeUserId || !context.env.DESCOPE_MANAGEMENT_KEY) return;

	const orgApps = await getAppsByOrganization(context.db, tedi.organizationId);
	const managedAssignments = computeManagedAssignmentsForTedi(
		orgApps.map((app) => ({
			id: app.id,
			name: app.name,
			slug: app.slug,
			metadata: getAppMetadataJson(app),
		})),
		{
			id: tedi.id,
			slug: tedi.slug,
			mcpCapabilityProfile: tedi.mcpCapabilityProfile,
			tags: tedi.tags,
		},
	);

	if (managedAssignments.length === 0) return;

	const descopeClient = getManagementClient(context.env);
	const appById = new Map(orgApps.map((app) => [app.id, app]));
	for (const assignment of managedAssignments) {
		if (assignment.role === "operator") {
			await grantAppOperator(
				descopeClient,
				tedi.descopeUserId,
				assignment.appId,
			);
		} else {
			await grantAppObserver(
				descopeClient,
				tedi.descopeUserId,
				assignment.appId,
			);
		}

		const app = appById.get(assignment.appId);
		if (
			app &&
			context.env.SECRETS_MASTER_KEY &&
			context.env.DESCOPE_PROJECT_ID &&
			context.env.DESCOPE_MANAGEMENT_KEY
		) {
			const result = await ensureTediAihClientForApp({
				env: {
					DESCOPE_PROJECT_ID: context.env.DESCOPE_PROJECT_ID,
					DESCOPE_MANAGEMENT_KEY: context.env.DESCOPE_MANAGEMENT_KEY,
				},
				db: context.db,
				masterKey: context.env.SECRETS_MASTER_KEY,
				tedi,
				app,
				role: assignment.role,
				createdBy: context.user?.sub ?? null,
			});
			console.log(
				`[Tedis] Synced AIH client for ${tedi.slug} -> ${app.slug}: ${result.status}`,
			);
		}
	}

	console.log(
		`[Tedis] Materialized ${managedAssignments.length} managed app assignment(s) for ${tedi.slug}`,
	);
}

export async function registerTediAihMcpServer(
	context: BaseContext,
	tedi: {
		id: string;
		name: string;
		slug: string | null;
		displayName?: string | null;
	},
): Promise<string> {
	if (!tedi.slug) {
		throw new Error("Cannot register a per-tedi AIH MCP server without a slug");
	}

	const platformDomain = getPlatformDomain(context.env);
	const mcpServerUrl = `https://${tedi.slug}.tedi.${platformDomain}/mcp`;

	const server = await registerDescopeMcpResource(context.env, {
		name: `Tedi ${tedi.displayName ?? tedi.name}`,
		description: `MCP server for tedi ${tedi.slug}`,
		audienceWhitelist: [mcpServerUrl],
		approvedScopes: {
			connectionsScopes: TEDI_MCP_SCOPE_NAMES.map((scope) => ({
				name: scope,
				description:
					scope === "tedi:admin"
						? "Full tedi access"
						: `Tedi runtime capability: ${scope}`,
				optional: true,
			})),
		},
		dynamicRegistration: {
			enabled: true,
			flowId: "sign-up-or-in",
			disableApprovedScopesAsDefault: true,
		},
		skipConsentScreen: false,
	});

	await updateTedi(context.db, tedi.id, {
		descopeMcpResourceId: server.id,
	});

	console.log(
		`[Tedis] Registered opt-in AIH MCP server for ${tedi.name} (serverId: ${server.id}, url: ${mcpServerUrl})`,
	);

	return server.id;
}

export async function refreshTediRuntimeSecrets(
	context: BaseContext,
	tedi: Awaited<ReturnType<typeof requireTediAccess>>,
): Promise<boolean> {
	const provConfig = getProvisioningConfig(tedi, context.env);
	if (!provConfig) return false;
	await invalidateConfig(provConfig).catch(() => false);
	return true;
}
