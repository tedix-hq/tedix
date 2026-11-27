import type { CopyState } from "../../../scripts/db/core-copy.ts";
import {
	CORE_COPY_PLAN,
	CORE_COPY_SKIPPED,
	type CoreCopyPlanEntry,
} from "./plan.generated.ts";

export type { CoreCopyPlanEntry };
export { CORE_COPY_SKIPPED };

/** Plan entry plus the R2 blanking map; structurally a scripts/db CopyTable. */
export interface CoreCopyTable extends CoreCopyPlanEntry {}

export function coreCopyPlan(): CoreCopyTable[] {
	return CORE_COPY_PLAN;
}

export function planTable(name: string): CoreCopyTable | undefined {
	return CORE_COPY_PLAN.find((entry) => entry.table === name);
}

export type { CopyState };
