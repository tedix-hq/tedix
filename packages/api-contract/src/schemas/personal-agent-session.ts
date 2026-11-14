import * as z from "zod";

/** Signed-out resource verification, reachable only over a service binding. */
export const PersonalAgentSessionRequestSchema = z.object({
	organizationId: z.string().min(1),
	appId: z.string().min(1),
	url: z.url({ protocol: /^https$/ }).max(4096),
	method: z.string().min(1).max(32),
	sessionToken: z.string().max(16384).nullable(),
	version: z.string().max(32).nullable(),
});

export const PersonalAgentSessionResultSchema = z.object({
	status: z.enum([
		"not_configured",
		"accepted",
		"invalid_session",
		"session_ended",
		"version_unsupported",
		"rate_limited",
	]),
});
