import {
	IN_TOTO_STATEMENT_TYPE,
	type InTotoStatement,
	recordDigest,
} from "./seal.js";
import type { ChangeRecord } from "./types.js";

export const CHANGE_PREDICATE_TYPE =
	"https://tedix.dev/attestations/change-record/v1";

/** A gateway receipt may expose neither a ledger sequence nor gate evaluation. */
export type ChangeContent = Omit<ChangeRecord, "sequence" | "decision"> & {
	sequence?: number;
	decision?: ChangeRecord["decision"];
};

export interface ChangeStatement extends InTotoStatement {
	predicateType: typeof CHANGE_PREDICATE_TYPE;
	predicate: {
		record: ChangeContent;
		subjectKind: "change_record";
		actor: ChangeRecord["actor"];
		onBehalfOf: null;
		cause: {
			operation: string;
			source: ChangeRecord["source"];
			task: ChangeRecord["subject"] | null;
			parent: ChangeRecord["parent"] | null;
		};
		approval: ChangeRecord["approval"] | null;
		environment: ChangeRecord["environment"] | null;
		time: { recordedAt: string; source: "recorder_clock"; trustedTime: null };
		openFields: Array<{ field: string; reason: string }>;
	};
}

/** Attests the immutable record content, not that a resource change succeeded. */
export async function changeStatement(
	record: ChangeContent,
): Promise<ChangeStatement> {
	const openFields = [
		{
			field: "onBehalfOf",
			reason: "The record does not capture a delegated principal.",
		},
		{
			field: "trustedTime",
			reason: "Recorder time has no independent timestamp authority receipt.",
		},
	];
	if (!record.subject)
		openFields.push({
			field: "task",
			reason: "No Work link was captured for this call.",
		});
	if (!record.parent || Object.keys(record.parent).length === 0)
		openFields.push({
			field: "parent",
			reason: "No run or parent record link was captured.",
		});
	if (!record.environment || Object.keys(record.environment).length === 0)
		openFields.push({
			field: "environment",
			reason: "The recorder did not capture execution environment facts.",
		});
	if (!record.environment?.policyDigest && !record.approval?.policy?.revisionId)
		openFields.push({
			field: "policyVersion",
			reason:
				"Neither a tool policy digest nor a tenant policy revision was captured.",
		});
	if (!record.approval)
		openFields.push({
			field: "approval",
			reason:
				"No approval receipt was captured; an allow verdict is not proof of human approval.",
		});
	if (!record.decision)
		openFields.push({
			field: "decision",
			reason:
				"The gateway execution receipt does not expose its gate evaluation.",
		});
	return {
		_type: IN_TOTO_STATEMENT_TYPE,
		subject: [
			{
				name: `change-record/${record.id}`,
				digest: {
					sha256: await recordDigest(
						record as unknown as Record<string, unknown>,
					),
				},
			},
		],
		predicateType: CHANGE_PREDICATE_TYPE,
		predicate: {
			record,
			subjectKind: "change_record",
			actor: record.actor,
			onBehalfOf: null,
			cause: {
				operation: record.operation,
				source: record.source,
				task: record.subject ?? null,
				parent: record.parent ?? null,
			},
			approval: record.approval ?? null,
			environment: record.environment ?? null,
			time: {
				recordedAt: record.recordedAt,
				source: "recorder_clock",
				trustedTime: null,
			},
			openFields,
		},
	};
}
