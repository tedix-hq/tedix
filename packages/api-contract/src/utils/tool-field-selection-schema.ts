import type { ToolJsonSchema } from "../schemas/tools";

const FIELD_SELECTION_SCHEMA = {
	type: "array",
	items: { type: "string", minLength: 1 },
	description:
		"Reserved runtime argument: return only these dotted response paths (for example data.id and data.title). Arrays retain their structure; missing paths are omitted. Applied before result limits and storage. An empty array selects no fields.",
} as const;

export function withFieldSelectionSchema(
	schema: ToolJsonSchema,
): ToolJsonSchema {
	return {
		...schema,
		properties: { ...schema.properties, _fields: FIELD_SELECTION_SCHEMA },
	};
}
