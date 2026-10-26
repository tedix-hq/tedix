import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import { getManagementClient } from "@tedix/auth/client";
import {
	repairTediIdentity,
	TEDI_DEFAULT_ROLE,
} from "@tedix/auth/tedi-identity";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getAllTediSecrets } from "@tedix/db/queries/tedi-secrets";
import { updateTedi } from "@tedix/db/queries/tedis";
import { TEDI_RUNTIME_ACCESS_TOKEN_SECRET_NAME } from "@tedix/db/schema/tedi-secrets";
import { auditActor, emitAuditEvent } from "../../audit-helpers";
import {
	AUTHZ,
	authedTedisOs,
	createError,
	ErrorCodes,
	requireOrganizationId,
	requireTediAccess,
} from "./helpers";
import {
	storeEncryptedTediSecret,
	registerTediAihMcpServer,
} from "./identity-provisioning";

// =============================================================================
// self-healing (repair)
// =============================================================================

/** Secrets that every tedi needs for runtime and browser access */
const REQUIRED_SECRETS: Array<{
	name: string;
	generate: () => string;
}> = [
	{
		name: TEDI_RUNTIME_ACCESS_TOKEN_SECRET_NAME,
		generate: () => crypto.randomUUID(),
	},
	{ name: "CDP_SECRET", generate: () => crypto.randomUUID() },
];

export const repairTediProcedure = authedTedisOs.repair
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const masterKey = context.env.SECRETS_MASTER_KEY;

		if (!masterKey) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"SECRETS_MASTER_KEY is not configured — cannot repair secrets",
			);
		}

		const existingSecrets = await getAllTediSecrets(context.db, tedi.id);
		const existingNames = new Set(existingSecrets.map((s) => s.name));

		const repaired: string[] = [];
		const alreadyPresent: string[] = [];
		const errors: string[] = [];

		for (const { name, generate } of REQUIRED_SECRETS) {
			if (existingNames.has(name)) {
				alreadyPresent.push(name);
				continue;
			}
			try {
				await storeEncryptedTediSecret(
					masterKey,
					context,
					tedi.id,
					name,
					generate(),
				);
				repaired.push(name);
				console.log(
					`[Tedis] Repair: auto-generated ${name} for ${tedi.name} (${tedi.id})`,
				);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				errors.push(`${name}: ${msg}`);
				console.error(
					`[Tedis] Repair: failed to generate ${name} for ${tedi.id}:`,
					error,
				);
			}
		}

		if (context.env.DESCOPE_PROJECT_ID && context.env.DESCOPE_MANAGEMENT_KEY) {
			try {
				const org = await getOrganizationById(context.db, tedi.organizationId);
				if (!org?.descopeTenantId) {
					alreadyPresent.push("descope:tenant-unavailable");
				} else {
					const descopeClient = getManagementClient(context.env);
					const identity = await repairTediIdentity(descopeClient, {
						tediId: tedi.id,
						slug: tedi.slug ?? tedi.id,
						displayName: tedi.displayName ?? tedi.name,
						tenantId: org.descopeTenantId,
						descopeUserId: tedi.descopeUserId,
						roles: [TEDI_DEFAULT_ROLE],
					});

					if (
						identity.descopeUserId &&
						identity.descopeUserId !== tedi.descopeUserId
					) {
						await updateTedi(context.db, tedi.id, {
							descopeUserId: identity.descopeUserId,
						});
						repaired.push("descope:user-id");
					}

					for (const item of identity.changed) {
						repaired.push(`descope:${item}`);
					}
					for (const item of identity.alreadyPresent) {
						alreadyPresent.push(`descope:${item}`);
					}

					if (identity.cleartext) {
						await storeEncryptedTediSecret(
							masterKey,
							context,
							tedi.id,
							"DESCOPE_ACCESS_KEY",
							identity.cleartext,
						);
						repaired.push("DESCOPE_ACCESS_KEY");
					}
					if (identity.descopeKeyId) {
						await storeEncryptedTediSecret(
							masterKey,
							context,
							tedi.id,
							"DESCOPE_ACCESS_KEY_ID",
							identity.descopeKeyId,
						);
						repaired.push("DESCOPE_ACCESS_KEY_ID");
					}
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				errors.push(`descope: ${msg}`);
				console.error(
					`[Tedis] Repair: failed to reconcile Descope identity for ${tedi.id}:`,
					error,
				);
			}
		} else {
			alreadyPresent.push("descope:management-unavailable");
		}

		if (input.registerDescopeAih === true) {
			if (tedi.descopeMcpResourceId) {
				alreadyPresent.push("descope:mcp-server");
			} else if (
				!context.env.DESCOPE_PROJECT_ID ||
				!context.env.DESCOPE_MANAGEMENT_KEY
			) {
				errors.push("descope:mcp-server: management unavailable");
			} else if (context.env.ENVIRONMENT !== "production") {
				errors.push(
					`descope:mcp-server: skipped outside production (${context.env.ENVIRONMENT})`,
				);
			} else {
				try {
					await registerTediAihMcpServer(context, tedi);
					repaired.push("descope:mcp-server");
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					errors.push(`descope:mcp-server: ${msg}`);
					console.error(
						`[Tedis] Repair: failed to register AIH MCP server for ${tedi.id}:`,
						error,
					);
				}
			}
		}

		// Emit audit event
		const { actorId, actorType } = auditActor(context);
		await emitAuditEvent(context.db, {
			organizationId: requireOrganizationId(context),
			actorId,
			actorType,
			action: "tedi.repair",
			resourceType: "tedi",
			resourceId: tedi.id,
			metadata: { repaired, alreadyPresent, errors },
		}).catch((err) => {
			console.error("[Tedis] Failed to emit audit event for tedi.repair", {
				exception: safeExceptionTopology(err),
			});
		});

		return { repaired, alreadyPresent, errors };
	});
