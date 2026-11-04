import { tool, type ToolSet } from "ai";
import * as z from "zod";
import { RpcCallError } from "@tedix/api-client/internal";
import { scrubText } from "@tedix/context-core/trace-safety";
import type {
	PlatformClient,
	StewardWorkInspection,
	StewardWorkInput,
} from "./brain/platform-client";
import {
	StewardCloseoutTargetsSchema,
	type StewardCloseoutTargets,
} from "@tedix/api-contract/schemas/work-items";

function safeFailureReason(error: unknown): string {
	let message = "Work API is unavailable";
	if (error instanceof RpcCallError) {
		message = `Work API rejected the request (HTTP ${error.status})`;
		try {
			const body: unknown = JSON.parse(error.detail);
			if (
				body &&
				typeof body === "object" &&
				"message" in body &&
				typeof body.message === "string"
			)
				message = body.message;
		} catch {
			// HTTP bodies and transport diagnostics are not public tool messages.
		}
	} else if (error instanceof Error) message = error.message;
	return scrubText(message).replace(/\s+/g, " ").trim().slice(0, 300);
}

/** No public MCP mount and no ambient Work write credential. The API rechecks
 * the persisted Home tuple, requesting owner, project, policy, and settled SHA. */
export function delegatedWorkTools(input: {
	getPlatform: () => Promise<PlatformClient | null>;
	homeRunId: string;
	runId: string;
	linkedWorkItemId: string;
	stewardCloseoutTargets?: StewardCloseoutTargets;
}) {
	const targets = input.stewardCloseoutTargets
		? StewardCloseoutTargetsSchema.parse(input.stewardCloseoutTargets)
		: undefined;
	const completionStarted = new Map<string, string>();
	function boundInput(id: string) {
		const target = targets?.find((candidate) => candidate.id === id);
		if (!target) throw new Error("Work item is not an approved steward target");
		return {
			id,
			nativeStewardCloseout: {
				homeRunId: input.homeRunId,
				runId: input.runId,
				linkedWorkItemId: input.linkedWorkItemId,
				expectedWorkItemVersion: target.expectedWorkItemVersion,
			},
		};
	}
	function matchesReceipt(
		result: StewardWorkInspection,
		bound: StewardWorkInput,
		receiptId: string,
	) {
		const version = bound.nativeStewardCloseout.expectedWorkItemVersion;
		return (
			result.workItem.id === bound.id &&
			result.workItem.disposition === "completed" &&
			result.workItem.version === version + 1 &&
			result.comments.some(
				(comment) =>
					comment.id === receiptId &&
					comment.workItemId === bound.id &&
					comment.metadata?.source === "native-steward-closeout.v1" &&
					comment.metadata.homeRunId === input.homeRunId &&
					comment.metadata.childRunId === input.runId &&
					comment.metadata.linkedWorkItemId === input.linkedWorkItemId &&
					comment.metadata.targetWorkItemVersion === version,
			)
		);
	}
	async function platformClient() {
		const platform = await input.getPlatform();
		if (!platform) throw new Error("Tedi platform identity is unavailable");
		return platform;
	}
	return {
		...(targets
			? {
					read_steward_work: tool({
						description:
							"Inspect one approved steward Work target and its latest Attempt. This does not complete Work or approve evidence.",
						inputSchema: z.strictObject({ id: z.uuid() }),
						execute: async ({ id }) => {
							const bound = boundInput(id);
							return (await platformClient()).inspectStewardWork(bound);
						},
					}),
					complete_steward_work: tool({
						description:
							"Complete one approved steward Work target. The server verifies its latest successful Attempt, delivery and current version. An unknown response requires receipt readback; never repeat a completion write.",
						inputSchema: z.strictObject({ id: z.uuid() }),
						needsApproval: true,
						execute: async ({ id }) => {
							const bound = boundInput(id);
							const receiptId = `${input.homeRunId}:steward-closeout:${id}:v${bound.nativeStewardCloseout.expectedWorkItemVersion}`;
							const failure = (reason: string) => ({
								status: completionStarted.has(id) ? "unknown" : "blocked",
								workItemId: id,
								receiptId,
								message: completionStarted.has(id)
									? `Completion may have committed. No completion write was repeated. ${reason}`
									: `No completion was sent. ${reason}`,
							});
							let platform: PlatformClient;
							try {
								platform = await platformClient();
							} catch (error) {
								return failure(
									completionStarted.get(id) ?? safeFailureReason(error),
								);
							}
							const version =
								bound.nativeStewardCloseout.expectedWorkItemVersion;
							let current: StewardWorkInspection;
							try {
								current = await platform.inspectStewardWork(bound);
							} catch (error) {
								return failure(
									completionStarted.get(id) ?? safeFailureReason(error),
								);
							}
							if (matchesReceipt(current, bound, receiptId))
								return current.workItem;
							if (
								!completionStarted.has(id) &&
								current.workItem.id === id &&
								current.workItem.disposition === "accepted" &&
								current.workItem.version === version
							) {
								completionStarted.set(id, "Completion response is unavailable");
								try {
									return await platform.completeStewardWork(bound);
								} catch (error) {
									// The write may have committed; only a matching receipt resolves it.
									completionStarted.set(id, safeFailureReason(error));
								}
								try {
									const result = await platform.inspectStewardWork(bound);
									if (matchesReceipt(result, bound, receiptId))
										return result.workItem;
								} catch {
									// Read failure leaves the write outcome unknown; it does not authorize resend.
								}
							}
							return failure(
								completionStarted.get(id) ??
									"Work no longer matches the approved accepted version and no matching receipt was found",
							);
						},
					}),
				}
			: {}),
		close_completed_work_item: tool({
			description:
				"Complete one accepted coding Work item and add a one-line closing SHA comment, only in the project explicitly requested by Home. First inspect its latest settled successful Attempt and verify the full SHA is on origin/main. Failed/partial work, active Attempts, other projects and this delegation's own Work are forbidden. Home manages this delegation's lifecycle.",
			inputSchema: z.object({
				id: z.string().uuid(),
				sha: z.string().regex(/^[a-f\d]{40}$/i),
			}),
			needsApproval: true,
			execute: async ({ id, sha }) => {
				const platform = await input.getPlatform();
				if (!platform) throw new Error("Tedi platform identity is unavailable");
				return platform.closeoutDelegatedWorkItem({
					id,
					sha,
					homeRunId: input.homeRunId,
					runId: input.runId,
					linkedWorkItemId: input.linkedWorkItemId,
				});
			},
		}),
	} satisfies ToolSet;
}
