import { describe, expect, it, spyOn } from "bun:test";
import {
	createFactoryInput,
	type FactoryContext,
	runFactoryCommand,
	setScheduleEnabled,
} from "./factory";
import { parseOptions } from "./options";

function harness(reply: unknown, factory: FactoryContext["factory"] = {}) {
	const calls: string[] = [];
	const ctx: FactoryContext = {
		client: {
			runCode: async (source: string) => {
				calls.push(source);
				return reply;
			},
		},
		color: { enabled: false },
		json: true,
		factory,
	};
	return { calls, ctx };
}

// Frontmatter rendered by the report template for a Docs factory.
const REPORT_SKILL = `---
name: docs
description: "Docs factory lane: reads the project's Work, asks the owner tedi for at most 3 new proposals toward the goal, files them as deduplicated Work Items and posts a scorecard on the health item."
audience: ["tedi"]
capabilities:
  network: false
  mcp:
    tedi: [work_items_list, run_tedi_turn, messages_read, work_item_create, work_item_comment]
  schedule:
    cron: "17 5 * * *"
    params: {}
---

# Docs factory

Body with capabilities.schedule, enabled: true and --- stays intact.
`;

describe("setScheduleEnabled", () => {
	it("pauses the report schedule, is idempotent, and resumes it exactly", () => {
		const paused = setScheduleEnabled(REPORT_SKILL, false);
		expect(paused).toBe(
			REPORT_SKILL.replace(
				"  schedule:\n",
				"  schedule:\n    enabled: false\n",
			),
		);
		expect(setScheduleEnabled(paused, false)).toBe(paused);
		expect(setScheduleEnabled(paused, true)).toBe(REPORT_SKILL);
		expect(setScheduleEnabled(REPORT_SKILL, true)).toBe(REPORT_SKILL);
	});

	it("replaces only the schedule's direct enabled child", () => {
		const content = REPORT_SKILL.replace(
			"  network: false",
			"  network: false\n  enabled: true",
		).replace(
			"    params: {}",
			"    enabled: true\n    params:\n      enabled: true",
		);
		expect(setScheduleEnabled(content, false)).toBe(
			content.replace("    enabled: true\n", "    enabled: false\n"),
		);
	});

	it("preserves CRLF, sibling frontmatter and the body", () => {
		const content = REPORT_SKILL.replace(
			"---\n\n#",
			"extra: untouched\n---\n\n#",
		).replaceAll("\n", "\r\n");
		expect(setScheduleEnabled(setScheduleEnabled(content, false), true)).toBe(
			content,
		);
	});

	it("rejects missing frontmatter or schedule blocks", () => {
		for (const content of [
			"# No frontmatter",
			"---\nname: docs\n---\n  schedule:\n",
			"---\ncapabilities:\n  network: false\n---\n",
		]) {
			expect(() => setScheduleEnabled(content, false)).toThrow(
				/no capabilities.schedule block/,
			);
		}
	});
});

