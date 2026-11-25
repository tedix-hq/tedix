import { InMemoryMemoryAdapter } from "./in-memory.js";
import type {
	Actor,
	MemoryAdapter,
	MemoryProvenance,
	MemoryWriteInput,
} from "./types.js";

export type MemoryMcpCall = (
	name: string,
	args: Record<string, unknown>,
) => Promise<{
	isError?: boolean;
	content?: Array<{ type: string; text?: string }>;
}>;

type Event = { id: string; at: string } & (
	| { operation: "write"; input: MemoryWriteInput }
	| {
			operation: "review";
			revisionId: string;
			decision: "approve" | "reject";
			reviewer: Actor;
			note?: string;
	  }
	| {
			operation: "rollback";
			key: string;
			toRevisionId: string;
			provenance: MemoryProvenance;
	  }
);

/** One private reference-server graph per scope, with a single review writer. */
export class McpMemoryAdapter implements MemoryAdapter {
	private queue: Promise<unknown> = Promise.resolve();
	private readonly entityName: string;

	constructor(
		private readonly call: MemoryMcpCall,
		scope: string,
	) {
		if (!scope.trim()) throw new Error("Memory scope is required");
		this.entityName = `memory-review/v1/${scope}`;
	}

	private async invoke(
		name: string,
		args: Record<string, unknown>,
	): Promise<unknown> {
		const result = await this.call(name, args);
		if (result.isError)
			throw new Error(
				`Memory MCP ${name} failed: ${JSON.stringify(result.content)}`,
			);
		const text = result.content?.find((item) => item.type === "text")?.text;
		if (!text) throw new Error(`Memory MCP ${name} returned no JSON`);
		return JSON.parse(text);
	}

	private async observations(): Promise<string[] | null> {
		const graph = (await this.invoke("open_nodes", {
			names: [this.entityName],
		})) as {
			entities: Array<{
				name: string;
				entityType: string;
				observations: string[];
			}>;
		};
		if (!Array.isArray(graph.entities)) throw new Error("Invalid memory graph");
		const entity = graph.entities.find((item) => item.name === this.entityName);
		if (!entity) return null;
		if (
			entity.entityType !== "memory_review_events_v1" ||
			!Array.isArray(entity.observations)
		) {
			throw new Error("Invalid memory review entity");
		}
		return entity.observations;
	}

	private run<T>(
		operation: (memory: MemoryAdapter) => Promise<T>,
		event?: Event,
	): Promise<T> {
		const pending = this.queue.then(async () => {
			const observations = await this.observations();
			let at = new Date().toISOString();
			const memory = new InMemoryMemoryAdapter(() => new Date(at));
			for (const observation of observations ?? []) {
				const saved = JSON.parse(observation) as Event;
				at = saved.at;
				switch (saved.operation) {
					case "write":
						await memory.write(saved.input);
						break;
					case "review":
						await memory.review(
							saved.revisionId,
							saved.decision,
							saved.reviewer,
							saved.note,
						);
						break;
					case "rollback":
						await memory.rollback(
							saved.key,
							saved.toRevisionId,
							saved.provenance,
						);
						break;
					default:
						throw new Error("Invalid memory review event");
				}
			}
			at = event?.at ?? at;
			const value = await operation(memory);
			if (event) {
				const observation = JSON.stringify(event);
				if (observations === null) {
					await this.invoke("create_entities", {
						entities: [
							{
								name: this.entityName,
								entityType: "memory_review_events_v1",
								observations: [observation],
							},
						],
					});
				} else {
					await this.invoke("add_observations", {
						observations: [
							{ entityName: this.entityName, contents: [observation] },
						],
					});
				}
				// A transport acknowledgment alone is not proof that the event persisted.
				if (!(await this.observations())?.includes(observation))
					throw new Error("Memory event was not persisted");
			}
			return structuredClone(value);
		});
		this.queue = pending.catch(() => undefined);
		return pending;
	}

	write(input: MemoryWriteInput) {
		const snapshot = structuredClone(input);
		return this.run((memory) => memory.write(snapshot), {
			id: crypto.randomUUID(),
			at: new Date().toISOString(),
			operation: "write",
			input: snapshot,
		});
	}
	read(key: string) {
		return this.run((memory) => memory.read(key));
	}
	list(prefix?: string) {
		return this.run((memory) => memory.list(prefix));
	}
	history(key: string) {
		return this.run((memory) => memory.history(key));
	}
	review(
		revisionId: string,
		decision: "approve" | "reject",
		reviewer: Actor,
		note?: string,
	) {
		const snapshot = structuredClone(reviewer);
		return this.run(
			(memory) => memory.review(revisionId, decision, snapshot, note),
			{
				id: crypto.randomUUID(),
				at: new Date().toISOString(),
				operation: "review",
				revisionId,
				decision,
				reviewer: snapshot,
				...(note === undefined ? {} : { note }),
			},
		);
	}
	rollback(key: string, toRevisionId: string, provenance: MemoryProvenance) {
		const snapshot = structuredClone(provenance);
		return this.run((memory) => memory.rollback(key, toRevisionId, snapshot), {
			id: crypto.randomUUID(),
			at: new Date().toISOString(),
			operation: "rollback",
			key,
			toRevisionId,
			provenance: snapshot,
		});
	}
}
