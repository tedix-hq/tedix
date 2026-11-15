import {
	createPersonalAgentSessionVerifier,
	PersonalAgentSessionFailure,
} from "@tedix/auth/personal-agent-session";
import { PersonalAgentDiscoveryConfigSchema } from "@tedix/api-contract/schemas/organization";
import type { PersonalAgentSessionRequestSchema } from "@tedix/api-contract/schemas/personal-agent-session";
import type * as z from "zod";
import type { DbClient } from "@tedix/db/client";
import { getAppByIdForOrganization } from "@tedix/db/queries/app-records";
import {
	getOrganizationById,
	isOrganizationOffboarding,
} from "@tedix/db/queries/organizations";
import {
	consumePersonalAgentClientRate,
	continuePersonalAgentSession,
} from "@tedix/db/queries/personal-agent-sessions";

const verify = createPersonalAgentSessionVerifier();

/** Verifies identity, then persists continuity; never mints account authority. */
export async function verifySignedOutPersonalAgentSession(
	db: DbClient,
	input: z.infer<typeof PersonalAgentSessionRequestSchema>,
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
