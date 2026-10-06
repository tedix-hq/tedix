import { describe, expect, test } from "vite-plus/test";
import { recoveryDiagnosticFromAdminFetch } from "./recovery-diagnostic";
const snapshot = {
	ok: true,
	runtime: "pi",
	sessionKey: "exact-session",
	sampledAt: "2026-10-04T12:00:00.000Z",
	conversationId: 1,
	scheduling: "paused",
	operation: null,
	tasks: [],
	submissions: [],
	taskCount: 0,
	submissionCount: 0,
	truncated: false,
};
describe("native recovery diagnostic transport", () => {
	test("strips unapproved runtime fields", () => {
		const result = recoveryDiagnosticFromAdminFetch(
			{
				ok: true,
				status: 200,
				json: { ...snapshot, privateCheckpoint: "SECRET" },
			},
			"exact-session",
		);
		expect(result).toEqual(snapshot);
		expect(JSON.stringify(result)).not.toContain("SECRET");
	});
	test("rejects other sessions, operations and failed transport", () => {
		for (const response of [
			{ ok: true, status: 200, json: { ...snapshot, sessionKey: "different" } },
			{ ok: true, status: 200, json: { ...snapshot, scheduling: "invented" } },
			{ ok: true, status: 200, json: {} },
			{ ok: false, status: 503, json: null },
			{ error: "SECRET transport https://internal.invalid" },
		])
			expect(() =>
				recoveryDiagnosticFromAdminFetch(response, "exact-session"),
			).toThrow();
		expect(() =>
			recoveryDiagnosticFromAdminFetch(
				{ ok: true, status: 200, json: snapshot },
				"exact-session",
				"missing-operation",
			),
		).toThrow();
	});
	test("requires the exact operation and conversation owner", () => {
		const operation = {
			id: 2,
			conversationId: 1,
			operationId: "operation",
			type: "input",
			status: "done",
		};
		const result = { ok: true, status: 200, json: { ...snapshot, operation } };
		expect(
			recoveryDiagnosticFromAdminFetch(result, "exact-session", "operation")
				.operation,
		).toEqual(operation);
		expect(() =>
			recoveryDiagnosticFromAdminFetch(result, "exact-session", "different"),
		).toThrow();
		expect(() =>
			recoveryDiagnosticFromAdminFetch(result, "exact-session"),
		).toThrow();
		expect(() =>
			recoveryDiagnosticFromAdminFetch(
				{
					...result,
					json: { ...snapshot, operation: { ...operation, conversationId: 2 } },
				},
				"exact-session",
				"operation",
			),
		).toThrow();
	});
});

test("rejects queued submission metadata owned by a different conversation", () => {
	const alien = {
		id: 3,
		conversationId: 2,
		operationId: "other",
		type: "input",
		status: "queued",
	};
	expect(() =>
		recoveryDiagnosticFromAdminFetch(
			{
				ok: true,
				status: 200,
				json: { ...snapshot, submissions: [alien], submissionCount: 1 },
			},
			"exact-session",
		),
	).toThrow("unexpected payload");
});
