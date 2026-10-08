/**
 * Auto-provision the first tedi for every workspace type.
 *
 * Called from every organization creation/bootstrap path when an org has 0 tedis.
 * Mirrors the full provisioning flow from createTediProcedure:
 * D1 record → Descope identity → encrypted secrets → AIH client → FGA assignments.
 */

import { computeManagedAssignmentsForTedi } from "@tedix/auth/app-assignment-policy";
import { getManagementClient } from "@tedix/auth/client";
import { grantAppObserver, grantAppOperator } from "@tedix/auth/fga";
import { descopeIssuer } from "@tedix/auth/principal-identity";
import { createTediIdentity } from "@tedix/auth/tedi-identity";
import type { DbClient } from "@tedix/db/client";
import { getAppMetadataJson } from "@tedix/db/queries/app-records";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { bindPrincipalIdentity } from "@tedix/db/queries/principal-identities";
import { upsertTediSecret } from "@tedix/db/queries/tedi-secrets";
import {
	createTedi,
	getTedisByOrganization,
	updateTedi,
} from "@tedix/db/queries/tedis";
import {
	getSystemDefaultPolicyPack,
	getSystemDefaultRuntimeProfile,
	getSystemDefaultWorkspaceTemplateSet,
} from "@tedix/db/queries/control-plane/definitions";
import { TEDI_RUNTIME_ACCESS_TOKEN_SECRET_NAME } from "@tedix/db/schema/tedi-secrets";
import { encryptTediSecret } from "@tedix/db/utils/secrets-encryption";
import { ensureTediAihClientForApp } from "./tedi-aih-client-sync";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function storeSecret(
	masterKey: string,
	db: DbClient,
	tediId: string,
	name: string,
	plaintext: string,
) {
	const encrypted = await encryptTediSecret(masterKey, tediId, plaintext);
	await upsertTediSecret(db, tediId, name, encrypted, null, null);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function autoProvisionFirstTedi(
	db: DbClient,
	env: CloudflareEnv,
	orgId: string,
	userName?: string | null,
	ownerUserId?: string | null,
): Promise<{ tediId: string; slug: string; name: string } | null> {
	// Guard: only create if org has zero tedis
	const existingTedis = await getTedisByOrganization(db, orgId);
	if (existingTedis.length > 0) return null;

	const firstName = userName?.trim().split(/\s+/)[0];
	const tediName = firstName ? `${firstName}'s Tedi` : "My Tedi";
	const slug = `tedi-${crypto.randomUUID().slice(0, 6)}`;

	// The platform defaults are whichever revisions are published as head right
	// now, not ids compiled into this Worker.
	const [defaultProfile, defaultPolicyPack, defaultWorkspaceTemplateSet] =
		await Promise.all([
			getSystemDefaultRuntimeProfile(db),
			getSystemDefaultPolicyPack(db),
			getSystemDefaultWorkspaceTemplateSet(db),
		]);

	const tedi = await createTedi(db, {
		id: crypto.randomUUID(),
		organizationId: orgId,
		name: tediName,
		slug,
		displayName: tediName,
		// The org's first tedi is the Agent runtime: the lightweight Cloudflare
		// Agents Worker + Durable Object with native Pi facets (see docs/engineering/tedi/agent-runtime.md).
		// It is immediately ready — there is no container boot to wait on — so it
		// provisions straight to "active". OS/process capability, if ever needed, is
		// added later via an additive Sandbox workstation lease, not a body swap
		// (cognitive state is body-neutral). The legacy runtime runtime body
		// stayed "provisioning" until its gateway was up; that body is deprecating.
		status: "active",
		scope: "organization",
		ownerUserId: ownerUserId ?? null,
		personality: "explorer",
		runtimeProfileId: defaultProfile?.id ?? null,
		policyPackId: defaultPolicyPack?.id ?? null,
		workspaceTemplateSetId: defaultWorkspaceTemplateSet?.id ?? null,
		runtimeKind: "agent",
		// Agent-runtime tedis are addressed by isolate_agent_id (defaults to slug).
		isolateAgentId: slug,
	});

	console.log(
		`[AutoProvision] Created tedi "${tediName}" (${tedi.id}) for org ${orgId}`,
	);

	const masterKey = env.SECRETS_MASTER_KEY;
	const org = await getOrganizationById(db, orgId);

	// ── Descope identity ──────────────────────────────────────────────────
	if (
		env.DESCOPE_PROJECT_ID &&
		env.DESCOPE_MANAGEMENT_KEY &&
		org?.descopeTenantId
	) {
		try {
			const descopeClient = getManagementClient(env);
			const identity = await createTediIdentity(descopeClient, {
				tediId: tedi.id,
				slug,
				displayName: tediName,
				tenantId: org.descopeTenantId,
			});
			await updateTedi(db, tedi.id, {
				descopeUserId: identity.descopeUserId,
			});
			await bindPrincipalIdentity(db, {
				organizationId: orgId,
				principalType: "tedi",
				principalId: tedi.id,
				provider: "descope",
				issuer: descopeIssuer(env.DESCOPE_PROJECT_ID, env.DESCOPE_BASE_URL),
				subject: identity.descopeUserId,
			});

			if (identity.cleartext && masterKey) {
				await storeSecret(
					masterKey,
					db,
					tedi.id,
					"DESCOPE_ACCESS_KEY",
					identity.cleartext,
				);
				await storeSecret(
					masterKey,
					db,
					tedi.id,
					"DESCOPE_ACCESS_KEY_ID",
					identity.descopeKeyId,
				);
				console.log(
					`[AutoProvision] Provisioned Descope identity for ${tediName} (user: ${identity.descopeUserId})`,
				);
			}

			// Managed app assignments (FGA)
			const orgApps = await getAppsByOrganization(db, orgId);
			const assignments = computeManagedAssignmentsForTedi(
				orgApps.map((app) => ({
					id: app.id,
					name: app.name,
					slug: app.slug,
					metadata: getAppMetadataJson(app),
				})),
				{
					id: tedi.id,
					slug,
					mcpCapabilityProfile: null,
					tags: null,
				},
			);
			const appById = new Map(orgApps.map((app) => [app.id, app]));
			for (const a of assignments) {
				if (a.role === "operator") {
					await grantAppOperator(
						descopeClient,
						identity.descopeUserId,
						a.appId,
					);
				} else {
					await grantAppObserver(
						descopeClient,
						identity.descopeUserId,
						a.appId,
					);
				}
				const app = appById.get(a.appId);
				if (
					app &&
					masterKey &&
					env.DESCOPE_PROJECT_ID &&
					env.DESCOPE_MANAGEMENT_KEY
				) {
					const syncResult = await ensureTediAihClientForApp({
						env: {
							DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID,
							DESCOPE_MANAGEMENT_KEY: env.DESCOPE_MANAGEMENT_KEY,
						},
						db,
						masterKey,
						tedi: {
							id: tedi.id,
							name: tedi.name,
							slug,
							mcpCapabilityProfile: tedi.mcpCapabilityProfile,
						},
						app,
						role: a.role,
						createdBy: ownerUserId ?? null,
					});
					console.log(
						`[AutoProvision] Synced AIH client for ${tediName} -> ${app.slug}: ${syncResult.status}`,
					);
				}
			}
			if (assignments.length > 0) {
				console.log(
					`[AutoProvision] Materialized ${assignments.length} app assignment(s) for ${tediName}`,
				);
			}
		} catch (error) {
			console.warn(
				`[AutoProvision] Descope identity failed for ${tediName}:`,
				error,
			);
		}
	}

	// ── Runtime access token + CDP secret ─────────────────────────────────
	if (masterKey) {
		try {
			await storeSecret(
				masterKey,
				db,
				tedi.id,
				TEDI_RUNTIME_ACCESS_TOKEN_SECRET_NAME,
				crypto.randomUUID(),
			);
			await storeSecret(
				masterKey,
				db,
				tedi.id,
				"CDP_SECRET",
				crypto.randomUUID(),
			);
		} catch (error) {
			console.warn(
				`[AutoProvision] Secrets generation failed for ${tediName}:`,
				error,
			);
		}
	}

	return { tediId: tedi.id, slug, name: tediName };
}
