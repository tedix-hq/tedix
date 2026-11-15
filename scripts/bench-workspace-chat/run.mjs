#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function scoreAnswer(fixture, answer) {
	const missing = fixture.checks
		.filter(({ pattern }) => !new RegExp(pattern, "iu").test(answer))
		.map(({ label }) => label);
	return { ok: missing.length === 0, missing };
}

function eventText(event) {
	if (typeof event.delta === "string") return event.delta;
	if (typeof event.payload === "string") return event.payload;
	for (const key of ["text", "delta", "content"])
		if (typeof event.payload?.[key] === "string") return event.payload[key];
	return "";
}

export function observeHomeEvent(state, event, elapsedMs) {
	const text = eventText(event);
	if (state.firstTokenMs === null && event.kind === "message.delta" && text)
		state.firstTokenMs = elapsedMs;
	if (event.kind === "message.completed" && text.trim()) state.answer = text;
	if (/^(?:run|turn)[._](?:failed|canceled|cancelled)$/i.test(event.kind ?? ""))
		state.error = eventText(event) || event.kind;
}

export function observeWorkspaceEvent(state, event, elapsedMs) {
	if (
		event.type === "turn.accepted" &&
		event.clientTurnId === state.clientTurnId
	) {
		state.turnId = event.turnId;
		state.conversationId = event.conversationId;
		return;
	}
	if (state.turnId === null || event.turnId !== state.turnId) return;
	if (
		state.firstTokenMs === null &&
		event.type === "assistant.delta" &&
		event.text
	)
		state.firstTokenMs = elapsedMs;
	if (event.type === "assistant.done" && typeof event.text === "string")
		state.answer = event.text;
	if (event.type === "turn.finished") {
		state.finished = true;
		state.status = event.status;
	}
}

export function tableRows(results) {
	return results.map((result) => ({
		question: result.id,
		transport: result.transport,
		"first token": formatMs(result.firstTokenMs),
		"final answer": formatMs(result.finalMs),
		correct: result.ok ? "PASS" : "FAIL",
		missing: result.missing.join(", "),
	}));
}

function formatMs(value) {
	return value === null ? "n/a" : `${(value / 1000).toFixed(2)}s`;
}

async function runCommand(args, { allow = [0], onLine, timeoutMs } = {}) {
	const proc = Bun.spawn(args, {
		cwd: homedir(),
		env: process.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	let stdout = "";
	let buffered = "";
	let timedOut = false;
	const timeout = timeoutMs
		? setTimeout(() => {
				timedOut = true;
				proc.kill();
			}, timeoutMs)
		: null;
	const readStdout = (async () => {
		for await (const chunk of proc.stdout) {
			const text = new TextDecoder().decode(chunk);
			stdout += text;
			buffered += text;
			let newline;
			while ((newline = buffered.indexOf("\n")) >= 0) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (line) onLine?.(line);
			}
		}
		if (buffered.trim()) onLine?.(buffered.trim());
	})();
	const [exit, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
		readStdout,
	]).then(([exit, stderr]) => [exit, stderr]);
	if (timeout) clearTimeout(timeout);
	if (timedOut) throw new Error(`Command timed out after ${timeoutMs}ms`);
	if (!allow.includes(exit))
		throw new Error(`Command exited ${exit}: ${stderr || stdout}`);
	return { stdout, stderr, exit };
}

function cliPrefix(options) {
	return [
		"tedix",
		"-w",
		options.profile,
		"--organization",
		options.organization,
		"--workspace",
		options.profile,
	];
}

