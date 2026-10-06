import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { InkLivePanel } from "./ink-live-panel";
import type { RunState } from "./live-panel";
import { isTuiScreenReaderEnabled } from "./tui-accessibility";

function streams() {
	const stdout = new PassThrough();
	const stdin = new PassThrough();
	let output = "";
	stdout.on("data", (chunk) => {
		output += chunk.toString();
	});
	return {
		stdout,
		stdin,
		take: () => {
			const text = stripVTControlCharacters(output);
			output = "";
			return text;
		},
	};
}

async function flush(instance: ReturnType<typeof render>) {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await instance.waitUntilRenderFlush();
}

const state: RunState = {
	entry: {
		homeRunId: "run-1",
		conversationId: "conversation-1",
		label: "A detailed request whose label extends beyond twenty-four columns",
		startedAt: 1_000,
		settled: false,
	},
	summary: {
		status: "requires_approval",
		targetTediLabel: "Research worker",
		progressDetail: "Waiting for approval of the complete research proposal",
	},
	tokens: 1_234,
	children: [
		{
			id: "child-1",
			label: "A child worker whose name must remain complete",
			status: "failed",
			objective:
				"Review a long objective with critical detail at the end: missing authorization",
		},
	],
	childTotal: 1,
	childDone: 0,
	childFailed: 1,
	activities: [
		"\u001b[31mError: access denied for the requested resource\u001b[0m",
		"Fetching documentation",
	],
	answerStream: "Incomplete answer delta",
};

describe("TUI semantic screen-reader output", () => {
	test("resolves explicit Tedix opt-in and the native Ink convention", () => {
		expect(isTuiScreenReaderEnabled({})).toBe(false);
		expect(isTuiScreenReaderEnabled({ TEDIX_SCREEN_READER: "1" })).toBe(true);
		expect(isTuiScreenReaderEnabled({ INK_SCREEN_READER: "true" })).toBe(true);
		expect(
			isTuiScreenReaderEnabled({
				TEDIX_SCREEN_READER: "0",
				INK_SCREEN_READER: "true",
			}),
		).toBe(true);
		expect(
			isTuiScreenReaderEnabled({
				TEDIX_SCREEN_READER: "true",
				INK_SCREEN_READER: "1",
			}),
		).toBe(false);
	});

	test("generic streams retain full run, child, approval and error detail", async () => {
		const kit = streams();
		const instance = render(
			<InkLivePanel
				states={[state]}
				frameIndex={0}
				now={2_000}
				activityMode="compact"
			/>,
			{
				stdout: kit.stdout,
				stdin: kit.stdin,
				stderr: kit.stdout,
				isScreenReaderEnabled: true,
				interactive: true,
				patchConsole: false,
			},
		);
		try {
			await flush(instance);
			const text = kit.take().replace(/\s+/g, " ");
			expect(text).toContain(state.entry.label);
			expect(text).toContain("requires approval");
			expect(text).toContain("Worker: Research worker");
			expect(text).toContain("Error: access denied for the requested resource");
			expect(text).toContain("Fetching documentation");
			expect(text).toContain("Child runs: 0 of 1 completed; 1 failed.");
			expect(text).toContain(state.children![0]!.label);
			expect(text).toContain("missing authorization");
			expect(text).toContain("Answer is streaming.");
			expect(text).not.toContain("Incomplete answer delta");
			expect(text).not.toMatch(/[⠋⠙⠹↓]|1\.2k/);
		} finally {
			instance.unmount();
			instance.cleanup();
		}
	});

	test("ticks, costs and answer deltas do not repeat semantic announcements", async () => {
		const kit = streams();
		const instance = render(
			<InkLivePanel
				states={[state]}
				frameIndex={0}
				now={2_000}
				activityMode="full"
			/>,
			{
				stdout: kit.stdout,
				stdin: kit.stdin,
				stderr: kit.stdout,
				isScreenReaderEnabled: true,
				interactive: true,
				patchConsole: false,
			},
		);
		try {
			await flush(instance);
			kit.take();
			instance.rerender(
				<InkLivePanel
					states={[{ ...state, tokens: 9_000, answerStream: "Next delta" }]}
					frameIndex={3}
					now={99_000}
					activityMode="full"
				/>,
			);
			await flush(instance);
			expect(kit.take()).toBe("");
			instance.rerender(
				<InkLivePanel
					states={[
						{
							...state,
							summary: {
								status: "failed",
								progressDetail: "Error: run terminated",
							},
						},
					]}
					frameIndex={4}
					now={100_000}
					activityMode="full"
				/>,
			);
			await flush(instance);
			expect(kit.take()).toContain("Error: run terminated");
		} finally {
			instance.unmount();
			instance.cleanup();
		}
	});
});
