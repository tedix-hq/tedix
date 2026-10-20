import { deriveToolSchema } from "@/lib/webmcp/derive-schema";
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
				"Save the person's Attention composition when arranging focus, pins, source filters, density or widget order across devices. Read get_attention_layout first and preserve unspecified preferences.",
			annotations: {
				readOnlyHint: false,
				untrustedContentHint: false,
				consequentialHint: true,
			},
			inputSchema: deriveToolSchema(AttentionLayoutSchema, {
				pick: [
					"version",
					"widgets",
					"pinnedProjects",
					"hiddenColumns",
					"focusProjectId",
					"focusToday",
					"density",
					"sourceFilters",
				],
				// Keep the existing output-mode schema's required defaults.
				require: [
					"version",
					"widgets",
					"pinnedProjects",
					"hiddenColumns",
					"focusProjectId",
					"focusToday",
					"density",
					"sourceFilters",
				],
				override: {
					version: { description: "Layout format version; use 1." },
					widgets: {
						description:
							"Widget order using now, contributions, cards, gaps or unfiled; each appears at most once.",
					},
					pinnedProjects: {
						description:
							"Pinned project ids in display order; for example [project-id] from the current layout.",
					},
					hiddenColumns: {
						description:
							"Columns to hide: moving, waiting, blocked, done or backlog; an empty array shows all.",
					},
					focusProjectId: {
						description:
							"Project id to focus, or null for all projects; preserve the current value unless changing focus.",
					},
					focusToday: {
						description:
							"Today's focus text, for example Review supplier replies; an empty string clears it.",
					},
					density: {
						description:
							"comfortable uses spacious rows; compact shows more rows.",
					},
					sourceFilters: {
						description:
							"Allowed source types from the item enum; an empty array includes every source.",
					},
				},
			}),
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