function parseJson(text, label) {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${label} did not return JSON`, { cause: error });
	}
}

function unwrapResult(value) {
	for (
		let depth = 0;
		depth < 8 && value && typeof value === "object";
		depth++
	) {
		if (!("result" in value)) break;
		value = value.result;
	}
	return value;
}

export function runIdFromDispatch(value) {
	const result = unwrapResult(value);
	return (
		result?.homeRunId ?? result?.run?.id ?? result?.runId ?? result?.id ?? null
	);
}

export function runIdFromSet(value) {
	const runs = value?.runSet?.runs ?? value?.runs ?? value?.items ?? [];
	return runs.at(-1)?.id ?? runs.at(-1)?.homeRunId ?? null;
}

async function recoverHomeRun(conversationId, options, cause) {
	for (let attempt = 0; attempt < 8; attempt++) {
		try {
			const payload = parseJson(
				(
					await runCommand([
						...cliPrefix(options),
						"runs",
						conversationId,
						"--json",
					])
				).stdout,
				"Home run recovery",
			);
			const runId = runIdFromSet(payload);
			if (runId) return runId;
		} catch (error) {
			if (attempt === 7) throw error;
		}
		if (attempt < 7) await Bun.sleep(Math.min(1000 * 2 ** attempt, 15_000));
	}
	throw new Error(
		`Home dispatch outcome is unknown for conversation ${conversationId}; the mutation was not retried`,
		{ cause },
	);
}

async function runHomeFixture(fixture, options) {
	const started = performance.now();
	const conversationId = `workspace-bench:${fixture.id}:${crypto.randomUUID()}`;
	const content = `In workspace ${options.workspaceId}, ${fixture.question}`;
	const source = `async () => await kernel.enqueue_kernel_runtime_message(${JSON.stringify(
		{
			conversationId,
			content,
			idempotencyKey: crypto.randomUUID(),
		},
	)})`;
	let runId;
	try {
		const dispatched = await runCommand([
			...cliPrefix(options),
			"code",
			source,
			"--json",
		]);
		runId = runIdFromDispatch(parseJson(dispatched.stdout, "Home dispatch"));
	} catch (error) {
		runId = await recoverHomeRun(conversationId, options, error);
	}
	if (!runId) throw new Error("Home dispatch returned no run ID");

	const state = { answer: "", error: "", firstTokenMs: null };
	await runCommand([...cliPrefix(options), "tail", runId, "--json"], {
		allow: [0, 2],
		timeoutMs: options.timeoutMs,
		onLine(line) {
			observeHomeEvent(
				state,
				parseJson(line, "Home event"),
				performance.now() - started,
			);
		},
	});
	if (state.error) throw new Error(`Home run ${runId} failed: ${state.error}`);
	if (!state.answer) {
		const transcript = parseJson(
			(
				await runCommand([
					...cliPrefix(options),
					"messages",
					conversationId,
					"--json",
				])
			).stdout,
			"Home transcript",
		);
		state.answer =
			transcript.messages
				?.filter((message) => message.role === "assistant")
				.at(-1)?.content ?? "";
	}
	return {
		answer: state.answer,
		finalMs: performance.now() - started,
		firstTokenMs: state.firstTokenMs,
		runId,
	};
}

async function runWorkspaceFixture(fixture, options) {
	const authorization = process.env.TEDIX_OS_AUTHORIZATION;
	const cookie = process.env.TEDIX_OS_COOKIE;
	if (!authorization && !cookie)
		throw new Error("Set TEDIX_OS_AUTHORIZATION or TEDIX_OS_COOKIE");
	if (!process.env.TEDIX_OS_URL)
		throw new Error("Set TEDIX_OS_URL to the tenant OS origin");
	const base = new URL(process.env.TEDIX_OS_URL);
	base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
	base.pathname = `/workspace/${encodeURIComponent(options.workspaceId)}/chat`;
	const started = performance.now();
	const state = {
		answer: "",
		clientTurnId: crypto.randomUUID(),
		conversationId: null,
		finished: false,
		firstTokenMs: null,
		status: "running",
		turnId: null,
	};
	const headers = {
		...(authorization ? { Authorization: authorization } : {}),
		...(cookie ? { Cookie: cookie } : {}),
	};
	const socket = new WebSocket(base, { headers });
	await new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.close();
			error ? reject(error) : resolve();
		};
		const timeout = setTimeout(
			() => finish(new Error("Workspace turn timed out")),
			options.timeoutMs,
		);
		socket.addEventListener("open", () =>
			socket.send(
				JSON.stringify({
					type: "subscribe",
					conversationId: null,
					cursor: null,
				}),
			),
		);
		socket.addEventListener("message", ({ data }) => {
			const event = parseJson(String(data), "Workspace event");
			if (event.type === "hello") {
				socket.send(
					JSON.stringify({
						type: "send_turn",
						clientTurnId: state.clientTurnId,
						conversationId: null,
						text: fixture.question,
					}),
				);
				return;
			}
			if (event.type === "error" && event.clientTurnId === state.clientTurnId)
				finish(new Error(`Workspace turn failed: ${event.message}`));
			observeWorkspaceEvent(state, event, performance.now() - started);
			if (!state.finished) return;
			state.status === "done"
				? finish()
				: finish(new Error(`Workspace turn ended ${state.status}`));
		});
		socket.addEventListener("error", () =>
			finish(new Error("Workspace WebSocket failed")),
		);
	});
	return {
		answer: state.answer,
		finalMs: performance.now() - started,
		firstTokenMs: state.firstTokenMs,
		runId: state.turnId,
	};
}

export async function runBenchmark(fixtures, options) {
	const results = [];
	for (const fixture of fixtures) {
		const measured =
			options.transport === "home"
				? await runHomeFixture(fixture, options)
				: await runWorkspaceFixture(fixture, options);
		results.push({
			id: fixture.id,
			transport: options.transport,
			...measured,
			...scoreAnswer(fixture, measured.answer),
		});
	}
	return results;
}

async function main() {
	const { values } = parseArgs({
		options: {
			help: { type: "boolean", short: "h" },
			organization: { type: "string", default: process.env.TEDIX_ORGANIZATION },
			profile: { type: "string", default: "connect" },
			"timeout-ms": { type: "string", default: String(DEFAULT_TIMEOUT_MS) },
			transport: { type: "string", default: "home" },
			"workspace-id": {
				type: "string",
				default: process.env.TEDIX_BENCH_WORKSPACE_ID,
			},
		},
	});
	if (values.help) {
		console.log(
			"Usage: bun scripts/bench-workspace-chat/run.mjs --transport home|workspace --workspace-id <uuid> --organization <slug>",
		);
		return;
	}
	if (!values["workspace-id"])
		throw new Error("Pass --workspace-id or set TEDIX_BENCH_WORKSPACE_ID");
	if (!values.organization)
		throw new Error("Pass --organization or set TEDIX_ORGANIZATION");
	if (!new Set(["home", "workspace"]).has(values.transport))
		throw new Error("--transport must be home or workspace");
	const timeoutMs = Number(values["timeout-ms"]);
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
		throw new Error("--timeout-ms must be a positive number");
	const fixtures = JSON.parse(
		await readFile(new URL("./fixtures.json", import.meta.url), "utf8"),
	);
	const results = await runBenchmark(fixtures, {
		organization: values.organization,
		profile: values.profile,
		timeoutMs,
		transport: values.transport,
		workspaceId: values["workspace-id"],
	});
	console.table(tableRows(results));
	for (const result of results) {
		console.log(`\n${result.id} answer:\n${result.answer.trim() || "(empty)"}`);
		console.log(`run: ${result.runId}`);
	}
	if (results.some((result) => !result.ok)) process.exitCode = 1;
}

if (import.meta.main) await main();
