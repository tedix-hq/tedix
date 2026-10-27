/** Live coding trajectories and a human-readable comparison with the previous run. */

import {
	appendFile,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const MODEL = "@cf/openai/gpt-oss-120b";
const INPUT_USD_PER_MILLION = 0.35;
const OUTPUT_USD_PER_MILLION = 0.75;
const MAX_MODEL_TURNS = 8;
const REQUEST_TIMEOUT_MS = 90_000;

interface Fixture {
	id: string;
	prompt: string;
	files: Record<string, string>;
}

const FIXTURES: Fixture[] = [
	{
		id: "repair-total",
		prompt:
			"Fix the implementation of total in src/math.ts. Do not change the tests. Run the tests before finishing.",
		files: {
			"package.json":
				'{"type":"module","scripts":{"test":"bun test src/math.test.ts"}}\n',
			"src/math.ts":
				"export function total(values: number[]): number {\n\treturn values.reduce((sum, value) => sum - value, 0);\n}\n",
			"src/math.test.ts":
				'import { expect, test } from "bun:test";\nimport { total } from "./math";\n\ntest("adds every value", () => {\n\texpect(total([4, 7, 2])).toBe(13);\n});\n\ntest("handles an empty list", () => {\n\texpect(total([])).toBe(0);\n});\n',
		},
	},
	{
		id: "implement-settings",
		prompt:
			"Implement parseSettings in src/settings.ts. It must parse comma-separated KEY=VALUE pairs, trim whitespace, and let the last duplicate key win. Do not change the tests. Run the tests before finishing.",
		files: {
			"package.json":
				'{"type":"module","scripts":{"test":"bun test src/settings.test.ts"}}\n',
			"src/settings.ts":
				'export function parseSettings(input: string): Record<string, string> {\n\tthrow new Error("not implemented");\n}\n',
			"src/settings.test.ts":
				'import { expect, test } from "bun:test";\nimport { parseSettings } from "./settings";\n\ntest("parses and trims settings", () => {\n\texpect(parseSettings(" PORT = 8080, MODE= dev ")).toEqual({ PORT: "8080", MODE: "dev" });\n});\n\ntest("uses the last duplicate", () => {\n\texpect(parseSettings("MODE=dev,MODE=prod")).toEqual({ MODE: "prod" });\n});\n\ntest("accepts an empty input", () => {\n\texpect(parseSettings("  ")).toEqual({});\n});\n',
		},
	},
];

type MetricName = "modelTurns" | "toolCalls" | "toolErrors" | "costUsd";

export interface TrajectoryMetrics {
	modelTurns: number;
	toolCalls: number;
	toolErrors: number;
	costUsd: number | null;
}

export interface TrajectoryResult extends TrajectoryMetrics {
	id: string;
	passed: boolean;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	error: string | null;
}

export interface TrajectoryReport {
	schemaVersion: 1;
	generatedAt: string;
	commit: string;
	model: string;
	pricing: {
		basis: "documented_model_unit_price";
		inputUsdPerMillion: number;
		outputUsdPerMillion: number;
	};
	metrics: TrajectoryMetrics;
	trajectories: TrajectoryResult[];
}

interface ChatToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: ChatToolCall[];
	tool_call_id?: string;
}

