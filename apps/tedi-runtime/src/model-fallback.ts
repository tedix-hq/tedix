import { getTediRuntimeGovernance } from "@tedix/db/queries/tedi-runtime-bootstrap";
import {
	ModelFallbackPolicySchema,
	PLATFORM_MODEL_FALLBACK,
} from "@tedix/api-contract/schemas/model-fallback";

export async function loadTediModelFallback(
	db: D1Database,
	tediId: string | undefined,
) {
	if (!tediId) throw new Error("Model fallback requires a tedi identity");
	const row = await getTediRuntimeGovernance(db, tediId);
	if (!row) throw new Error("Model fallback organization is unavailable");
	const metadata =
		typeof row.organizationMetadata === "string"
			? JSON.parse(row.organizationMetadata)
			: row.organizationMetadata;
	return ModelFallbackPolicySchema.parse(
		metadata?.modelFallback ?? PLATFORM_MODEL_FALLBACK,
	);
}
