import { describe, expect, it } from "vite-plus/test";
import {
	machineActionsFromEvents,
	machineDiffLines,
	summarizeMachineActions,
} from "./machine-activity";

const fenced = (text: string) =>
	`<<<external_machine_tool>>>\n${text}\n<<<end_external_machine_tool>>>`;

describe("machineActionsFromEvents", () => {
	it("pairs a call's start and end, reads a cut result and fills a waiting call later", () => {
		const long = JSON.stringify({
			kind: "machine_tool_result",
			machine: "studio-mac",
			tool: "read_file",
			status: "done",
			result: fenced(`1\t# Title "quoted"\n${"x".repeat(2_000)}`),
		});
		const actions = machineActionsFromEvents([
			{
				id: "run:native-tool.a.started",
				kind: "tool.started",
				payload: {
					name: "read_machine_file",
					arguments: {
						machine: "studio-mac",
						path: "README.md",
						startLine: 1,
						endLine: 40,
					},
				},
			},
			{
				id: "run:native-tool.a.completed",
				kind: "tool.completed",
				payload: {
					name: "read_machine_file",
					ok: true,
					resultPreview: {
						truncated: true,
						originalChars: long.length,
						preview: long.slice(0, 1_024),
					},
				},
			},
			{
				id: "run:native-tool.b.started",
				kind: "tool.started",
				payload: {
					name: "run_machine_command",
					arguments: { machine: "studio-mac", command: "bun test" },
				},
			},
			{
				id: "run:native-tool.b.completed",
				kind: "tool.completed",
				payload: {
					name: "run_machine_command",
					ok: true,
					resultPreview: {
						kind: "machine_tool_pending",
						callId: "call-1",
						machine: "studio-mac",
						tool: "run_command",
						status: "claimed",
					},
				},
			},
			{
				id: "run:native-tool.c.started",
				kind: "tool.started",
				payload: {
					name: "read_machine_tool_result",
					arguments: { callId: "call-1" },
				},
			},
			{
				id: "run:native-tool.c.completed",
				kind: "tool.completed",
				payload: {
					name: "read_machine_tool_result",
					ok: true,
					resultPreview: {
						kind: "machine_tool_result",
						machine: "studio-mac",
						tool: "run_command",
						status: "done",
						result: fenced("1 fail\nexit code: 1"),
					},
				},
			},
			{
				id: "run:other.completed",
				kind: "tool.completed",
				payload: { name: "search_memory", resultPreview: { matches: 2 } },
			},
		]);

		expect(actions).toHaveLength(2);
		expect(actions[0]).toMatchObject({
			kind: "read",
			target: "README.md:1-40",
			machine: "studio-mac",
			status: "done",
			cut: true,
		});
		expect(actions[0]?.text.startsWith('1\t# Title "quoted"\nxxx')).toBe(true);
		expect(actions[1]).toMatchObject({
			kind: "command",
			target: "bun test",
			status: "done",
			exitCode: 1,
			callId: "call-1",
		});
		expect(summarizeMachineActions(actions)).toBe("Read 1 file, ran 1 command");
	});

	it("shows an edit as removed and added lines with shared lines as context", () => {
		expect(
			machineDiffLines({ removed: "a\nold\nz", added: "a\nnew\nmore\nz" }),
		).toEqual([
			{ sign: " ", text: "a" },
			{ sign: "-", text: "old" },
			{ sign: "+", text: "new" },
			{ sign: "+", text: "more" },
			{ sign: " ", text: "z" },
		]);
	});
});
