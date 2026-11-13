import type { ReconcileReport } from "./reconcile";
import { refKey, type Scope } from "./scope";
import { SNAPSHOT_MAX_AGE_MS } from "./snapshot-proof";
import { WORKSPACE_TABLES } from "./tables";
import type { WorkspaceStoreFactory } from "./target";

export interface ActivationResult {
	organizationId: string;
	workspaceId: string;
	receipt: unknown;
}

/** Preflight the entire selected set before the first activation; each object fences its write. */
export async function activateAll(
	report: ReconcileReport,
	stores: WorkspaceStoreFactory,
	reconciliationRef: string,
	scope?: Scope,
	now = new Date(),
	onActivated?: (result: ActivationResult) => void,
): Promise<ActivationResult[]> {
	const checkedAt = Date.parse(report.checkedAt);
	const frozenAt = Date.parse(report.freeze?.frozenAt ?? "");
	if (
		stores.kind !== "remote" ||
		!reconciliationRef.trim() ||
		!report.ok ||
		report.problems.length ||
		!report.freeze?.evidenceRef.trim() ||
		!Number.isFinite(checkedAt) ||
		!Number.isFinite(frozenAt) ||
		frozenAt > checkedAt ||
		checkedAt > now.getTime() ||
		now.getTime() - checkedAt > SNAPSHOT_MAX_AGE_MS ||
		WORKSPACE_TABLES.some(
			(mapping) =>
				!report.totals.some(
					(t) => t.table === mapping.table && t.source === t.bundled,
				),
		)
	)
		throw new Error(
			"Activation requires a fresh, clean frozen reconciliation with snapshot coverage",
		);
	const selected = report.workspaces.filter((w) => !scope || scope.includes(w));
	if (
		!selected.length ||
		(scope && selected.length !== scope.keys.size) ||
		new Set(selected.map(refKey)).size !== selected.length
	)
		throw new Error("Activation scope must name exactly reconciled workspaces");
	for (const w of selected) {
		if (
			!w.ok ||
			w.drift.length ||
			w.problems.length ||
			w.expectedRereads.length ||
			w.jurisdiction !== "eu" ||
			!Number.isSafeInteger(w.importGeneration) ||
			(w.importGeneration ?? -1) < (w.outputAuthority === "object" ? 0 : 1) ||
			(w.outputAuthority !== "object" && w.outputAuthority !== "shared")
		)
			throw new Error(`Workspace ${refKey(w)} is not cleanly reconciled`);
		const store = await stores.open(w);
		try {
			const current = await store.describe();
			if (
				!store.activate ||
				current.organizationId !== w.organizationId ||
				current.workspaceId !== w.workspaceId ||
				current.jurisdiction !== "eu" ||
				(current.outputAuthority !== w.outputAuthority &&
					current.outputAuthority !== "object") ||
				current.importGeneration !== w.importGeneration
			)
				throw new Error(`Import changed for ${refKey(w)}; reconcile again`);
		} finally {
			await store.close();
		}
	}
	const receipts = [];
	for (const w of selected) {
		const store = await stores.open(w);
		try {
			const receipt =
				w.outputAuthority === "object"
					? {
							status: "already_object_owned",
							importGeneration: w.importGeneration,
						}
					: await store.activate!({
							importGeneration: w.importGeneration!,
							reconciliationRef,
						});
			const result = {
				organizationId: w.organizationId,
				workspaceId: w.workspaceId,
				receipt,
			};
			receipts.push(result);
			onActivated?.(result);
			const current = await store.describe();
			if (
				current.outputAuthority !== "object" ||
				current.importGeneration !== w.importGeneration
			)
				throw new Error(`Activation readback failed for ${refKey(w)}`);
		} finally {
			await store.close();
		}
	}
	return receipts;
}
