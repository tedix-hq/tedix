import {
	AttentionLayoutSchema,
	ATTENTION_LAYOUT_NAMESPACE,
	DEFAULT_ATTENTION_LAYOUT,
} from "@tedix/api-contract/schemas/attention-layout";
import { getUserConfig } from "@tedix/db/queries/user-configs";
import type { DbQueryClient } from "@tedix/db/query-client";

export async function readAttentionLayout(
	db: DbQueryClient,
	userId: string,
	organizationId: string,
) {
	const row = await getUserConfig(db, {
		userId,
		namespace: ATTENTION_LAYOUT_NAMESPACE,
		key: organizationId,
	});
	const parsed = AttentionLayoutSchema.safeParse(row?.value);
	return {
		layout: parsed.success ? parsed.data : DEFAULT_ATTENTION_LAYOUT,
		revision: row?.revision ?? 0,
	};
}
