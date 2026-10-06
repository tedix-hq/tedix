/** Parent-owned evidence at the boundary before a facet tool can cause effects. */
export interface RejectedFacetDispatch {
	rejectedBeforeDispatch: true;
	terminal: true;
	tool: string;
}

export interface ReturnedFacetDispatch {
	kind: "facet_tool_returned";
	terminal: true;
	tool: string;
	finishReason: string;
	resultLost: true;
}

interface DispatchReceipt {
	runId: string;
	toolCallId: string;
	tool: string;
	inputHash: string;
	status: "dispatched" | "rejected" | "returned";
	finishReason?: string;
}

type Storage = Pick<DurableObjectStorage, "get" | "put" | "transaction">;
type Call = { runId: string; toolCallId: string; tool: string; args: unknown };

const runKey = (runId: string) => `facet-dispatch-run:${JSON.stringify(runId)}`;
const callKey = (runId: string, callId: string) =>
	`facet-dispatch-call:${JSON.stringify([runId, callId])}`;

export class FacetDispatchJournal {
	constructor(private readonly storage: Storage) {}

	/** Only a run with no accounting attempts may enroll. Rebinding is not enrollment. */
	async enroll(runId: string): Promise<void> {
		await this.storage.put(runKey(runId), true);
	}

	async claim(call: Call, available: boolean): Promise<boolean> {
		const inputHash = await this.inputHash(call);
		return this.storage.transaction(async (tx) => {
			// Missing evidence is never proof of non-dispatch, including older runs.
			if ((await tx.get(runKey(call.runId))) !== true) return false;
			const key = callKey(call.runId, call.toolCallId);
			const previous = await tx.get<DispatchReceipt>(key);
			if (previous) {
				if (
					previous.runId !== call.runId ||
					previous.toolCallId !== call.toolCallId ||
					previous.tool !== call.tool ||
					previous.inputHash !== inputHash
				)
					throw new Error("Conflicting facet tool-call identity");
				// Neither a late rejection nor a rebuilt registry may replay this call.
				return false;
			}
			await tx.put<DispatchReceipt>(key, {
				runId: call.runId,
				toolCallId: call.toolCallId,
				tool: call.tool,
				inputHash,
				status: available ? "dispatched" : "rejected",
			});
			return available;
		});
	}

	/** A returned tool is never replayed when its provider output was lost. */
	async markReturned(call: Call, finishReason: string): Promise<void> {
		const inputHash = await this.inputHash(call);
		await this.storage.transaction(async (tx) => {
			const key = callKey(call.runId, call.toolCallId);
			const previous = await tx.get<DispatchReceipt>(key);
			if (
				!previous ||
				previous.runId !== call.runId ||
				previous.toolCallId !== call.toolCallId ||
				previous.tool !== call.tool ||
				previous.inputHash !== inputHash ||
				previous.status === "rejected"
			)
				throw new Error("Missing or conflicting facet dispatch receipt");
			if (previous.status === "returned") {
				if (previous.finishReason !== finishReason)
					throw new Error("Conflicting facet terminal receipt");
				return;
			}
			await tx.put<DispatchReceipt>(key, {
				...previous,
				status: "returned",
				finishReason,
			});
		});
	}

	async returned(
		runId: string,
		toolCallId: string,
	): Promise<ReturnedFacetDispatch | null> {
		const receipt = await this.storage.get<DispatchReceipt>(
			callKey(runId, toolCallId),
		);
		if (!receipt || receipt.status !== "returned") return null;
		if (
			receipt.runId !== runId ||
			receipt.toolCallId !== toolCallId ||
			!receipt.finishReason
		)
			throw new Error("Conflicting facet terminal receipt");
		return {
			kind: "facet_tool_returned",
			terminal: true,
			tool: receipt.tool,
			finishReason: receipt.finishReason,
			resultLost: true,
		};
	}

	private async inputHash(call: Call): Promise<string> {
		const bytes = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(JSON.stringify([call.tool, call.args])),
		);
		return Array.from(new Uint8Array(bytes), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");
	}

	async rejected(
		runId: string,
		toolCallId: string,
		hasDispatchedEffect: () => Promise<boolean>,
	): Promise<RejectedFacetDispatch | null> {
		const receipt = await this.storage.get<DispatchReceipt>(
			callKey(runId, toolCallId),
		);
		if (!receipt || receipt.status !== "rejected") return null;
		if (receipt.runId !== runId || receipt.toolCallId !== toolCallId)
			throw new Error("Conflicting facet dispatch receipt");
		if (await hasDispatchedEffect())
			throw new Error("Conflicting facet execution and rejection evidence");
		return { rejectedBeforeDispatch: true, terminal: true, tool: receipt.tool };
	}
}
