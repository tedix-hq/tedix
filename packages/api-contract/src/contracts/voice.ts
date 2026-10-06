import "@orpc/openapi/extensions/route";
/**
 * Voice Contract
 *
 * Runtime-neutral speech utilities for Tedix OS, Home, and tedis. These endpoints
 * own product-level voice behavior above the concrete runtime body.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";

export const SpokenReplySubjectSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("kernel"),
	}),
	z.object({
		type: z.literal("tedi"),
		tediId: z.uuid(),
	}),
]);

export const SynthesizeSpokenReplyInputSchema = z.object({
	subject: SpokenReplySubjectSchema,
	text: z.string().trim().min(1).max(8192),
	voice: z.string().trim().min(1).max(128).optional(),
});

export const SynthesizeSpokenReplyOutputSchema = z.object({
	audioBase64: z.string().min(1),
	mimeType: z.string().min(1),
	provider: z.enum(["azure", "workers-ai"]),
});

export const voiceContract = oc
	.route({ tags: ["voice"], prefix: "/voice" })
	.errors(baseErrors)
	.router({
		synthesizeSpokenReply: oc
			.route({
				method: "POST",
				path: "/spoken-reply",
				summary: "Synthesize one assistant spoken reply",
				description:
					"Runtime-neutral assistant TTS for Tedix OS's Speak affordance. Returns one audio rendition for a tedi or Home/kernel assistant turn; Tedix OS caches it per turn and replays it.",
			})
			.input(SynthesizeSpokenReplyInputSchema)
			.output(SynthesizeSpokenReplyOutputSchema),
	});

export type VoiceContract = typeof voiceContract;