interface CompletionResponse {
	choices?: Array<{
		message?: { content?: string | null; tool_calls?: ChatToolCall[] };
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const TOOLS = [
	{
		type: "function",
		function: {
			name: "list_files",
			description: "List every file in the fixture workspace.",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
		},
	},
	{
		type: "function",
		function: {
			name: "read_file",
			description: "Read a UTF-8 file in the fixture workspace.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function",
		function: {
			name: "write_file",
			description: "Replace a UTF-8 file in the fixture workspace.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					content: { type: "string" },
				},
				required: ["path", "content"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function",
		function: {
			name: "run_tests",
			description: "Run the fixture workspace test script.",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
		},
	},
] as const;

function workspacePath(root: string, path: unknown): string {
	if (typeof path !== "string" || !path || path.includes("\0"))
		throw new Error("path must be a non-empty string");
	const target = resolve(root, path);
	if (target !== root && !target.startsWith(root + sep))
		throw new Error("path escapes the fixture workspace");
	return target;
}

async function seedFixture(root: string, fixture: Fixture): Promise<void> {
	for (const [path, content] of Object.entries(fixture.files)) {
		const target = workspacePath(root, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
	}
}

async function listFiles(root: string, directory = root): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
		else if (entry.isFile()) files.push(relative(root, path));
	}
	return files.sort();
}

async function runTests(root: string): Promise<string> {
	const process = Bun.spawn(["bun", "run", "test"], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...Bun.env, CI: "true" },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	const output = `${stdout}${stderr}`.slice(-8_000);
	if (exitCode !== 0) throw new Error(`tests exited ${exitCode}\n${output}`);
	return output;
}

async function executeTool(
	root: string,
	call: ChatToolCall,
): Promise<{ content: string; failed: boolean }> {
	try {
		const args = JSON.parse(call.function.arguments || "{}") as Record<
			string,
			unknown
		>;
		switch (call.function.name) {
			case "list_files":
				return {
					content: JSON.stringify(await listFiles(root)),
					failed: false,
				};
			case "read_file":
				return {
					content: await readFile(workspacePath(root, args.path), "utf8"),
					failed: false,
				};
			case "write_file":
				if (typeof args.content !== "string")
					throw new Error("content must be a string");
				await writeFile(workspacePath(root, args.path), args.content);
				return { content: "file written", failed: false };
			case "run_tests":
				return { content: await runTests(root), failed: false };
			default:
				throw new Error(`unknown tool ${call.function.name}`);
		}
	} catch (error) {
		return {
			content: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
			failed: true,
		};
	}
}

async function complete(
	accountId: string,
	token: string,
	messages: ChatMessage[],
): Promise<CompletionResponse> {
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: MODEL,
				messages,
				tools: TOOLS,
				tool_choice: "auto",
				temperature: 0,
				max_tokens: 2_000,
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		},
	);
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 500);
		throw new Error(`Workers AI returned HTTP ${response.status}: ${detail}`);
	}
	return (await response.json()) as CompletionResponse;
}

async function runTrajectory(
	fixture: Fixture,
	accountId: string,
	token: string,
): Promise<TrajectoryResult> {
	const root = await mkdtemp(join(tmpdir(), `tedix-trajectory-${fixture.id}-`));
	const startedAt = Date.now();
	let modelTurns = 0;
	let toolCalls = 0;
	let toolErrors = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let usageComplete = true;
	let error: string | null = null;
	let finished = false;
	try {
		await seedFixture(root, fixture);
		const messages: ChatMessage[] = [
			{
				role: "system",
				content:
					"You are a coding agent in an isolated fixture workspace. Inspect files with tools, make the smallest correct change, run tests, and briefly summarize the result. Never ask the user to edit files.",
			},
			{ role: "user", content: fixture.prompt },
		];
		for (; modelTurns < MAX_MODEL_TURNS;) {
			let response: CompletionResponse;
			try {
				response = await complete(accountId, token, messages);
			} catch (caught) {
				usageComplete = false;
				throw caught;
			}
			modelTurns++;
			const promptTokens = response.usage?.prompt_tokens;
			const completionTokens = response.usage?.completion_tokens;
			if (promptTokens === undefined || completionTokens === undefined)
				usageComplete = false;
			else {
				inputTokens += promptTokens;
				outputTokens += completionTokens;
			}
			const message = response.choices?.[0]?.message;
			if (!message) throw new Error("Workers AI returned no assistant message");
			const calls = message.tool_calls ?? [];
			messages.push({
				role: "assistant",
				content: message.content ?? null,
				...(calls.length > 0 ? { tool_calls: calls } : {}),
			});
			if (calls.length === 0) {
				finished = true;
				break;
			}
			for (const call of calls) {
				toolCalls++;
				const result = await executeTool(root, call);
				if (result.failed) toolErrors++;
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					content: result.content,
				});
			}
		}
		if (!finished)
			throw new Error(`model turn limit (${MAX_MODEL_TURNS}) reached`);
		await runTests(root);
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
	return {
		id: fixture.id,
		passed: error === null,
		modelTurns,
		toolCalls,
		toolErrors,
		inputTokens,
		outputTokens,
		costUsd: usageComplete
			? (inputTokens * INPUT_USD_PER_MILLION +
					outputTokens * OUTPUT_USD_PER_MILLION) /
				1_000_000
			: null,
		durationMs: Date.now() - startedAt,
		error,
	};
}

