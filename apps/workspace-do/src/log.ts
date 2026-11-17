/**
 * Diagnostic lines for a workspace object: why a chat socket closed, what a
 * handler caught, and what the object held when it woke. Counts, sizes and
 * identifiers only; never message text, file content or credentials.
 */
import { createLogger } from "@tedix/worker-kit/logger";

export type WorkspaceLogFields = {
	/** The Durable Object id, which Cloudflare's own logs also carry. */
	objectId: string;
	workspaceId: string;
	/** The code path that wrote the line. */
	where: string;
	/** A closed reason class, never free text from a person or a model. */
	reason: string;
	frameType: string;
	closeCode: number;
	wasClean: boolean;
	/** Chat sockets attached to the object. */
	sockets: number;
	/** Turns by stored status. */
	turns: { [status: string]: number };
	latestSeq: number;
	cursor: number;
	replayEvents: number;
	replayBytes: number;
	/** The replay stopped at its size budget; the client asks for the rest. */
	replayMore: boolean;
	historyMessages: number;
	historyBytes: number;
	isolated: boolean;
	interrupted: number;
	retryCount: number;
	durationMs: number;
};

export const workspaceLog = createLogger<WorkspaceLogFields>({
	component: "workspace.object",
});
