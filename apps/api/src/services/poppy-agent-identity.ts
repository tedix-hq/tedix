import {
	createPersonalAgentClient,
	generatePersonalAgentSigningKey,
} from "@tedix/auth/personal-agent-client";
import {
	poppyAgentClientId,
	poppyAgentJwksPath,
	POPPY_AGENT_SIGNING_KEY_SECRET,
	type PoppyAgentIdentityView,
} from "@tedix/api-contract/schemas/poppy-agent";
import type { DbClient } from "@tedix/db/client";
import { getTediByGlobalSlug } from "@tedix/db/queries/tedis";
import {
	deleteTediSecret,
	getTediSecret,
	upsertTediSecret,
} from "@tedix/db/queries/tedi-secrets";
import {
	decryptTediSecret,
	encryptTediSecret,
} from "@tedix/db/utils/secrets-encryption";
import type { Tedi } from "@tedix/db/schema/tedis";

/**
 * Tedix-hosted Poppy personal-agent identity.
 *
 * One identity per tedi: the ES256 signing key lives encrypted in
 * `tedi_secrets` under {@link POPPY_AGENT_SIGNING_KEY_SECRET}, and the public
 * client metadata + JWKS documents are rendered on demand from that key at
 * stable URLs on the API origin. Nothing here ever returns private key
 * material outside the Worker that signs with it.
 */

type PoppyAgentEnv = Pick<CloudflareEnv, "API_URL" | "SECRETS_MASTER_KEY">;

function apiOrigin(env: PoppyAgentEnv): string {
	return new URL(env.API_URL).origin;
}

function identityUrls(
	env: PoppyAgentEnv,
	tedi: Pick<Tedi, "slug">,
): { clientId: string; jwksUri: string } {
	const origin = apiOrigin(env);
	return {
		clientId: poppyAgentClientId(origin, tedi.slug),
		jwksUri: `${origin}${poppyAgentJwksPath(tedi.slug)}`,
	};
}

function clientName(tedi: Pick<Tedi, "name" | "displayName" | "slug">): string {
	return tedi.displayName ?? tedi.name ?? tedi.slug;
}

/**
 * Load the tedi's signing client, or null when the identity is off or the
 * stored key cannot be decrypted/parsed. Callers that must distinguish
 * "disabled" from "broken" check the secret row first.
 */
async function loadSigningClient(
	env: PoppyAgentEnv,
	db: DbClient,
	tedi: Tedi,
): Promise<{
	client: ReturnType<typeof createPersonalAgentClient>;
	keyId: string | null;
} | null> {
	const secret = await getTediSecret(
		db,
		tedi.id,
		POPPY_AGENT_SIGNING_KEY_SECRET,
	);
	if (!secret || !env.SECRETS_MASTER_KEY) return null;
	const plaintext = await decryptTediSecret(
		env.SECRETS_MASTER_KEY,
		tedi.id,
		secret.encryptedValue,
	);
	const signingKey = JSON.parse(plaintext);
	const { clientId, jwksUri } = identityUrls(env, tedi);
	const client = createPersonalAgentClient({
		clientId,
		jwksUri,
		signingKey,
		clientName: clientName(tedi),
	});
	const jwks = await client.jwks();
	return { client, keyId: jwks.keys[0]?.kid ?? null };
}

/** Admin-facing view; decrypts only to read the public `kid`. */
export async function getPoppyAgentIdentityView(
	env: PoppyAgentEnv,
	db: DbClient,
	tedi: Tedi,
): Promise<PoppyAgentIdentityView> {
	const secret = await getTediSecret(
		db,
		tedi.id,
		POPPY_AGENT_SIGNING_KEY_SECRET,
	);
	if (!secret) {
		return {
			enabled: false,
			clientId: null,
			jwksUri: null,
			keyId: null,
			clientName: null,
		};
	}
	const { clientId, jwksUri } = identityUrls(env, tedi);
	let keyId: string | null = null;
	try {
		keyId = (await loadSigningClient(env, db, tedi))?.keyId ?? null;
	} catch {
		// A stored-but-undecryptable key still counts as enabled; the public
		// document route fails closed on it rather than serving a broken JWKS.
	}
	return {
		enabled: true,
		clientId,
		jwksUri,
		keyId,
		clientName: clientName(tedi),
	};
}

/**
 * Turn the identity on (generate + store the key once) or off (delete it).
 * Re-enabling an already-enabled tedi is idempotent and keeps the key so
 * published `iss` values stay stable.
 */
export async function setPoppyAgentIdentityEnabled(
	env: PoppyAgentEnv,
	db: DbClient,
	input: { tedi: Tedi; enabled: boolean; actorId: string | null },
): Promise<PoppyAgentIdentityView> {
	const existing = await getTediSecret(
		db,
		input.tedi.id,
		POPPY_AGENT_SIGNING_KEY_SECRET,
	);
	if (input.enabled) {
		if (!existing) {
			if (!env.SECRETS_MASTER_KEY)
				throw new Error("SECRETS_MASTER_KEY is not configured");
			const privateJwk = await generatePersonalAgentSigningKey();
			const encrypted = await encryptTediSecret(
				env.SECRETS_MASTER_KEY,
				input.tedi.id,
				JSON.stringify(privateJwk),
			);
			await upsertTediSecret(
				db,
				input.tedi.id,
				POPPY_AGENT_SIGNING_KEY_SECRET,
				encrypted,
				null,
				input.actorId,
			);
		}
	} else if (existing) {
		await deleteTediSecret(db, existing.id);
	}
	// Re-read the row so the returned view reflects what is actually stored.
	return getPoppyAgentIdentityView(env, db, input.tedi);
}

export type PoppyAgentPublicDocument = "client" | "jwks";

/**
 * Render one public identity document for the well-known route. Returns null
 * when the tedi or its key does not exist — the route answers 404, which is
 * also what a disabled identity looks like to a verifier.
 */
export async function loadPoppyAgentPublicDocument(
	env: PoppyAgentEnv,
	db: DbClient,
	slug: string,
	document: PoppyAgentPublicDocument,
): Promise<Record<string, unknown> | null> {
	const tedi = await getTediByGlobalSlug(db, slug);
	if (!tedi) return null;
	const loaded = await loadSigningClient(env, db, tedi).catch(() => null);
	if (!loaded) return null;
	return document === "client"
		? loaded.client.clientMetadata()
		: loaded.client.jwks();
}
