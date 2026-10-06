import { ORPCError } from "@orpc/server";
import { getManagementClient } from "@tedix/auth/client";
import { descopeIssuer } from "@tedix/auth/principal-identity";
import {
	repairTediIdentity,
	rotateTediAccessKey,
} from "@tedix/auth/tedi-identity";
import { bindPrincipalIdentity } from "@tedix/db/queries/principal-identities";
import {
	getAllTediSecrets,
	upsertTediSecret,
	upsertTediAccessKeySecrets,
} from "@tedix/db/queries/tedi-secrets";
import {
	getTediBySlug,
	updateTedi,
	tryAcquireTediRuntimeLease,
	releaseTediRuntimeLease,
} from "@tedix/db/queries/tedis";
import { TEDI_RUNTIME_ACCESS_TOKEN_SECRET_NAME } from "@tedix/db/schema/tedi-secrets";
import {
	encryptTediSecret,
	decryptTediSecret,
} from "@tedix/db/utils/secrets-encryption";
import type { BaseContext } from "../rpc/orpc";

/** Shared by initial creation and retries so neither observes half-written credentials. */
export async function ensureProviderWorkerReady(
	context: BaseContext,
	input: {
		organizationId: string;
		tenantId: string;
		tediId: string;
		slug: string;
	},
) {
	const masterKey = context.env.SECRETS_MASTER_KEY;
	if (
		!masterKey ||
		!context.env.DESCOPE_PROJECT_ID ||
		!context.env.DESCOPE_MANAGEMENT_KEY
	)
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: "Customer worker identity provisioning is unavailable",
		});
	const lease = {
		tediId: input.tediId,
		name: "descope-access-key-rotation",
		owner: crypto.randomUUID(),
	};
	if (
		!(await tryAcquireTediRuntimeLease(context.db, {
			...lease,
			ttlMs: 300_000,
		}))
	)
		throw new ORPCError("CONFLICT", {
			message:
				"Customer worker provisioning is in progress; retry this request",
		});
	try {
		const tedi = await getTediBySlug(
			context.db,
			input.organizationId,
			input.slug,
		);
		if (
			!tedi ||
			tedi.id !== input.tediId ||
			tedi.status !== "active" ||
			tedi.retiredAt ||
			!tedi.runtimeProfileId ||
			!tedi.policyPackId ||
			!tedi.workspaceTemplateSetId
		)
			throw new ORPCError("CONFLICT", {
				message: "Customer worker configuration is not ready",
			});
		const client = getManagementClient(context.env);
		const identity = await repairTediIdentity(client, {
			tediId: tedi.id,
			slug: tedi.slug,
			displayName: tedi.displayName ?? tedi.name,
			tenantId: input.tenantId,
			descopeUserId: tedi.descopeUserId,
		});
		await updateTedi(context.db, tedi.id, {
			descopeUserId: identity.descopeUserId,
		});
		await bindPrincipalIdentity(context.db, {
			organizationId: input.organizationId,
			principalType: "tedi",
			principalId: tedi.id,
			provider: "descope",
			issuer: descopeIssuer(
				context.env.DESCOPE_PROJECT_ID,
				context.env.DESCOPE_BASE_URL,
			),
			subject: identity.descopeUserId,
		});
		const secrets = await getAllTediSecrets(context.db, tedi.id);
		const names = new Set(secrets.map((s) => s.name));
		// A persisted identity is not proof that the one-time access key was saved.
		// New identity or a missing half of the pair requires an atomic replacement.
		if (
			identity.cleartext ||
			identity.descopeUserId !== tedi.descopeUserId ||
			!names.has("DESCOPE_ACCESS_KEY") ||
			!names.has("DESCOPE_ACCESS_KEY_ID")
		) {
			const key =
				identity.cleartext && identity.descopeKeyId
					? {
							cleartext: identity.cleartext,
							descopeKeyId: identity.descopeKeyId,
						}
					: await rotateTediAccessKey(client, {
							tediId: tedi.id,
							slug: tedi.slug,
							descopeUserId: identity.descopeUserId,
							deactivateOld: false,
						});
			if (!key.cleartext || !key.descopeKeyId)
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message: "Customer worker credential issuance failed",
				});
			const [encryptedAccessKey, encryptedAccessKeyId] = await Promise.all([
				encryptTediSecret(masterKey, tedi.id, key.cleartext),
				encryptTediSecret(masterKey, tedi.id, key.descopeKeyId),
			]);
			await upsertTediAccessKeySecrets(context.db, {
				tediId: tedi.id,
				encryptedAccessKey,
				encryptedAccessKeyId,
			});
		}
		for (const name of [TEDI_RUNTIME_ACCESS_TOKEN_SECRET_NAME, "CDP_SECRET"]) {
			if (!names.has(name))
				await upsertTediSecret(
					context.db,
					tedi.id,
					name,
					await encryptTediSecret(masterKey, tedi.id, crypto.randomUUID()),
					null,
					null,
				);
		}
		const persisted = await getAllTediSecrets(context.db, tedi.id);
		for (const name of [
			"DESCOPE_ACCESS_KEY",
			"DESCOPE_ACCESS_KEY_ID",
			TEDI_RUNTIME_ACCESS_TOKEN_SECRET_NAME,
			"CDP_SECRET",
		]) {
			const secret = persisted.find((s) => s.name === name);
			if (
				!secret ||
				!(await decryptTediSecret(masterKey, tedi.id, secret.encryptedValue))
			)
				throw new ORPCError("CONFLICT", {
					message: "Customer worker credentials are not ready",
				});
		}
		return { ...tedi, descopeUserId: identity.descopeUserId };
	} finally {
		await releaseTediRuntimeLease(context.db, lease);
	}
}
