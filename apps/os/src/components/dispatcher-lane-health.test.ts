import { expect, test } from "vite-plus/test";
import { nativeActivityLabel } from "./dispatcher-lane-health";

const now = Date.parse("2026-11-04T20:00:00.000Z");

test("separates old provider progress from dispatcher heartbeats", () => {
	expect(
		nativeActivityLabel(
			{
				state: "provider_waiting",
				observedAt: "2026-11-04T19:55:00.000Z",
			},
			now,
		),
	).toContain("dispatcher heartbeat is separate");
});

test("shows running tools, approval waits, and bounded recovery distinctly", () => {
	expect(
		nativeActivityLabel(
			{
				state: "tool_pending",
				observedAt: "2026-11-04T19:59:50.000Z",
				tool: "shell",
			},
			now,
		),
	).toContain("Tool call pending: shell");
	expect(
		nativeActivityLabel(
			{
				state: "tool_running",
				observedAt: "2026-11-04T19:59:50.000Z",
				tool: "shell",
			},
			now,
		),
	).toContain("Tool running: shell");
	expect(
		nativeActivityLabel(
			{
				state: "approval_wait",
				observedAt: "2026-11-04T19:59:50.000Z",
			},
			now,
		),
	).toContain("Waiting for tool approval");
	expect(
		nativeActivityLabel(
			{
				state: "provider_stalled",
				observedAt: "2026-11-04T19:59:50.000Z",
			},
			now,
		),
	).toContain("fresh recovery scheduled");
});
