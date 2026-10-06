import type {
	AgentEvent,
	EntryRecord,
	Harness,
	UserInput,
} from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import type { SessionMessage } from "agents/sessions";

export type PiContext = Parameters<Harness["close"]>[0];
export interface ChatOptions {
	requestId?: string;
	metadata?: Record<string, unknown>;
}
export interface PiSubmissionInspection {
	submissionId: string;
	status: "completed" | "failed";
	messageId?: string;
	error?: string;
}
export interface PiApplicationProjection {
	/** Fail closed on unsupported parts; never erase tool or image history. */
	input(message: string | SessionMessage): Promise<UserInput>;
	/** Native passive import, retaining every model message contributed by the row. */
	legacy(message: SessionMessage): Promise<EntryRecord["model"]>;
	message(entry: EntryRecord): SessionMessage | null;
	/** UI transport frames only: this must not drive or settle the native run. */
	event(event: AgentEvent): readonly Record<string, unknown>[];
	/** Existing Tedix model-adapter/provider wrapper, including dispatch accounting. */
	models(): Models;
}