function totalMetrics(results: TrajectoryResult[]): TrajectoryMetrics {
	const totals = results.reduce(
		(total, result) => ({
			modelTurns: total.modelTurns + result.modelTurns,
			toolCalls: total.toolCalls + result.toolCalls,
			toolErrors: total.toolErrors + result.toolErrors,
			costUsd: total.costUsd + (result.costUsd ?? 0),
		}),
		{ modelTurns: 0, toolCalls: 0, toolErrors: 0, costUsd: 0 },
	);
	return {
		...totals,
		costUsd: results.every((result) => result.costUsd !== null)
			? totals.costUsd
			: null,
	};
}

function metric(value: number | null, name: MetricName): string {
	if (value === null) return "n/a";
	return name === "costUsd" ? `$${value.toFixed(6)}` : String(value);
}

export function renderComparison(
	current: TrajectoryReport,
	baseline: TrajectoryReport | null,
): string {
	const lines = [
		"# Coding trajectory eval",
		"",
		`Live model: \`${current.model}\` at \`${current.commit}\``,
		`Result: ${current.trajectories.filter((result) => result.passed).length}/${current.trajectories.length} trajectories passed. This is an advisory report, not a merge gate.`,
		"",
		"| Metric | Baseline | Current | Change |",
		"| --- | ---: | ---: | ---: |",
	];
	for (const name of [
		"modelTurns",
		"toolCalls",
		"toolErrors",
		"costUsd",
	] as const) {
		const currentValue = current.metrics[name];
		const baselineValue = baseline?.metrics[name];
		const change =
			baselineValue === undefined ||
			baselineValue === null ||
			currentValue === null
				? null
				: currentValue - baselineValue;
		lines.push(
			`| ${name} | ${baselineValue === undefined ? "n/a" : metric(baselineValue, name)} | ${metric(currentValue, name)} | ${metric(change, name)} |`,
		);
	}
	lines.push(
		"",
		baseline
			? `Baseline: \`${baseline.commit}\` from ${baseline.generatedAt}.`
			: "Baseline: no previous successful workflow artifact was available; the next run will compare against this report.",
		"",
		"| Trajectory | Passed | Turns | Tools | Tool errors | Cost | Duration |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: |",
	);
	for (const result of current.trajectories)
		lines.push(
			`| ${result.id} | ${result.passed ? "yes" : "no"} | ${result.modelTurns} | ${result.toolCalls} | ${result.toolErrors} | ${metric(result.costUsd, "costUsd")} | ${(result.durationMs / 1_000).toFixed(1)}s |`,
		);
	const failures = current.trajectories.filter((result) => result.error);
	if (failures.length > 0) {
		lines.push("", "## Failures", "");
		for (const failure of failures)
			lines.push(`- \`${failure.id}\`: ${failure.error!.split("\n")[0]}`);
	}
	return lines.join("\n") + "\n";
}

function argumentValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readBaseline(
	path: string | undefined,
): Promise<TrajectoryReport | null> {
	if (!path) return null;
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as TrajectoryReport;
		return value.schemaVersion === 1 ? value : null;
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	const accountId = process.env.CF_ACCOUNT_ID?.trim();
	const token = process.env.CF_WORKERS_AI_TOKEN?.trim();
	if (!accountId || !token)
		throw new Error("CF_ACCOUNT_ID and CF_WORKERS_AI_TOKEN are required");
	const output = resolve(
		argumentValue("--output") ?? "eval/kernel/results/trajectory-report.json",
	);
	const results: TrajectoryResult[] = [];
	for (const fixture of FIXTURES)
		results.push(await runTrajectory(fixture, accountId, token));
	const report: TrajectoryReport = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		commit: process.env.GITHUB_SHA ?? process.env.GIT_SHA ?? "local",
		model: MODEL,
		pricing: {
			basis: "documented_model_unit_price",
			inputUsdPerMillion: INPUT_USD_PER_MILLION,
			outputUsdPerMillion: OUTPUT_USD_PER_MILLION,
		},
		metrics: totalMetrics(results),
		trajectories: results,
	};
	await mkdir(dirname(output), { recursive: true });
	await writeFile(output, JSON.stringify(report, null, 2) + "\n");
	const comparison = renderComparison(
		report,
		await readBaseline(argumentValue("--baseline")),
	);
	console.log(comparison);
	if (process.env.GITHUB_STEP_SUMMARY)
		await appendFile(process.env.GITHUB_STEP_SUMMARY, comparison);
}

if (import.meta.main) await main();
