import * as z from "zod";
import { PersonalAgentSessionRequestSchema } from "./personal-agent-session";

export const PoppyIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const object = z.record(z.string(), z.json());
const PoppyMessageSchema = z
	.looseObject({
		author: z.looseObject({ type: z.string().min(1).max(100) }),
		text: z.string().max(16000).optional(),
		data: object.optional(),
		context: object.optional(),
		extensions: object.optional(),
		as_of_cursor: PoppyIdSchema.optional(),
	})
	.refine((m) =>
		[m.text, m.data, m.context, m.extensions].some((v) => v !== undefined),
	);
export const PoppyPostSchema = z.looseObject({
	id: PoppyIdSchema,
	message: PoppyMessageSchema.optional(),
	parent_conversation_id: PoppyIdSchema.optional(),
	user_requested_event_id: PoppyIdSchema.optional(),
});

/** Only the service-bound edge supplies transport data; identity is verified in API. */
export const PersonalAgentConversationRequestSchema =
	PersonalAgentSessionRequestSchema.extend({
		body: z.json().optional(),
	});
export const PersonalAgentConversationResultSchema = z.object({
	httpStatus: z.number().int().min(200).max(599),
	body: z.json(),
});

/** Verified identity only: never forward Session JWTs or OAuth tokens to runtime. */
export const PoppyRuntimeRequestSchema = z.object({
	organizationId: z.string().min(1),
	identity: z.object({
		clientId: z.string().min(1),
		userId: z.string().min(1),
		version: z.string().min(1),
	}),
	publicInstructions: z.string().max(16000),
	method: z.enum(["GET", "POST"]),
	path: z.string().max(1024),
	cursor: z.string().max(256).nullable(),
	wait: z.number().int().min(0).max(30),
	includeEvents: z.boolean(),
	body: z.json().optional(),
	deskReply: z
		.object({
			conversationId: PoppyIdSchema,
			interactionId: PoppyIdSchema,
			text: z.string().max(16000).nullable(),
		})
		.optional(),
});
