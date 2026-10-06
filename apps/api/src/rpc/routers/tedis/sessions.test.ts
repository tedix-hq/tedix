import { describe, expect, it } from "vite-plus/test";

import {
	deleteRuntimeSessionForTedi,
	selectBulkDeleteTargets,
} from "./sessions";

describe("deleteRuntimeSessionForTedi", () => {
	it("treats isolate chat deletion as platform session state only", async () => {
		const result = await deleteRuntimeSessionForTedi({
			env: {} as CloudflareEnv,
			sessionKey: "agent:main:chat:test",
			tedi: {
				id: "5eed0042-0000-4000-8000-000000000042",
				runtimeKind: "agent",
				slug: "cpo",
			},
		});

		expect(result).toEqual({
			deleted: false,
			retainedTranscripts: [],
		});
	});

	it("treats null runtimeKind as platform session state only", async () => {
		const result = await deleteRuntimeSessionForTedi({
			env: {} as CloudflareEnv,
			sessionKey: "agent:main:chat:test",
			tedi: {
				id: "5eed0042-0000-4000-8000-000000000042",
				runtimeKind: null,
				slug: "echo",
			},
		});

		expect(result).toEqual({
			deleted: false,
			retainedTranscripts: [],
		});
	});
});

describe("selectBulkDeleteTargets", () => {
	const convos = [
		{ id: "echo:agent:main:main", lastActivityIso: "2026-06-09T00:00:00.000Z" },
		{ id: "agent:main:main", lastActivityIso: "2026-06-09T00:00:00.000Z" },
		{ id: "echo:codex-live-tool", lastActivityIso: "2026-05-01T00:00:00.000Z" },
		{
			id: "echo:claude-health-probe",
			lastActivityIso: "2026-06-08T00:00:00.000Z",
		},
		{
			id: "echo:agent:main:chat:abc",
			lastActivityIso: "2026-06-08T00:00:00.000Z",
		},
		{ id: "echo:email:<x@y>", lastActivityIso: "2026-01-01T00:00:00.000Z" },
	];

	it("explicit sessionKeys win, are deduped, and exclude agent:main:main", () => {
		const out = selectBulkDeleteTargets({
			sessionKeys: [
				"echo:codex-live-tool",
				"echo:codex-live-tool",
				"agent:main:main",
				"echo:agent:main:main",
			],
			conversations: convos,
			pattern: null,
			cutoffIso: null,
		});
		expect(out).toEqual(["echo:codex-live-tool"]);
	});

	it("filters by id pattern and never matches the main session", () => {
		const out = selectBulkDeleteTargets({
			conversations: convos,
			pattern: /codex|claude/i,
			cutoffIso: null,
		});
		expect(out.sort()).toEqual(
			["echo:claude-health-probe", "echo:codex-live-tool"].sort(),
		);
		expect(out).not.toContain("agent:main:main");
		expect(out).not.toContain("echo:agent:main:main");
	});

	it("filters by age cutoff (strictly older than)", () => {
		const out = selectBulkDeleteTargets({
			conversations: convos,
			pattern: null,
			cutoffIso: "2026-06-01T00:00:00.000Z",
		});
		// older-than-cutoff, main-session excluded: codex (May) + email (Jan)
		expect(out.sort()).toEqual(
			["echo:codex-live-tool", "echo:email:<x@y>"].sort(),
		);
	});

	it("combines pattern AND age, with the main-session guard always on", () => {
		const out = selectBulkDeleteTargets({
			conversations: convos,
			pattern: /codex|claude|agent:main:main/i,
			cutoffIso: "2026-06-09T00:00:00.000Z",
		});
		// pattern would catch the main sessions, but the hard guard drops them;
		// claude-probe (Jun 8 < Jun 9) and codex (May) survive.
		expect(out.sort()).toEqual(
			["echo:claude-health-probe", "echo:codex-live-tool"].sort(),
		);
	});
});
