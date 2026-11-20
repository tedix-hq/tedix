import type {
	RunSteeringMessage,
	RuntimeRunSteeringInput,
} from "@tedix/api-contract/schemas/kernel-runtime";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";

type StoredSteeringMessage = RunSteeringMessage & { sentByPerson?: boolean };

/** Who sent a follow-up stays inside the store. */
const visible = ({
	id,
	content,
	status,
}: StoredSteeringMessage): RunSteeringMessage => ({ id, content, status });

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
		const messages = this.storage.get<StoredSteeringMessage[]>(key) ?? [];
		if (input.action === "inspect") return messages.map(visible);
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
			return withdrawn.map(visible);
		}
		const prior = messages.find((message) => message.id === input.id);
		if (prior && prior.content !== input.content)
			throw new Error("Steering id reused with different content");
		if (prior) return messages.map(visible);
		if (messages.length >= 100)
			throw new Error("Steering limit reached for this run");
		const next: StoredSteeringMessage[] = [
			...messages,
			{
				id: input.id,
				content: input.content,
				status: "queued",
				sentByPerson: input.sentByPerson === true,
			},
		];
		this.storage.put(key, next);
		return next.map(visible);
	}
	/**
	 * Queued follow-ups for the planner. One a signed-in person sent is
	 * returned as written; any other is fenced as outside text.
	 */
	read(runId: string): string[] {
		const key = `home-run-steering:${runId}`;
		const messages = this.storage.get<StoredSteeringMessage[]>(key) ?? [];
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
		return queued.map((message) =>
			message.sentByPerson
				? message.content
				: wrapUntrustedInput(message.content, "operator_steering"),
		);
	}
}
