import * as z from "zod";
import {
	AttentionLayoutSchema,
	type AttentionLayout,
} from "@tedix/api-contract/schemas/attention-layout";
import {
	webMcpError,
	webMcpResult,
	type WebMcpToolDef,
} from "@tedix/webmcp-core/model-context";
export interface AttentionController {
	layout: AttentionLayout | null;
	save: (layout: AttentionLayout) => Promise<unknown>;
}
export function buildAttentionWebMcpTools(
	current: () => AttentionController,
): WebMcpToolDef[] {
	return [
		{
			name: "get_attention_layout",
			description:
				"Read the person's current saved Attention composition before editing it.",
			annotations: { readOnlyHint: true, untrustedContentHint: true },
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			execute: async () =>
				current().layout
					? webMcpResult({ layout: current().layout })
					: webMcpError("The layout is still loading."),
		},
		{
			name: "update_attention_layout",
			description:
				"Save the person's Attention layout exactly as the Arrange view controls do. Read get_attention_layout first, preserve unspecified preferences, and change focus, pins, source filters, density or fixed-widget order. Edits appear on screen and across devices.",
			annotations: { readOnlyHint: false, untrustedContentHint: false },
			inputSchema: z.toJSONSchema(AttentionLayoutSchema),
			execute: async (args) => {
				try {
					const parsed = AttentionLayoutSchema.safeParse(args);
					if (!parsed.success) return webMcpError(parsed.error.message);
					if (!current().layout)
						return webMcpError("The layout is still loading.");
					await current().save(parsed.data);
					return webMcpResult({ saved: true, layout: parsed.data });
				} catch (error) {
					return webMcpError(
						error instanceof Error
							? error.message
							: "The layout could not be saved.",
					);
				}
			},
		},
	];
}
