import type {
	RunSteeringMessage,
	RuntimeRunSteeringInput,
} from "@tedix/api-contract/schemas/kernel-runtime";

/** Synchronous DO storage keeps enqueue, read, and Stop mutually exclusive. */
export class HomeRunSteering {
	constructor(
		private readonly storage: {
			get<T>(key: string): T | undefined;
			put<T>(key: string, value: T): void;
		},
	) {}
	control(input: RuntimeRunSteeringInput): RunSteeringMessage[] {
		const key = `home-run-steering:${input.runId}`;
		const messages = this.storage.get<RunSteeringMessage[]>(key) ?? [];
		if (input.action === "inspect") return messages;
		if (input.action === "withdraw") {
			const withdrawn = messages
				.filter((message) => message.status === "queued")
				.map((message) => ({ ...message, status: "withdrawn" as const }));
			this.storage.put(
				key,
				messages.map((message) =>
					message.status === "queued"
						? { ...message, status: "withdrawn" }
						: message,
				),
			);
			return withdrawn;
		}
		const prior = messages.find((message) => message.id === input.id);
		if (prior && prior.content !== input.content)
			throw new Error("Steering id reused with different content");
		if (prior) return messages;
		if (messages.length >= 100)
			throw new Error("Steering limit reached for this run");
		const next: RunSteeringMessage[] = [
			...messages,
			{ id: input.id, content: input.content, status: "queued" },
		];
		this.storage.put(key, next);
		return next;
	}
	read(runId: string): string[] {
		const key = `home-run-steering:${runId}`;
		const messages = this.storage.get<RunSteeringMessage[]>(key) ?? [];
		const queued = messages.filter((message) => message.status === "queued");
		if (queued.length)
			this.storage.put(
				key,
				messages.map((message) =>
					message.status === "queued"
						? { ...message, status: "read" }
						: message,
				),
			);
		return queued.map((message) => message.content);
	}
}
