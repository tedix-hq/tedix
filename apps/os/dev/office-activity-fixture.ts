import { ListOfficeActivityResultSchema } from "@tedix/api-contract/schemas/office-activity";

export function officeActivityFixture() {
	const at = new Date().toISOString();
	return ListOfficeActivityResultSchema.parse({
		observedAt: at,
		retainedSince: new Date(Date.now() - 86_400_000).toISOString(),
		nextBefore: null,
		rows: [
			{
				id: "00000001-0000-4000-8000-000000000001",
				at,
				source: "hook",
				host: "claude-code",
				sessionKey: "claude-code:example-session",
				trigger: "Stop",
				outcome: "observed",
				reason: "reported",
				reportedState: "done",
				reporterVersion: "0.19.3",
				occurrences: 4,
				workItemId: null,
			},
			{
				id: "00000001-0000-4000-8000-000000000002",
				at,
				source: "supervisor",
				host: "codex",
				sessionKey: "codex:example-session",
				trigger: "reply_drain",
				outcome: "unknown",
				reason: "queue_unconfirmed",
				reporterVersion: "0.19.3",
				workItemId: null,
				requestId: "000000a7-0000-4000-8000-000000000001",
			},
		],
		canonical: [
			{
				id: "example-saved",
				at,
				source: "reply",
				host: "codex",
				sessionKey: "codex:example-session",
				stage: "saved",
				workItemId: null,
				attemptId: null,
				requestId: "000000a7-0000-4000-8000-000000000001",
				resultRecorded: false,
			},
			{
				id: "example-work",
				at,
				source: "work",
				host: null,
				sessionKey: "claude-code:example-session",
				stage: "work_closed",
				workItemId: "00000070-0000-4000-8000-000000000001",
				attemptId: null,
				requestId: null,
				resultRecorded: true,
			},
		],
	});
}
