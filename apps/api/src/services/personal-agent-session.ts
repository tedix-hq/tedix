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

/** Rate bucket shared by every unidentified visitor of one organization. */
const UNIDENTIFIED_RATE_BUCKET = "poppy:unidentified";

const TEDIX_IDENTITY_PATH =
	/^\/poppy-agent\/([a-z0-9][a-z0-9-]{0,127})\/(client|jwks)\.json$/;

/**
 * A tedi's Poppy identity documents live on this Worker's own origin. The
 * verifier's public-URL guard refuses that origin, and a Worker's fetch to
 * its own hostname never reaches its route, so documents there are rendered
 * with the loader the public route uses. Every other client_id keeps the
 * guarded network fetch.
 */
function loadOwnIdentityDocument(env: IdentityHostEnv) {
	return async (url: string): Promise<Record<string, unknown> | null> => {
		const match = TEDIX_IDENTITY_PATH.exec(new URL(url).pathname);
		if (!match) return null;
		return loadPoppyAgentPublicDocument(
			env,
			createDbClient(env.DB),
			match[1]!,
			match[2] as "client" | "jwks",
		);
	};
}

// One verifier per isolate, like its caches; the Worker env is fixed there.
let verifier: ReturnType<typeof createPersonalAgentSessionVerifier> | undefined;
function verifierFor(env: IdentityHostEnv) {
	verifier ??= createPersonalAgentSessionVerifier({
		ownOrigin: new URL(env.API_URL).origin,
		loadOwnDocument: loadOwnIdentityDocument(env),
	});
	return verifier;
}

function jwtSegment(token: string, index: number): Record<string, unknown> {
	try {
		const segment = token.split(".")[index] ?? "";
		const json = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
		const value: unknown = JSON.parse(json);
		return value && typeof value === "object"
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/**
 * A refused Session names only public claim fields next to what this door
 * expected, so an operator can tell a wrong audience, URL, clock or issuer
 * apart. The token, signatures and keys are never logged.
 */
function logRefusal(
	status: string,
	input: z.infer<typeof PersonalAgentSessionRequestSchema>,
	domain: string,
	stage: "proof" | "continuity" = "proof",
) {
	const token = input.sessionToken ?? "";
	const header = jwtSegment(token, 0);
	const claims = jwtSegment(token, 1);
	const target = new URL(input.url);
	target.search = "";
	target.hash = "";
	const str = (value: unknown) =>
		typeof value === "string" ? value.slice(0, 300) : null;
	console.log(
		JSON.stringify({
			_tr: "personal_agent_session_refused",
			status,
			stage,
			organizationId: input.organizationId,
			hasToken: token.length > 0,
			version: input.version,
			typ: str(header.typ),
			alg: str(header.alg),
			hasDelegation: typeof header.poppy_dlg === "string",
			iss: str(claims.iss),
			aud: str(claims.aud),
			expectedAud: `https://${domain.toLowerCase()}`,
			htu: str(claims.htu),
			expectedHtu: target.href,
			htm: str(claims.htm),
			expectedHtm: input.method,
			iatSkewSeconds:
				typeof claims.iat === "number"
					? Math.round(Date.now() / 1000 - claims.iat)
					: null,
			hasAth: claims.ath !== undefined,
		}),
	);
}

/** Verifies identity, then persists continuity; never mints account authority. */
export async function verifySignedOutPersonalAgentSession(
	db: DbClient,
	input: z.infer<typeof PersonalAgentSessionRequestSchema>,
	env: IdentityHostEnv,
) {
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
	// Poppy 1.0 lets an MCP server serve signed-out calls that use no Session
	// claims; they get their own bucket and are never attributed to an agent.
	if (
		input.sessionToken === null &&
		input.version === null &&
		config.data.unidentifiedVisitors === "allow"
	) {
		const allowed = await consumePersonalAgentClientRate(db, {
			organizationId: input.organizationId,
			clientId: UNIDENTIFIED_RATE_BUCKET,
			now: Date.now(),
			limit: config.data.requestsPerMinute ?? 60,
		});
		return allowed
			? { status: "unidentified" as const }
			: { status: "rate_limited" as const };
	}
	try {
		const headers = new Headers();
		if (input.sessionToken !== null)
			headers.set("Poppy-Session", input.sessionToken);
		if (input.version !== null) headers.set("Poppy-Version", input.version);
		const session = await verifierFor(env)({
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
			return {
				status: "rate_limited" as const,
				verifiedClientId: session.clientId,
			};
		const status = await continuePersonalAgentSession(db, {
			organizationId: input.organizationId,
			...session,
			now,
		});
		if (status !== "started" && status !== "accepted") {
			logRefusal(status, input, config.data.domain, "continuity");
			return { status, verifiedClientId: session.clientId };
		}
		return {
			status: "accepted" as const,
			identity: session,
			...(status === "started" ? { sessionCreated: true } : {}),
		};
	} catch (error) {
		if (error instanceof PersonalAgentSessionFailure) {
			logRefusal(error.code, input, config.data.domain);
			return { status: error.code };
		}
		// DB and service failures must remain retryable upstream failures, not a
		// claim that a valid agent's cryptographic proof was wrong.
		throw error;
	}
}
