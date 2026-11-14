import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	parseToolPolicyMetadata,
	TEDIX_TOOL_POLICY_META_KEY,
	withDerivedToolOperationalRiskPolicy,
	withoutToolClassDeclaration,
	type ToolWriteCapability,
} from "@tedix/api-contract/schemas/tools";
import { toolClassDeclarationGap } from "@tedix/api-contract/utils/tool-declared-class";

type ToolMeta = Record<string, JsonValue> | null | undefined;

export interface ToolClassSave {
	toolId: string;
	toolTypeId?: string | null;
	/** The write class the row will carry after this save. */
	writeCapability: ToolWriteCapability | null | undefined;
	meta: ToolMeta;
	config?: Record<string, JsonValue> | null;
	/** The caller stated the write class, rather than Tedix deriving it. */
	classStated: boolean;
	/** The caller stated the risk tier, rather than Tedix deriving it. */
	tierStated: boolean;
}

/** Whether metadata carries a complete risk tier of its own. */
export function metaStatesRiskTier(meta: ToolMeta): boolean {
	const policy = parseToolPolicyMetadata(meta);
	return Boolean(policy?.riskTier && policy.blastRadius);
}

/**
 * Decide the class a tool row is saved with, or why the save is refused.
 *
 * Every saved tool needs a write class and, unless it only reads, a risk
 * tier. The row is marked `declared` only when the caller stated both;
 * upstream annotations alone do not establish automatic approval eligibility.
 */
export function resolveToolClassForSave(
	save: ToolClassSave,
): { ok: true; meta: ToolMeta } | { ok: false; reason: string } {
	const raw = save.meta?.[TEDIX_TOOL_POLICY_META_KEY];
	const asksDeclared =
		typeof raw === "object" &&
		raw !== null &&
		!Array.isArray(raw) &&
		raw.declared === true;
	if (!save.writeCapability) {
		if (save.toolTypeId === "prompt" && !asksDeclared)
			return { ok: true, meta: withoutToolClassDeclaration(save.meta) };
		return {
			ok: false,
			reason: `Tool ${save.toolId} has no write class. Set writeCapability to "read", "write" or "destructive", or send annotations that say whether it only reads.`,
		};
	}
	const stated = save.classStated && save.tierStated;
	if (asksDeclared && !stated)
		return {
			ok: false,
			reason: `Tool ${save.toolId} is marked declared, so the same request must state writeCapability and, under _meta["${TEDIX_TOOL_POLICY_META_KEY}"], riskTier and blastRadius.`,
		};
	const gap = toolClassDeclarationGap(save);
	if (gap) return { ok: false, reason: `Tool ${save.toolId} ${gap}.` };
	const meta = withDerivedToolOperationalRiskPolicy({
		meta: stated ? save.meta : withoutToolClassDeclaration(save.meta),
		config: save.config,
		writeCapability: save.writeCapability,
	});
	if (!stated || !metaStatesRiskTier(meta)) return { ok: true, meta };
	const policy = meta?.[TEDIX_TOOL_POLICY_META_KEY] as Record<
		string,
		JsonValue
	>;
	const { writeCapability: _wire, ...rest } = policy;
	return {
		ok: true,
		meta: {
			...meta,
			[TEDIX_TOOL_POLICY_META_KEY]: { ...rest, declared: true },
		},
	};
}
