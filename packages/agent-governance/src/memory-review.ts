import { hashValue } from "./hash.js";
import { changeStatement } from "./record.js";
import type { ChangeContent } from "./record.js";
import type { Actor, MemoryAdapter, MemoryRevision, Source } from "./types.js";

const string = { type: "string", minLength: 1 };
export const MEMORY_REVIEW_TOOLS = [
	{
		name: "propose_memory",
		description:
			"Propose a memory revision. It stays out of recall until approved.",
		inputSchema: {
			type: "object",
			properties: { key: string, value: {} },
			required: ["key", "value"],
			additionalProperties: false,
		},
	},
	{
		name: "approve_memory",
		description: "Approve a pending memory revision for recall.",
		inputSchema: {
			type: "object",
			properties: { revisionId: string, note: string },
			required: ["revisionId"],
			additionalProperties: false,
		},
	},
	{
		name: "reject_memory",
		description: "Reject a pending memory revision. It never enters recall.",
		inputSchema: {
			type: "object",
			properties: { revisionId: string, note: string },
			required: ["revisionId"],
			additionalProperties: false,
		},
	},
	{
		name: "rollback_memory",
		description:
			"Append a revision restoring a previously approved memory value.",
		inputSchema: {
			type: "object",
			properties: { key: string, toRevisionId: string },
			required: ["key", "toRevisionId"],
			additionalProperties: false,
		},
	},
] as const;

/** Only this approved projection belongs in an agent's retrieval path. */
export async function recallMemory(memory: MemoryAdapter, query = "") {
	const approved = (await memory.list()).flatMap((entry) =>
		entry.approved ? [entry.approved] : [],
	);
	return approved.filter((revision) =>
		JSON.stringify({ key: revision.key, value: revision.value })
			.toLowerCase()
			.includes(query.toLowerCase()),
	);
}

/** The host authenticates and authorizes each tool before supplying this context. */
export function createMemoryReview(
	memory: MemoryAdapter,
	context: { actor: Actor; source: Source; workItemId?: string },
) {
	return async (name: string, args: Record<string, unknown>) => {
		const tool = MEMORY_REVIEW_TOOLS.find((item) => item.name === name);
		if (!tool) throw new Error(`Unknown memory tool ${name}`);
		for (const key of Object.keys(args)) {
			if (!(key in tool.inputSchema.properties))
				throw new Error(`Unexpected argument ${key}`);
		}
		for (const key of tool.inputSchema.required) {
			if (!(key in args)) throw new Error(`Missing argument ${key}`);
		}
		for (const [key, value] of Object.entries(args)) {
			if (key !== "value" && (typeof value !== "string" || !value.trim()))
				throw new Error(`Invalid argument ${key}`);
		}
		const id = crypto.randomUUID();
		const provenance = {
			actor: context.actor,
			source: context.source,
			changeRecordId: id,
		};
		const record: ChangeContent = {
			schemaVersion: 2,
			id,
			recordedAt: new Date().toISOString(),
			resource: "memory:unknown",
			operation: name,
			actor: context.actor,
			source: context.source,
			argsHash: await hashValue(args),
			outcome: "unknown",
			...(context.workItemId
				? { subject: { kind: "work_item", id: context.workItemId } }
				: {}),
		};
		let revision: MemoryRevision | undefined;
		let error: string | undefined;
		try {
			const key = args.key as string | undefined;
			// A review may target an older pending revision, absent from current/approved.
			let target: MemoryRevision | undefined;
			if (name === "approve_memory" || name === "reject_memory") {
				for (const entry of await memory.list()) {
					target = (await memory.history(entry.key)).find(
						(row) => row.revisionId === args.revisionId,
					);
					if (target) break;
				}
				if (!target)
					throw new Error(`Unknown memory revision ${args.revisionId}`);
			}
			record.resource = `memory:${key ?? target!.key}`;
			const prior = await memory.read(key ?? target!.key);
			const before = prior?.approved;
			if (before) {
				record.before = { revisionId: before.revisionId, hash: before.hash };
				record.undo = { kind: "rollback_revision", toRevision: record.before };
			}
			switch (name) {
				case "propose_memory":
					revision = await memory.write({
						key: key!,
						value: args.value,
						provenance,
						review: "pending",
					});
					break;
				case "approve_memory":
				case "reject_memory":
					revision = await memory.review(
						args.revisionId as string,
						name === "approve_memory" ? "approve" : "reject",
						context.actor,
						args.note as string | undefined,
					);
					break;
				case "rollback_memory": {
					const target = (await memory.history(key!)).find(
						(row) => row.revisionId === args.toRevisionId,
					);
					if (target?.review !== "approved")
						throw new Error(
							"Rollback requires an approved revision of this key",
						);
					revision = await memory.rollback(key!, target.revisionId, provenance);
					break;
				}
			}
			record.after = { revisionId: revision!.revisionId, hash: revision!.hash };
			record.outcome = "applied";
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
		return {
			...(revision ? { revision } : {}),
			...(error ? { error } : {}),
			statement: await changeStatement(record),
		};
	};
}
