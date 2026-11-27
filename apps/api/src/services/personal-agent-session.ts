import {
	createPersonalAgentSessionVerifier,
	PersonalAgentSessionFailure,
} from "@tedix/auth/personal-agent-session";
import { PersonalAgentDiscoveryConfigSchema } from "@tedix/api-contract/schemas/organization";
import type { PersonalAgentSessionRequestSchema } from "@tedix/api-contract/schemas/personal-agent-session";
import type * as z from "zod";
import { createDbClient, type DbClient } from "@tedix/db/client";
import { getAppByIdForOrganization } from "@tedix/db/queries/app-records";
import {
	getOrganizationById,
	isOrganizationOffboarding,
} from "@tedix/db/queries/organizations";
import {
	consumePersonalAgentClientRate,
	continuePersonalAgentSession,
} from "@tedix/db/queries/personal-agent-sessions";
import { loadPoppyAgentPublicDocument } from "./poppy-agent-identity";

type IdentityHostEnv = Pick<
	CloudflareEnv,
	"API_URL" | "SECRETS_MASTER_KEY" | "DB"
>;

const TEDIX_IDENTITY_PATH =
	/^\/poppy-agent\/([a-z0-9][a-z0-9-]{0,127})\/(client|jwks)\.json$/;

// The Worker's env is fixed for the isolate, like the verifier's caches.
let identityHostEnv: IdentityHostEnv | undefined;

/**
 * A tedi's Poppy identity documents live on this Worker's own origin, and a
 * Worker's fetch to its own hostname never reaches its route. Render those
 * documents with the loader the public route uses; every other client_id
 * keeps the guarded network fetch.
 */
async function fetchIdentityDocument(
	url: string,
	init?: RequestInit,
): Promise<Response> {
	const env = identityHostEnv;
	const target = new URL(url);
	const match = env ? TEDIX_IDENTITY_PATH.exec(target.pathname) : null;
	if (!env || !match || target.origin !== new URL(env.API_URL).origin)
		return fetch(url, init);
	const doc = await loadPoppyAgentPublicDocument(
		env,
		createDbClient(env.DB),
		match[1]!,
		match[2] as "client" | "jwks",
	);
	return doc ? Response.json(doc) : new Response("Not found", { status: 404 });
}

const verify = createPersonalAgentSessionVerifier({
	fetchFn: fetchIdentityDocument,
});

/** Verifies identity, then persists continuity; never mints account authority. */
export async function verifySignedOutPersonalAgentSession(
	db: DbClient,
	input: z.infer<typeof PersonalAgentSessionRequestSchema>,
	env?: IdentityHostEnv,
) {
	if (env) identityHostEnv = env;
	const app = await getAppByIdForOrganization(
		db,
		input.appId,
		input.organizationId,
	);
	const organization = await getOrganizationById(db, input.organizationId);
	const config = PersonalAgentDiscoveryConfigSchema.safeParse(
		organization?.metadata?.personalAgentProtocol,
	);
	if (
		!app ||
		app.visibility === "disabled" ||
		!organization?.features?.os ||
		isOrganizationOffboarding(organization.metadata) ||
		!config.success
	)
		return { status: "not_configured" as const };
	// A public app listed by this organization is its signed-out protocol entry.
	// An authenticated app keeps the existing OAuth gates and does not acquire a
	// signed-out path merely because its organization publishes discovery.
	if (app.metadata?.mcpConfig?.authMode !== "public")
		return { status: "not_configured" as const };
	const target = new URL(input.url);
	const endpoint = new URL(config.data.mcpUrl);
	if (
		target.origin !== endpoint.origin ||
		!(
			target.pathname === endpoint.pathname ||
			target.pathname.startsWith(`${endpoint.pathname.replace(/\/$/, "")}/`)
		)
	)
		return { status: "not_configured" as const };
	try {
		const headers = new Headers();
		if (input.sessionToken !== null)
			headers.set("Poppy-Session", input.sessionToken);
		if (input.version !== null) headers.set("Poppy-Version", input.version);
		const session = await verify({
			request: new Request(input.url, { method: input.method, headers }),
			audience: `https://${config.data.domain.toLowerCase()}`,
			policy: config.data,
		});
		const now = Date.now();
		if (
			!(await consumePersonalAgentClientRate(db, {
				organizationId: input.organizationId,
				clientId: session.clientId,
				now,
				limit: config.data.requestsPerMinute ?? 60,
			}))
		)
			return { status: "rate_limited" as const };
		const status = await continuePersonalAgentSession(db, {
			organizationId: input.organizationId,
			...session,
			now,
		});
		if (status !== "started" && status !== "accepted") return { status };
		return {
			status: "accepted" as const,
			identity: session,
			...(status === "started" ? { sessionCreated: true } : {}),
		};
	} catch (error) {
		if (error instanceof PersonalAgentSessionFailure)
			return { status: error.code };
		// DB and service failures must remain retryable upstream failures, not a
		// claim that a valid agent's cryptographic proof was wrong.
		throw error;
	}
}
