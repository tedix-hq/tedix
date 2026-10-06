import { computerExecutionModelOutput } from "./computer-execution-model-output";
import { asSchema, type ToolSet } from "ai";
import { codeModeToolModelOutput } from "./codemode-model-output";
import { computerReadToolModelOutput } from "./computer-read-model-output";

export interface FacetToolDescriptor {
	name: string;
	description: string;
	/** JSON Schema for the tool input (via `asSchema(...).jsonSchema`). */
	inputSchema: Record<string, unknown>;
	/** Preserve server-tool approval gates across the parent-to-facet proxy. */
	needsApproval?: boolean;
	/** Preserve Code Mode model projection across persisted facet descriptors. */
	codeModeOutput?: boolean;
	computerReadOutput?: boolean;
	computerExecutionOutput?: boolean;
}

/** Serialize tools for the facet; an invalid schema is excluded fail-soft. */
export function describeFacetTools(tools: ToolSet): FacetToolDescriptor[] {
	const out: FacetToolDescriptor[] = [];
	for (const [name, definition] of Object.entries(tools)) {
		try {
			const schema = asSchema(definition.inputSchema as never).jsonSchema;
			out.push({
				name,
				description:
					typeof definition.description === "string"
						? definition.description
						: "",
				inputSchema: (schema ?? { type: "object" }) as Record<string, unknown>,
				...(definition.needsApproval === true ? { needsApproval: true } : {}),
				...(definition.toModelOutput === codeModeToolModelOutput
					? { codeModeOutput: true }
					: {}),
				...(definition.toModelOutput === computerExecutionModelOutput
					? { computerExecutionOutput: true }
					: {}),
				...(definition.toModelOutput === computerReadToolModelOutput
					? { computerReadOutput: true }
					: {}),
			});
		} catch (error) {
			console.warn(
				"[conversation-facet] tool schema not serializable — excluded from facet turn",
				{
					tool: name,
					error: error instanceof Error ? error.message : String(error),
				},
			);
		}
	}
	return out;
}
