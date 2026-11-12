/**
 * The approved merge for a workspace whose object already owns its outputs
 * while the shared database still holds a diverged copy.
 *
 * The object is the authority, so nothing in it is ever changed:
 * - a row on both sides that differs stays as the object has it;
 * - a row only in the object stays;
 * - a row only in the source is added when it is active there and adding it
 *   cannot change what the object serves.
 *
 * A source-only row is left out, and listed with the reason, when it is
 * archived, removed or deleted in the source, when its parent is left out,
 * when it would take a place an object row already holds, or when it is a
 * revision at or after the current revision of an output the object owns.
 * The object appends a revision only while the newest revision is the
 * current one, so a later source revision would block every future save.
 *
 * `import --merge-object-owned` and `reconcile --merge-object-owned` both
 * read this plan; a workspace not named there keeps the ordinary refusals.
 */
import { renderRow, rowKey, type StoredRow } from "./rows";
import { WORKSPACE_TABLES } from "./tables";

export interface MergeRowRef {
	table: string;
	key: string;
}

export interface MergePlan {
	/** Source-only rows to add, per table, in mapping order. */
	add: Map<string, StoredRow[]>;
	/** Rows equal on both sides. */
	duplicates: number;
	/** Rows on both sides that differ; the object's row stays. */
	objectWins: MergeRowRef[];
	/** Source-only rows that are not added, with the reason. */
	notAdded: Array<MergeRowRef & { reason: string }>;
	/** Rows only the object holds; they stay. */
	objectOnly: MergeRowRef[];
}

function inactiveReason(row: StoredRow): string | null {
	if (
		row.status === "archived" ||
		row.status === "removed" ||
		row.status === "deleted"
	)
		return `${row.status} in the source`;
	for (const column of ["removed_at", "deleted_at"])
		if (row[column] !== null && row[column] !== undefined)
			return `${column} is set in the source`;
	return null;
}

/** The provider object a resource row points at; unique per workspace. */
function resourceTarget(row: StoredRow): string {
	return [
		"provider_id",
		"connection_scope",
		"personal_owner_user_id",
		"connection_instance_id",
		"resource_type",
		"provider_resource_id",
	]
		.map((column) => String(row[column] ?? ""))
		.join("\n");
}

export function planObjectOwnedMerge(
	bundle: ReadonlyMap<string, StoredRow[]>,
	object: ReadonlyMap<string, StoredRow[]>,
): MergePlan {
	const plan: MergePlan = {
		add: new Map(),
		duplicates: 0,
		objectWins: [],
		notAdded: [],
		objectOnly: [],
	};
	const objectOutputs = new Map(
		(object.get("os_outputs") ?? []).map((row) => [String(row.id), row]),
	);
	const objectRevisions = object.get("os_output_revisions") ?? [];
	const revisionNumber = new Map(
		objectRevisions.map((row) => [String(row.id), Number(row.revision)]),
	);
	const takenRevisions = new Set(
		objectRevisions.map((row) => `${row.output_id}\n${row.revision}`),
	);
	const objectResources = object.get("os_workspace_resources") ?? [];
	const takenSlots = new Set(
		objectResources
			.filter((row) => row.slot !== null && row.slot !== undefined)
			.map((row) => String(row.slot)),
	);
	const takenTargets = new Set(objectResources.map(resourceTarget));
	const addedOutputs = new Set<string>();
	const leftOutConversations = new Set<string>();

	const whyNot = (table: string, row: StoredRow): string | null => {
		const inactive = inactiveReason(row);
		if (inactive) return inactive;
		if (table === "os_output_revisions") {
			const outputId = String(row.output_id);
			if (addedOutputs.has(outputId)) return null;
			const output = objectOutputs.get(outputId);
			if (!output) return "its output is not added";
			const current = revisionNumber.get(String(output.current_revision_id));
			if (current === undefined || Number(row.revision) >= current)
				return `revision ${row.revision} is not older than the object's current revision ${current ?? "(none)"}`;
			if (takenRevisions.has(`${outputId}\n${row.revision}`))
				return `the object already holds revision ${row.revision} of this output`;
		}
		if (table === "os_workspace_resources") {
			if (
				row.slot !== null &&
				row.slot !== undefined &&
				takenSlots.has(String(row.slot))
			)
				return `the object already fills slot ${row.slot}`;
			if (takenTargets.has(resourceTarget(row)))
				return "the object already links this resource under another id";
		}
		if (
			table !== "kernel_conversations" &&
			leftOutConversations.has(String(row.conversation_id))
		)
			return "its conversation is not added";
		return null;
	};

	for (const mapping of WORKSPACE_TABLES) {
		const existing = new Map(
			(object.get(mapping.table) ?? []).map((row) => [
				rowKey(row, mapping.primaryKey),
				row,
			]),
		);
		const bundled = new Set<string>();
		const missing: StoredRow[] = [];
		for (const row of bundle.get(mapping.table) ?? []) {
			const key = rowKey(row, mapping.primaryKey);
			bundled.add(key);
			const previous = existing.get(key);
			if (previous) {
				const carried = Object.fromEntries(
					Object.keys(row).map((column) => [column, previous[column] ?? null]),
				);
				if (renderRow(carried) === renderRow(row)) plan.duplicates += 1;
				else plan.objectWins.push({ table: mapping.table, key });
				continue;
			}
			const reason = whyNot(mapping.table, row);
			if (reason) {
				plan.notAdded.push({ table: mapping.table, key, reason });
				if (mapping.table === "kernel_conversations")
					leftOutConversations.add(String(row.conversation_id));
				continue;
			}
			if (mapping.table === "os_outputs") addedOutputs.add(String(row.id));
			missing.push(row);
		}
		plan.add.set(mapping.table, missing);
		for (const key of existing.keys())
			if (!bundled.has(key))
				plan.objectOnly.push({ table: mapping.table, key });
	}
	return plan;
}
