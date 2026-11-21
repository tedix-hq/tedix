import type {
	ChangeRecord,
	MemoryRevision,
} from "@tedix/agent-governance/types";
import { wrapBinding } from "@tedix/agent-governance/wrap-binding";
import type { BindingDeps } from "./bindings";

export function buildMemoryBinding(
	deps: Pick<
		BindingDeps,
		| "memory"
		| "actor"
		| "source"
		| "compliance"
		| "accountability"
		| "onRecorded"
	>,
) {
	const adapter = () => {
		if (!deps.memory) throw new Error("Workspace memory is unavailable");
		return deps.memory;
	};
	const provenance = () => ({ actor: deps.actor, source: deps.source });
	const write = {
		riskTier: "bounded_write" as const,
		blastRadius: "single_resource" as const,
		after: async (_args: unknown[], result: unknown) => ({
			revisionId: (result as MemoryRevision).revisionId,
		}),
		afterRecorded: async (result: unknown, record: ChangeRecord) => {
			adapter().recordChange(result as MemoryRevision, record.id);
		},
	};
	return wrapBinding(
		{
			write: (input: { key: string; value: unknown }) =>
				adapter().write({
					key: input.key,
					value: input.value,
					provenance: provenance(),
				}),
			read: (key: string) => adapter().read(key),
			list: (prefix?: string) => adapter().list(prefix),
			history: (key: string) => adapter().history(key),
			review: (input: {
				revisionId: string;
				decision: "approve" | "reject";
				note?: string;
			}) => {
				if (input.decision !== "approve" && input.decision !== "reject")
					throw new Error("Memory review decision must be approve or reject");
				return adapter().review(
					input.revisionId,
					input.decision,
					deps.actor,
					input.note,
				);
			},
			rollback: (input: { key: string; toRevisionId: string }) =>
				adapter().rollback(input.key, input.toRevisionId, provenance()),
		},
		{
			compliance: deps.compliance,
			accountability: deps.accountability,
			actor: deps.actor,
			source: deps.source,
			onRecorded: deps.onRecorded,
			resource: "memory",
			methods: {
				write,
				read: { riskTier: "read", blastRadius: "none" },
				list: { riskTier: "read", blastRadius: "none" },
				history: { riskTier: "read", blastRadius: "none" },
				review: write,
				rollback: write,
			},
		},
	);
}
