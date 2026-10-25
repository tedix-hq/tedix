import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	WebPushPreferencesSchema,
	WebPushSubscriptionSchema,
} from "../schemas/web-push";

export const webPushContract = oc
	.route({ tags: ["internal"] })
	.errors(baseErrors)
	.router({
		getStatus: oc.input(z.object({})).output(
			z.object({
				enabled: z.boolean(),
				publicKey: z.string().nullable(),
				preferences: WebPushPreferencesSchema,
			}),
		),
		subscribe: oc
			.input(WebPushSubscriptionSchema)
			.output(z.object({ enabled: z.boolean() })),
		unsubscribe: oc
			.input(z.object({ endpoint: z.string().max(2048) }))
			.output(z.object({ ok: z.literal(true) })),
		setPreferences: oc
			.input(WebPushPreferencesSchema)
			.output(WebPushPreferencesSchema),
		setVisibility: oc
			.input(
				z.object({
					clientId: z.string().uuid(),
					conversationId: z.string().min(1).max(500).nullable(),
				}),
			)
			.output(z.object({ ok: z.literal(true) })),
	});
