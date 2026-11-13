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
		getStatus: oc
			.route({ method: "GET" })
			.input(z.object({}))
			.output(
				z.object({
					enabled: z.boolean(),
					publicKey: z.string().nullable(),
					preferences: WebPushPreferencesSchema,
				}),
			),
		subscribe: oc
			.route({ method: "POST" })
			.input(WebPushSubscriptionSchema)
			.output(z.object({ enabled: z.boolean() })),
		unsubscribe: oc
			.route({ method: "DELETE" })
			.input(z.object({ endpoint: z.string().max(2048) }))
			.output(z.object({ ok: z.literal(true) })),
		setPreferences: oc
			.route({ method: "PUT" })
			.input(WebPushPreferencesSchema)
			.output(WebPushPreferencesSchema),
		setVisibility: oc
			.route({ method: "PUT" })
			.input(
				z.object({
					clientId: z.string().uuid(),
					conversationId: z.string().min(1).max(500).nullable(),
				}),
			)
			.output(z.object({ ok: z.literal(true) })),
	});
