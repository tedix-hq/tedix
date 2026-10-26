import type { Submission, SubmissionRecord } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { RunSteeringMessage } from "@tedix/api-contract/schemas/kernel-runtime";
import { FacetTurnGate } from "./facet-turn-gate";

type SteeringReceipt = { id: string; content: string; operationId: string };

/** Receipt index only: Pi owns queue placement, consumption, and withdrawal. */
export class RunSteering {
	private readonly gate = new FacetTurnGate();
	constructor(
		private readonly host: {
			load(runId: string): Promise<SteeringReceipt[]>;
			save(runId: string, receipts: SteeringReceipt[]): Promise<void>;
			assertActive(runId: string): Promise<string>;
			submit(operationId: string, content: string): Promise<void>;
			lookup(
				operationId: string,
			): Promise<
				{ record: SubmissionRecord; submission: Submission } | undefined
			>;
		},
	) {}

	enqueue(
		runId: string,
		id: string,
		content: string,
	): Promise<RunSteeringMessage[]> {
		return this.gate.run(async () => {
			const receipts = await this.host.load(runId);
			const prior = receipts.find((receipt) => receipt.id === id);
			if (prior && prior.content !== content)
				throw new Error("Steering id reused with different content");
			if (prior && (await this.host.lookup(prior.operationId)))
				return this.inspect(runId);
			const root = await this.host.assertActive(runId);
			if (!prior && receipts.length >= 100)
				throw new Error("Steering limit reached for this run");
			const receipt = prior ?? {
				id,
				content,
				operationId: `${root}:steer:${id}`,
			};
			// Index first: a lost response can be reconciled by the same native operation id.
			if (!prior) await this.host.save(runId, [...receipts, receipt]);
			await this.host.submit(receipt.operationId, content);
			return this.inspect(runId);
		});
	}

	async inspect(runId: string): Promise<RunSteeringMessage[]> {
		return Promise.all(
			(await this.host.load(runId)).map(async (receipt) => {
				const found = await this.host.lookup(receipt.operationId);
				const record = found?.record;
				return {
					id: receipt.id,
					content: receipt.content,
					status: !record
						? "failed"
						: record.status === "queued"
							? "queued"
							: record.status === "unanswered" && record.entry === undefined
								? "withdrawn"
								: "read",
				};
			}),
		);
	}

	withdraw(runId: string): Promise<RunSteeringMessage[]> {
		return this.gate.run(async () => {
			const withdrawn: RunSteeringMessage[] = [];
			for (const receipt of await this.host.load(runId)) {
				const found = await this.host.lookup(receipt.operationId);
				// Native abort is atomic: already_placed must never be returned to the draft.
				if (
					found &&
					(await found.submission.abort(BACKGROUND_CONTEXT)) === "aborted"
				) {
					withdrawn.push({
						id: receipt.id,
						content: receipt.content,
						status: "withdrawn",
					});
				}
			}
			return withdrawn;
		});
	}
}
