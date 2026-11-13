import { z } from "zod";
import {
	parseToolPolicyMetadata,
	TOOL_BLAST_RADIUS_VALUES,
	TOOL_OPERATIONAL_RISK_TIER_VALUES,
	ToolWriteCapabilitySchema,
	type ToolWriteCapability,
} from "../schemas/tools";

/**
 * The actions that never run on a standing approval, an organization policy
 * or any other automatic approval. A person decides each one, every time.
 *
 * A tool that can do one of these must be declared so: a delete is
 * `writeCapability: "destructive"`, and the other four carry a risk tier above
 * `bounded_write`. {@link declaredAutoApproval} then refuses it whatever the
 * tool is called. This is the only list; gates read the declaration, they do
 * not keep their own copy.
 */
export const NEVER_AUTO_APPROVED_ACTIONS = [
	{
		id: "delete",
		action: "Deleting data",
		declaredAs: 'writeCapability "destructive"',
	},
	{
		id: "external_send",
		action: "Sending a message or file outside the organization",
		declaredAs: 'riskTier "external_side_effect"',
	},
	{
		id: "spend",
		action: "Spending or moving money",
		declaredAs: 'riskTier "external_side_effect" or "high_impact_write"',
	},
	{
		id: "code_execution",
		action: "Running arbitrary code or commands",
		declaredAs: 'riskTier "high_impact_write"',
	},
	{
		id: "sharing_change",
		action: "Changing who can see or use something",
		declaredAs: 'riskTier "high_impact_write"',
	},
] as const;

export const DeclaredToolClassSchema = z.object({
	writeCapability: ToolWriteCapabilitySchema,
	riskTier: z.enum(TOOL_OPERATIONAL_RISK_TIER_VALUES),
	blastRadius: z.enum(TOOL_BLAST_RADIUS_VALUES),
});
/** A write class and risk tier that an owner or reviewed code stated. */
export type DeclaredToolClass = z.infer<typeof DeclaredToolClassSchema>;

interface ClassifiedTool {
	writeCapability?: ToolWriteCapability | null;
	meta?: Record<string, unknown> | null;
	toolTypeId?: string | null;
}

/**
 * The class a stored tool row declares, or null when nobody declared one.
 * Null means "decide from the name as before", never "safe".
 */
export function declaredToolClass(
	tool: ClassifiedTool,
): DeclaredToolClass | null {
	const policy = parseToolPolicyMetadata(tool.meta);
	if (
		policy?.declared !== true ||
		!tool.writeCapability ||
		!policy.riskTier ||
		!policy.blastRadius
	)
		return null;
	return {
		writeCapability: tool.writeCapability,
		riskTier: policy.riskTier,
		blastRadius: policy.blastRadius,
	};
}

/** The declared class of a tool as the MCP gateway lists it (`_meta`). */
export function wireDeclaredToolClass(
	meta: Record<string, unknown> | null | undefined,
): DeclaredToolClass | null {
	return declaredToolClass({
		writeCapability: parseToolPolicyMetadata(meta)?.writeCapability,
		meta,
	});
}

/** A declared class as stored on an approval payload. */
export function parseDeclaredToolClass(
	value: unknown,
): DeclaredToolClass | null {
	const parsed = DeclaredToolClassSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/**
 * Whether a declared tool may run on an automatic approval. Only an ordinary
 * write with a bounded effect may; see {@link NEVER_AUTO_APPROVED_ACTIONS}.
 */
export function declaredAutoApproval(declared: DeclaredToolClass): {
	eligible: boolean;
	reason: string;
} {
	if (declared.writeCapability === "destructive")
		return { eligible: false, reason: "declared destructive" };
	if (declared.writeCapability === "read" || declared.riskTier === "read")
		return { eligible: false, reason: "declared read, not a write" };
	if (declared.riskTier !== "bounded_write")
		return { eligible: false, reason: `declared ${declared.riskTier}` };
	return { eligible: true, reason: "declared bounded write" };
}

/**
 * What a new or changed tool row still has to state, or null when it is
 * complete. Every tool needs a write class; every tool that is not a read
 * also needs a risk tier that fits the class.
 */
export function toolClassDeclarationGap(tool: ClassifiedTool): string | null {
	// A stored prompt is text for the caller; it runs nothing.
	if (tool.toolTypeId === "prompt" && !tool.writeCapability) return null;
	if (!tool.writeCapability)
		return 'has no write class: set writeCapability to "read", "write" or "destructive"';
	const policy = parseToolPolicyMetadata(tool.meta);
	const tier = policy?.riskTier;
	if (tool.writeCapability === "read")
		return tier && tier !== "read"
			? `is declared read but carries risk tier ${tier}`
			: null;
	if (!tier || !policy?.blastRadius)
		return 'has no risk tier: set riskTier and blastRadius under _meta["com.tedix/policy"]';
	if (tier === "read") return "is declared a write but carries risk tier read";
	if (tool.writeCapability === "destructive" && tier === "bounded_write")
		return "is declared destructive but carries risk tier bounded_write";
	return null;
}