describe("factory commands", () => {
	for (const verb of ["pause", "resume", "archive"] as const) {
		it(`${verb} resolves the lane and uses only the documented skill route`, async () => {
			const stdout = spyOn(console, "log").mockImplementation(() => {});
			try {
				const lane = {
					slug: "docs",
					skillId: "skill-1",
					lifecycleState: "active",
					scheduleEnabled: verb !== "resume",
					healthWorkItemId: "health-1",
					projectId: "project-1",
					projectKey: "DOCS",
					objectiveId: "objective-1",
				};
				const content =
					verb === "resume"
						? setScheduleEnabled(REPORT_SKILL, false)
						: REPORT_SKILL;
				const result = { entry: { id: "skill-1", revision: 2 } };
				const replies = [
					{ data: [lane] },
					...(verb === "archive" ? [] : [{ entry: { content } }]),
					result,
				];
				const { ctx, calls } = harness(undefined);
				ctx.client.runCode = async (source) => {
					calls.push(source);
					return replies.shift();
				};
				expect(await runFactoryCommand(`${verb} docs`, ctx)).toBe(0);
				expect(calls[0]).toContain(
					'projects.inspect_factory_health({"factory":"docs"})',
				);
				expect(calls[0]).toContain('"skillId"');
				if (verb !== "archive")
					expect(calls[1]).toBe(
						'async () => await skills.get_skills({"id":"skill-1"})',
					);
				const expected =
					verb === "archive"
						? { id: "skill-1", lifecycleState: "archived" }
						: {
								id: "skill-1",
								content: setScheduleEnabled(content, verb === "resume"),
								revisionReasoning: `${verb === "pause" ? "Pause" : "Resume"} factory docs.`,
							};
				expect(calls.at(-1)).toBe(
					`async () => await skills.improve_skills(${JSON.stringify(expected)})`,
				);
				expect(calls).toHaveLength(verb === "archive" ? 2 : 3);
				expect(stdout.mock.calls).toEqual([[JSON.stringify(result)]]);
			} finally {
				stdout.mockRestore();
			}
		});
	}

	it("does not write for already paused or running lanes", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		try {
			for (const verb of ["pause", "resume"] as const) {
				const { ctx, calls } = harness({
					data: [
						{
							slug: "docs",
							skillId: "skill-1",
							scheduleEnabled: verb === "resume",
						},
					],
				});
				ctx.json = false;
				expect(await runFactoryCommand(`${verb} docs`, ctx)).toBe(0);
				expect(calls).toHaveLength(1);
				expect(stdout.mock.calls.at(-1)?.[0]).toContain(
					verb === "pause" ? "already paused" : "already running",
				);
			}
		} finally {
			stdout.mockRestore();
		}
	});

	it("prints owner and notes before next actions for planned and created factories", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		try {
			for (const dryRun of [true, false]) {
				stdout.mockClear();
				const { ctx } = harness(
					{
						dryRun,
						ownerTediName: "Nova",
						ownerTediId: "owner-1",
						warnings: ["Daily only."],
						nextActions: ["Check health."],
					},
					{ goal: "Keep docs accurate." },
				);
				ctx.json = false;
				expect(await runFactoryCommand("create", ctx)).toBe(0);
				const lines = stdout.mock.calls.map(([line]) => String(line));
				expect(lines).toContain("  owner Nova (owner-1)");
				expect(lines.indexOf("Note: Daily only.")).toBeLessThan(
					lines.indexOf("Next: Check health."),
				);
			}
		} finally {
			stdout.mockRestore();
		}
	});

	it("prints archive follow-ups with real ids without executing them", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		try {
			const { ctx, calls } = harness(undefined);
			const replies = [
				{
					data: [
						{
							slug: "docs",
							skillId: "skill-1",
							healthWorkItemId: "health-1",
							projectId: "project-1",
							objectiveId: "objective-1",
						},
					],
				},
				{ entry: { lifecycleState: "archived" } },
			];
			ctx.json = false;
			ctx.client.runCode = async (source) => {
				calls.push(source);
				return replies.shift();
			};
			expect(await runFactoryCommand("archive docs", ctx)).toBe(0);
			expect(calls).toHaveLength(2);
			expect(stdout.mock.calls.flat()).toContain(
				"Next: tedix work cancel health-1",
			);
			expect(stdout.mock.calls.flat()).toContain(
				'Next: archive_project({"id":"project-1"})',
			);
			expect(stdout.mock.calls.flat()).toContain(
				'Next: update_tedi_objectives({"id":"objective-1","status":"completed"})',
			);
		} finally {
			stdout.mockRestore();
		}
	});

	it("rejects an unknown slug before any skill call", async () => {
		const stderr = spyOn(console, "error").mockImplementation(() => {});
		try {
			const { ctx, calls } = harness({ data: [] });
			expect(await runFactoryCommand("pause missing", ctx)).not.toBe(0);
			expect(calls).toHaveLength(1);
			expect(stderr.mock.calls.flat()).toContain('No factory "missing".');
		} finally {
			stderr.mockRestore();
		}
	});

	it("creates a factory from flags in one gateway call", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		const { calls, ctx } = harness(
			{ slug: "docs-accuracy", status: "created" },
			{
				goal: "Keep the docs accurate.",
				owner: "Nova",
				cadence: "daily",
				maxProposals: "2",
				project: "DOCS",
				dryRun: true,
			},
		);
		expect(await runFactoryCommand("create", ctx)).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("projects.create_factory");
		expect(calls[0]).toContain('"ownerTedi":"Nova"');
		expect(calls[0]).toContain('"maxProposals":2');
		expect(calls[0]).toContain('"projectKey":"DOCS"');
		expect(calls[0]).toContain('"dryRun":true');
		stdout.mockRestore();
	});

	it("prints the failed tool's own error, not the gateway envelope", async () => {
		const stderr = spyOn(console, "error").mockImplementation(() => {});
		const envelope = {
			executionId: "e-1",
			partial: true,
			failures: [
				{
					tool: "projects.inspect_factory_health",
					error: 'NOT_FOUND: No factory "gone".',
				},
			],
			result: { ok: false },
		};
		const ctx: FactoryContext = {
			client: {
				runCode: async () => {
					throw new Error(
						`MCP tool error: ${JSON.stringify(envelope, null, 2)}`,
					);
				},
			},
			color: { enabled: false },
			json: false,
			factory: {},
		};
		expect(await runFactoryCommand("status gone", ctx)).not.toBe(0);
		expect(stderr.mock.calls.flat().join("\n")).toBe(
			'projects.inspect_factory_health: No factory "gone".',
		);
		stderr.mockRestore();
	});

	it("requires a goal before any call and leaves the owner to the server", () => {
		expect(() => createFactoryInput({ owner: "Nova" })).toThrow(/--goal/);
		expect(createFactoryInput({ goal: "Keep docs right." })).toEqual({
			goal: "Keep docs right.",
		});
		expect(() =>
			createFactoryInput({ goal: "x", owner: "y", maxProposals: "50" }),
		).toThrow(/--max-proposals/);
		for (const maxProposals of ["", " ", "1e1", "0x5", "-1", "2.5"])
			expect(() => createFactoryInput({ goal: "x", maxProposals })).toThrow(
				/--max-proposals/,
			);
		expect(createFactoryInput({ goal: "x", maxProposals: "0" })).toEqual({
			goal: "x",
			maxProposals: 0,
		});
		expect(createFactoryInput({ goal: "x", maxProposals: " 10 " })).toEqual({
			goal: "x",
			maxProposals: 10,
		});
	});

	it("maps hourly cadence and trimmed output flags", () => {
		for (const everyHours of ["1", "2", "3", "4", "6", "8", "12"]) {
			for (const outputKind of ["document", "sheet"]) {
				expect(
					createFactoryInput({
						goal: "Keep docs accurate.",
						cadence: "hourly",
						everyHours,
						output: "  Docs summary  ",
						outputKind,
					}),
				).toEqual({
					goal: "Keep docs accurate.",
					cadence: "hourly",
					everyHours: Number(everyHours),
					output: "Docs summary",
					outputKind,
				});
			}
		}
		const output = "11111111-1111-4111-8111-111111111111";
		expect(createFactoryInput({ goal: "Keep docs accurate.", output })).toEqual(
			{
				goal: "Keep docs accurate.",
				output,
			},
		);
	});

	it("rejects unsupported hour intervals and intervals without hourly cadence", () => {
		for (const everyHours of ["5", "0", "24", "1.5", "abc", ""]) {
			expect(() =>
				createFactoryInput({
					goal: "Keep docs accurate.",
					cadence: "hourly",
					everyHours,
				}),
			).toThrow(/--every-hours must be a whole number/);
		}
		for (const cadence of [undefined, "daily", "twice_daily"]) {
			expect(() =>
				createFactoryInput({
					goal: "Keep docs accurate.",
					cadence,
					everyHours: "2",
				}),
			).toThrow("--every-hours needs --cadence hourly");
		}
	});

	it("rejects unsupported output kinds and kinds without an output", () => {
		expect(() =>
			createFactoryInput({
				goal: "Keep docs accurate.",
				output: "Docs summary",
				outputKind: "pdf",
			}),
		).toThrow("--output-kind must be document or sheet");
		for (const output of [undefined, "", "  "]) {
			expect(() =>
				createFactoryInput({
					goal: "Keep docs accurate.",
					output,
					outputKind: "document",
				}),
			).toThrow("--output-kind needs --output");
		}
	});

	it("prints the output id or planned title and kind", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		try {
			for (const output of [
				{
					id: "11111111-1111-4111-8111-111111111111",
					title: "Docs summary",
					kind: "document",
				},
				{ id: null, title: "Docs summary", kind: "sheet" },
				null,
				undefined,
			]) {
				stdout.mockClear();
				const { ctx } = harness({ output }, { goal: "Keep docs accurate." });
				ctx.json = false;
				expect(await runFactoryCommand("create", ctx)).toBe(0);
				const lines = stdout.mock.calls.map(([line]) => String(line));
				if (output) {
					expect(lines).toContain(
						`  output ${output.id ?? output.title} (${output.kind})`,
					);
				} else {
					expect(lines.some((line) => line.startsWith("  output "))).toBe(
						false,
					);
				}
			}
		} finally {
			stdout.mockRestore();
		}
	});

	it("lists every factory, or one by slug, with its verdict", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		const all = harness({
			data: [
				{ slug: "docs", verdict: "idle", reason: "ran, delivered nothing" },
			],
		});
		all.ctx.json = false;
		expect(await runFactoryCommand("status", all.ctx)).toBe(0);
		expect(all.calls[0]).toContain("projects.inspect_factory_health({})");
		expect(all.calls[0]).toContain('"verdict"');
		expect(all.calls[0]).not.toContain('"runs"');
		expect(stdout.mock.calls[0]?.[0]).toContain("idle");

		const one = harness({ data: [] }, { runs: 3 });
		expect(await runFactoryCommand("status docs", one.ctx)).toBe(0);
		expect(one.calls[0]).toContain('"factory":"docs"');
		expect(one.calls[0]).toContain('"runs":3');
		expect(one.calls[0]).not.toContain("data.map");
		stdout.mockRestore();
	});

	it("orders the overview by severity and summarizes verdict counts", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		try {
			const reply = {
				data: [
					{ slug: "a-paused", verdict: "paused" },
					{ slug: "b-idle", verdict: "idle" },
					{ slug: "c-unknown", verdict: "unknown" },
					{ slug: "d-healthy", verdict: "healthy" },
					{ slug: "e-pending", verdict: "pending" },
					{ slug: "f-idle", verdict: "idle" },
					{ slug: "g-not-firing", verdict: "not_firing" },
					{ slug: "h-failing", verdict: "failing" },
				],
			};
			const { ctx } = harness(reply);
			ctx.json = false;
			expect(await runFactoryCommand("status", ctx)).toBe(0);
			const lines = stdout.mock.calls.map(([line]) => String(line));
			expect(
				lines
					.filter((_, index) => index < 16 && index % 2 === 0)
					.map((line) => line.split(/\s+/)[1]),
			).toEqual([
				"h-failing",
				"g-not-firing",
				"b-idle",
				"f-idle",
				"e-pending",
				"d-healthy",
				"a-paused",
				"c-unknown",
			]);
			expect(lines).toHaveLength(17);
			expect(lines.at(-1)).toBe(
				"8 factories: 1 failing, 1 not_firing, 2 idle, 1 pending, 1 healthy, 1 paused, 1 unknown",
			);
			stdout.mockClear();
			ctx.json = true;
			expect(await runFactoryCommand("status", ctx)).toBe(0);
			expect(stdout.mock.calls).toEqual([[JSON.stringify(reply)]]);
		} finally {
			stdout.mockRestore();
		}
	});

	it("names each run and a failed run's error so it can be read next", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		try {
			const { ctx } = harness({
				data: [
					{
						slug: "docs",
						verdict: "failing",
						runs: [
							{
								runId: "run-failed-1",
								status: "failed",
								firedAt: "2026-10-08T02:00:11.936Z",
								error: "Request timed out after 15000ms",
								outputs: {},
							},
						],
					},
				],
			});
			ctx.json = false;
			expect(await runFactoryCommand("status docs", ctx)).toBe(0);
			const text = stdout.mock.calls.map(([line]) => String(line)).join("\n");
			expect(text).toContain("run-failed-1");
			expect(text).toContain("error: Request timed out after 15000ms");
			expect(text).toContain("tedix skill status <runId>");
		} finally {
			stdout.mockRestore();
		}
	});

	it("parses hourly and output flags only for the factory command", () => {
		const parsed = parseOptions([
			"factory",
			"create",
			"--cadence",
			"hourly",
			"--every-hours",
			"4",
			"--output",
			"Docs summary",
			"--output-kind",
			"sheet",
		]);
		expect(parsed.command).toBe("factory");
		expect(parsed.options).toMatchObject({
			factoryCadence: "hourly",
			factoryEveryHours: "4",
			factoryOutput: "Docs summary",
			factoryOutputKind: "sheet",
			prompt: "create",
		});
		for (const flag of ["--every-hours", "--output", "--output-kind"]) {
			expect(() => parseOptions(["work", "list", flag, "x"])).toThrow(
				/only valid with factory/,
			);
			expect(() => parseOptions(["factory", "create", flag])).toThrow();
		}
	});

	it("parses factory flags only for the factory command", () => {
		const parsed = parseOptions([
			"factory",
			"create",
			"--goal",
			"Keep the docs accurate.",
			"--owner",
			"Nova",
			"--cadence",
			"twice_daily",
			"--dry-run",
		]);
		expect(parsed.command).toBe("factory");
		expect(parsed.options).toMatchObject({
			factoryGoal: "Keep the docs accurate.",
			factoryOwner: "Nova",
			factoryCadence: "twice_daily",
			factoryDryRun: true,
			prompt: "create",
		});
		expect(() => parseOptions(["work", "list", "--goal", "x"])).toThrow(
			/only valid with factory/,
		);
	});
});
