import * as z from "zod";
import { PersonalAgentExcludedTaskSchema } from "./organization";

/** Signed-out resource verification, reachable only over a service binding. */
export const PersonalAgentSessionRequestSchema = z.object({
	organizationId: z.string().min(1),
	appId: z.string().min(1),
	url: z.url({ protocol: /^https$/ }).max(4096),
	method: z.string().min(1).max(32),
	sessionToken: z.string().max(16384).nullable(),
	version: z.string().max(32).nullable(),
});

const sessionFailureStatus = z.enum([
	"not_configured",
	"invalid_session",
	"session_ended",
	"version_unsupported",
	"rate_limited",
]);

/** Safe attribution returned only over internal service bindings. */
export const PersonalAgentAttributionSchema = z.object({
	clientId: z.url({ protocol: /^https$/ }).max(2048),
	agentId: z.string().min(1).max(512).optional(),
	sessionId: z
		.string()
		.min(1)
		.max(512)
		.regex(/^[A-Za-z0-9_-]+$/),
});
export type PersonalAgentAttribution = z.infer<
	typeof PersonalAgentAttributionSchema
>;

/**
 * A signed-out caller with no Poppy headers, let in by an organization that
 * allows unidentified visitors. It is a label, never an agent identity.
 */
export const UNIDENTIFIED_VISITOR = { kind: "unidentified" } as const;
export type PersonalAgentVisitor =
	| PersonalAgentAttribution
	| typeof UNIDENTIFIED_VISITOR;

export const PersonalAgentSessionResultSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("unidentified") }),
	z.object({
		status: z.literal("accepted"),
		sessionCreated: z.boolean().optional(),
		// Internal verified claims, never an OAuth principal or account grant.
		identity: PersonalAgentAttributionSchema.extend({
			userId: z.string().min(1).max(512),
			version: z.string().regex(/^1\.(0|[1-9][0-9]*)$/),
		}),
	}),
	z.object({
		status: sessionFailureStatus,
		// Attribution only: a verified signature can still fail rate or continuity checks.
		verifiedClientId: PersonalAgentAttributionSchema.shape.clientId.optional(),
	}),
]);

export const PersonalAgentFeedbackSchema = z.object({
	task: z.string().min(1).max(200),
	description: z.string().min(1).max(2000),
});

export const PersonalAgentInterfacesRequestSchema =
	PersonalAgentSessionRequestSchema.extend({
		report: z.json().optional(),
	});

export const PersonalAgentInterfacesResultSchema = z.object({
	status: z.enum([
		...sessionFailureStatus.options,
		"accepted",
		"invalid_request",
		"unavailable",
	]),
	sessionCreated: z.boolean().optional(),
	identity: PersonalAgentAttributionSchema.optional(),
	excludedTasks: z.array(PersonalAgentExcludedTaskSchema).optional(),
	feedbackEndpoint: z.url().optional(),
});
