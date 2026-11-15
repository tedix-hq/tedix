import { PersonalAgentDiscoveryConfigSchema } from "@tedix/api-contract/schemas/organization";
import {
	PersonalAgentFeedbackSchema,
	type PersonalAgentInterfacesRequestSchema,
} from "@tedix/api-contract/schemas/personal-agent-session";
import type { DbClient } from "@tedix/db/client";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { HTTPException } from "hono/http-exception";
import type * as z from "zod";
import { filePersonalAgentFeedback } from "./agent-review";
import { verifySignedOutPersonalAgentSession } from "./personal-agent-session";

export async function personalAgentInterfaces(
	db: DbClient,
	env: CloudflareEnv,
	input: z.infer<typeof PersonalAgentInterfacesRequestSchema>,
) {
	const organization = await getOrganizationById(db, input.organizationId);
	const parsed = PersonalAgentDiscoveryConfigSchema.safeParse(
		organization?.metadata?.personalAgentProtocol,
	);
	if (!parsed.success || !parsed.data.interfaces)
		return { status: "not_configured" as const };
	const config = parsed.data;
	const interfaces = parsed.data.interfaces;
	const base = config.mcpUrl.replace(/\/$/, "");
	const target = new URL(input.url);
	target.search = "";
	const tasks = target.href === `${base}/poppy/tasks` && input.method === "GET";
	const feedback =
		target.href === `${base}/poppy/feedback` && input.method === "POST";
	if (!tasks && !(feedback && interfaces.feedback))
		return { status: "not_configured" as const };
	const session = await verifySignedOutPersonalAgentSession(db, input);
	if (session.status !== "accepted") return session;
	if (tasks)
		return {
			...session,
			excludedTasks: interfaces.excludedTasks,
			...(interfaces.feedback
				? { feedbackEndpoint: `${base}/poppy/feedback` }
				: {}),
		};
	const report = PersonalAgentFeedbackSchema.safeParse(input.report);
	if (!report.success) return { status: "invalid_request" as const };
	try {
		await filePersonalAgentFeedback(db, env, report.data, input.organizationId);
		return session;
	} catch (error) {
		if (error instanceof HTTPException && error.status === 429)
			return { status: "rate_limited" as const };
		// Report contents and provider errors must never enter RPC logs.
		return { status: "unavailable" as const };
	}
}
