import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createReaderScope,
	executeD1,
	main,
	resolveInstalledReaderTools,
	READER_DIAGNOSTIC_TAIL_CHARS,
	READER_RAW_BYTE_LIMIT,
	ReaderRefusal,
	redactDiagnostic,
	REQUIRED_PROJECTION_ENDPOINTS,
	TOOL_SCHEMA_SELECT,
	type ReaderChild,
	type ReaderIo,
	type ReaderTools,
} from "./sync-tool-schemas.ts";
import {
	listContractEndpoints,
	resolveContractEndpoint,
} from "@tedix/api-contract/utils/contract-routers";
import {
	zodToToolInputJsonSchema,
	zodToStructuredOutputJsonSchema,
} from "@tedix/api-contract/utils/tool-json-schema";

const FICTION_TOKEN = "fiction-cloudflare-token-0123456789";
const tools: ReaderTools = {
	node: "/fiction/node",
	wrangler: "/fiction/wrangler/bin/wrangler.js",
	config: "/fiction/apps/api/wrangler.jsonc",
};
class Child extends EventEmitter implements ReaderChild {
	pid: number | undefined = 912345;
	stdout = new PassThrough();
	stderr = new PassThrough();
	finish(
		out: string | Uint8Array,
		err: string | Uint8Array = "",
		code: number | null = 0,
		signal: string | null = null,
	) {
		this.stdout.end(out);
		this.stderr.end(err);
		setImmediate(() => this.emit("close", code, signal));
	}
}
const report = (results: unknown[]) =>
	JSON.stringify([{ success: true, results, meta: { changes: 0 } }]);
function fixture(
	run: (child: Child, argv: readonly string[], index: number) => void = (c) =>
		c.finish(report([])),
) {
	let clock = 0;
	const commands: readonly string[][] = [];
	const mutableCommands = commands as string[][];
	const children: Child[] = [],
		kills: string[] = [],
		logs: string[] = [],
		errors: string[] = [];
	const timers = new Set<() => void>();
	const io: ReaderIo = {
		platform: "darwin",
		now: () => clock,
		setTimer: (cb) => {
			timers.add(cb);
			return cb;
		},
		clearTimer: (cb) => {
			timers.delete(cb as () => void);
		},
		resolveTools: () => tools,
		spawn: (argv) => {
			mutableCommands.push([...argv]);
			const c = new Child();
			children.push(c);
			queueMicrotask(() =>
				argv.length === 2 && argv[1] === "--version"
					? c.finish("v26.6.0\n")
					: run(c, argv, children.length - 1),
			);
			return c;
		},
		killGroup: (pid, signal) => {
			kills.push(`${pid}:${signal}`);
		},
		log: (line) => logs.push(line),
		error: (line) => errors.push(line),
		env: { CLOUDFLARE_API_TOKEN: FICTION_TOKEN, PATH: "/fiction/bin" },
	};
	return {
		io,
		commands,
		children,
		kills,
		logs,
		errors,
		timers,
		advance: (ms: number) => {
			clock += ms;
		},
		timeout: () => {
			for (const f of timers) f();
		},
	};
}
function row(endpoint: string, id = "fiction-tool") {
	const proc = resolveContractEndpoint(endpoint);
	if (!proc) throw Error("fixture endpoint absent");
	return {
		id: `fiction-row-${id}`,
		tool_id: id,
		tool_type_id: "rpc",
		schema_dialect: "json-schema-2020-12",
		input_schema: JSON.stringify(zodToToolInputJsonSchema(proc.inputSchema)),
		output_schema: JSON.stringify(
			zodToStructuredOutputJsonSchema(proc.outputSchema),
		),
		endpoint,
	};
}
const requiredRows = () =>
	REQUIRED_PROJECTION_ENDPOINTS.map((endpoint, i) =>
		row(endpoint, `fiction-${i}`),
	);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("owned bounded collector", () => {
	test("successful exact envelope, whitespace and split UTF8; drains stderr concurrently", async () => {
		const f = fixture((c) => {
			const b = Buffer.from(` \n${report([{ label: "café" }])} \n`);
			const split = b.indexOf(0xc3) + 1;
			c.stdout.write(b.subarray(0, split));
			c.stdout.write(b.subarray(split));
			c.finish("", "warning é");
		});
		const scope = createReaderScope(f.io);
		expect(await executeD1("SELECT fictional", scope, f.io, tools)).toEqual({
			results: [{ label: "café" }],
		});
		expect(f.kills).toEqual([]);
		expect(scope.rawBytes).toBeGreaterThan(0);
	});
	test("shared stdout/stderr exact8MiB accepted, next byte cancels before rejection", async () => {
		for (const extra of [0, 1]) {
			const body = report([]),
				half = 4_194_304;
			const f = fixture((c) => {
				c.stdout.write(body);
				c.stderr.write(Buffer.alloc(half, 32));
				c.finish(
					"",
					Buffer.alloc(
						READER_RAW_BYTE_LIMIT - Buffer.byteLength(body) - half + extra,
						32,
					),
				);
			});
			const scope = createReaderScope(f.io),
				p = executeD1("SELECT fictional", scope, f.io, tools);
			if (extra === 0) {
				expect(await p).toEqual({ results: [] });
				expect(scope.rawBytes).toBe(READER_RAW_BYTE_LIMIT);
			} else {
				await expect(p).rejects.toThrow("raw byte budget");
				expect(f.kills).toEqual(["912345:SIGTERM", "912345:SIGKILL"]);
				expect(scope.rawBytes).toBeLessThanOrEqual(READER_RAW_BYTE_LIMIT);
			}
		}
	});
	test("budget shared across commands and checked safe integer before retention", async () => {
		const f = fixture((c) => c.finish(report([]))),
			scope = createReaderScope(f.io);
		scope.charge(READER_RAW_BYTE_LIMIT - Buffer.byteLength(report([])));
		await executeD1("SELECT fictional", scope, f.io, tools);
		await expect(
			executeD1("SELECT fictional", scope, f.io, tools),
		).rejects.toThrow("raw byte budget");
		for (const n of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])
			expect(() => createReaderScope(f.io).charge(n)).toThrow();
	});
	for (const body of [
		"",
		"[]",
		"[{}]",
		"{}",
		report([]) + "trailer",
		"[",
		'[{"success":false,"results":[]}]',
		'[{"success":true}]',
		'[{"success":true,"results":[],"errors":["SECRET"]}]',
		'[{"success":true,"results":[]},{"success":true,"results":[]}]',
	])
		test(`strict whole result refuses ${body.slice(0, 25)}`, async () => {
			const f = fixture((c) => c.finish(body));
			await expect(
				executeD1("fiction", createReaderScope(f.io), f.io, tools),
			).rejects.toThrow("Schema reader refused");
		});
	for (const stream of ["stdout", "stderr"] as const)
		for (const data of [Buffer.from([0xff]), Buffer.from([0xc3])])
			test(`fatal ${stream} UTF8 including flush ${data[0]}`, async () => {
				const f = fixture((c) => {
					if (stream === "stdout") c.finish(data);
					else c.finish(report([]), data);
				});
				await expect(
					executeD1("fiction", createReaderScope(f.io), f.io, tools),
				).rejects.toThrow();
				expect(f.kills).toHaveLength(2);
			});
	for (const kind of [
		"exit",
		"signal",
		"spawn",
		"stream",
		"missingPID",
	] as const)
		test(`refuses ${kind} without raw diagnostics`, async () => {
			const f = fixture((c) => {
				if (kind === "spawn") c.emit("error", Error("SECRET TOKEN"));
				else if (kind === "stream")
					c.stderr.emit("error", Error("SECRET TOKEN"));
				else
					c.finish(
						report([]),
						"SECRET TOKEN",
						kind === "exit" ? 1 : 0,
						kind === "signal" ? "SIGTERM" : null,
					);
			});
			if (kind === "missingPID") {
				const original = f.io.spawn;
				f.io.spawn = (a) => {
					const c = original(a) as Child;
					c.pid = undefined;
					return c;
				};
			}
			try {
				await executeD1("SECRET SQL", createReaderScope(f.io), f.io, tools);
				throw Error("unexpected success");
			} catch (e) {
				expect(String(e)).not.toContain("SECRET");
			}
			if (kind === "missingPID") expect(f.kills).toEqual([]);
		});
	test("never-close timeout requests both signals before rejection, late events cannot revive", async () => {
		const f = fixture(() => {}),
			scope = createReaderScope(f.io),
			promise = executeD1("fiction", scope, f.io, tools);
		let rejected = false;
		const caught = promise.catch(() => {
			expect(f.kills).toHaveLength(2);
			rejected = true;
		});
		await tick();
		f.advance(30_000);
		f.timeout();
		await caught;
		expect(rejected).toBe(true);
		const bytes = scope.rawBytes;
		f.children[0]!.stdout.emit("data", Buffer.from("SECRET"));
		f.children[0]!.emit("error", Error("SECRET"));
		f.children[0]!.emit("close", 0, null);
		expect(scope.rawBytes).toBe(bytes);
		await expect(executeD1("fiction", scope, f.io, tools)).rejects.toThrow();
		expect(f.children).toHaveLength(1);
	});
	test("already-aborted and midstream abort, cancellation-unconfirmed are fixed", async () => {
		const controller = new AbortController();
		controller.abort();
		const f = fixture();
		await expect(
			executeD1(
				"fiction",
				createReaderScope(f.io, controller.signal),
				f.io,
				tools,
			),
		).rejects.toThrow("aborted");
		expect(f.children).toHaveLength(0);
		const ctl = new AbortController(),
			g = fixture(() => {});
		g.io.killGroup = () => {
			throw Error("SECRET");
		};
		const p = executeD1(
			"fiction",
			createReaderScope(g.io, ctl.signal),
			g.io,
			tools,
		);
		await tick();
		ctl.abort();
		await expect(p).rejects.toThrow("cancellation unconfirmed");
	});
	test("unsupported process groups refuse before spawn", async () => {
		const f = fixture();
		(f.io as { platform: string }).platform = "win32";
		await expect(
			executeD1("fiction", createReaderScope(f.io), f.io, tools),
		).rejects.toThrow("unsupported");
		expect(f.children).toHaveLength(0);
	});
	test("one real fictional owned node child ignores TERM; requests/reaping remain bounded", async () => {
		const node = Bun.which("node");
		if (!node) throw Error("existing Node missing");
		const f = fixture(),
			signals: string[] = [];
		let closed: Promise<void> | undefined;
		f.io.spawn = () => {
			const c = spawn(
				node,
				[
					"-e",
					'process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},1000)',
				],
				{ detached: true, stdio: ["ignore", "pipe", "pipe"] },
			);
			closed = new Promise((resolve) => c.once("close", () => resolve()));
			return c;
		};
		f.io.killGroup = (pid, signal) => {
			signals.push(signal);
			try {
				process.kill(-pid, signal);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
			}
		};
		const scope = createReaderScope(f.io),
			p = executeD1("fiction", scope, f.io, tools);
		for (let i = 0; i < 100 && scope.rawBytes === 0; i++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(scope.rawBytes).toBeGreaterThan(0);
		f.advance(30_000);
		f.timeout();
		await expect(p).rejects.toThrow("deadline");
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				closed,
				new Promise((_, reject) => {
					timer = setTimeout(
						() => reject(Error("fictional child close not confirmed")),
						1000,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	});
});

describe("real registry and owning main", () => {
	test("all required projections and actual converter schemas pass complete check without a writer", async () => {
		const rows = requiredRows(),
			f = fixture((c) => c.finish(report(rows)));
		expect(await main(["--check"], f.io)).toBe(0);
		expect(f.commands).toHaveLength(2);
		expect(f.commands[1]!.at(-1)).toBe(TOOL_SCHEMA_SELECT);
		expect(f.commands[1]!.slice(2, 10)).toEqual([
			"d1",
			"execute",
			"DB",
			"--remote",
			"--config",
			tools.config,
			"--json",
			"--command",
		]);
		expect(f.logs.join("\n")).toContain("Check passed");
		expect(f.errors).toEqual([]);
	});
	test("empty valid data still fails all required missing projections", async () => {
		const f = fixture();
		expect(await main(["--check"], f.io)).toBe(1);
		expect(f.logs.join("\n")).toContain("missingProjection");
		expect(f.commands).toHaveLength(2);
	});
	for (const mutation of [
		"input",
		"output",
		"type",
		"dialect",
		"missing",
		"endpoint",
		"nested",
		"alias",
	] as const)
		test(`real main ${mutation} refusal/failure`, async () => {
			const rows = requiredRows(),
				first = rows[0]!;
			if (mutation === "input") first.input_schema = "{}";
			if (mutation === "output") first.output_schema = "{}";
			if (mutation === "type") first.tool_type_id = "other";
			if (mutation === "dialect") first.schema_dialect = "old";
			if (mutation === "missing")
				(first as { input_schema: string | null }).input_schema = null;
			if (mutation === "endpoint") first.endpoint = "fiction/missing";
			if (mutation === "nested") first.input_schema = "{";
			if (mutation === "alias")
				delete (first as Partial<typeof first>).schema_dialect;
			const f = fixture((c) => c.finish(report(rows)));
			expect(await main(["--check"], f.io)).toBe(1);
			expect(f.commands).toHaveLength(2);
			expect(f.logs.join("\n")).not.toContain("Check passed");
		});
	test("converterUnsupported is a check failure from actual registry, raw message omitted", async () => {
		const endpoint = listContractEndpoints({ includeInternal: true })
			.map((x) => `${x.router}/${x.procPath}`)
			.find((x) => {
				const p = resolveContractEndpoint(x)!;
				try {
					zodToToolInputJsonSchema(p.inputSchema);
					zodToStructuredOutputJsonSchema(p.outputSchema);
					return false;
				} catch {
					return true;
				}
			});
		expect(endpoint).toBeDefined();
		const f = fixture((c) =>
			c.finish(
				report([
					{
						id: "fiction",
						tool_id: "unsupported",
						tool_type_id: "rpc",
						schema_dialect: "json-schema-2020-12",
						input_schema: null,
						output_schema: null,
						endpoint,
					},
				]),
			),
		);
		expect(await main(["--check", "--only=unsupported"], f.io)).toBe(1);
		expect(f.logs.join("\n")).toContain("converterUnsupported");
	});
	test("dry-run drift does not fail; only filter skips required projections", async () => {
		const f = fixture((c) =>
			c.finish(report([row(REQUIRED_PROJECTION_ENDPOINTS[0], "chosen")])),
		);
		expect(await main(["--only=chosen"], f.io)).toBe(0);
		expect(f.commands).toHaveLength(2);
		const g = fixture();
		expect(await main([], g.io)).toBe(0);
	});
	test("apply precedence, app-scoped stale DELETE and schema UPDATE quoting", async () => {
		const valid = row(REQUIRED_PROJECTION_ENDPOINTS[0], "needs-update");
		valid.input_schema = "{}";
		valid.id = "fiction'quoted";
		const stale = {
			...valid,
			id: "stale'quoted",
			tool_id: "stale",
			endpoint: "fiction/missing",
		};
		const f = fixture((c, a) =>
			c.finish(report(a.at(-1) === TOOL_SCHEMA_SELECT ? [valid, stale] : [])),
		);
		expect(
			await main(["--check", "--apply", "--only=needs-update,stale"], f.io),
		).toBe(0);
		const sql = f.commands.slice(2).map((a) => a.at(-1)!);
		expect(sql).toHaveLength(2);
		expect(sql.join("\n")).toContain("stale''quoted");
		expect(sql.join("\n")).toContain("fiction''quoted");
		for (const text of sql)
			expect(text).toContain(
				"AND app_id = (SELECT id FROM apps WHERE slug = 'tedix')",
			);
		expect(sql.join("\n")).toContain("schema_source = 'orpc'");
	});
	test("failure after earlier apply write does not retry, claim rollback or completion", async () => {
		const rows = ["a", "b"].map((id) => ({
			...row(REQUIRED_PROJECTION_ENDPOINTS[0], id),
			endpoint: "fiction/missing",
		}));
		const f = fixture((c, a, i) =>
			c.finish(
				report(a.at(-1) === TOOL_SCHEMA_SELECT ? rows : []),
				`write failed with ${FICTION_TOKEN}`,
				i === 3 ? 1 : 0,
			),
		);
		expect(await main(["--apply", "--only=a,b"], f.io)).toBe(1);
		expect(f.commands).toHaveLength(4);
		expect(f.logs.join("\n")).not.toContain("Apply complete");
		const printed = f.errors.join("\n");
		expect(printed).toContain("exited with code 1");
		expect(printed).toContain(
			"write failed with [redacted CLOUDFLARE_API_TOKEN]",
		);
		expect(printed).not.toContain(FICTION_TOKEN);
	});
	test("one original deadline covers tool resolution and later commands; mutable args/io cannot renew", async () => {
		const f = fixture();
		f.io.resolveTools = async () => {
			f.advance(30_000);
			return tools;
		};
		expect(await main(["--check"], f.io)).toBe(1);
		expect(f.commands).toHaveLength(0);
		const g = fixture((c) => {
			g.advance(30_000);
			c.finish(report(requiredRows()));
		});
		expect(await main(["--check"], g.io)).toBe(1);
		expect(g.logs.join("\n")).not.toContain("Check passed");
		const args = ["--check", "--only=chosen"],
			h = fixture((c) =>
				c.finish(report([row(REQUIRED_PROJECTION_ENDPOINTS[0], "chosen")])),
			);
		h.io.resolveTools = async () => {
			args.push("--apply");
			h.io.spawn = () => {
				throw Error("SECRET");
			};
			return tools;
		};
		expect(await main(args, h.io)).toBe(0);
		expect(h.commands).toHaveLength(2);
	});
	test("unsupported Node and tool preflight failures never start D1", async () => {
		const f = fixture();
		f.io.spawn = (_a) => {
			const c = new Child();
			queueMicrotask(() => c.finish("v20.0.0"));
			return c;
		};
		expect(await main([], f.io)).toBe(1);
		expect(f.commands).toHaveLength(0);
		expect(f.errors.join("\n")).toContain('reported "v20.0.0"');
		const g = fixture();
		g.io.resolveTools = () => {
			throw Error(`unexpected ${FICTION_TOKEN}`);
		};
		expect(await main([], g.io)).toBe(1);
		expect(g.errors[0]).toBe("Schema reader refused: execution.");
		expect(g.errors.join("\n")).toContain("unexpected [redacted");
		expect(g.errors.join("\n")).not.toContain(FICTION_TOKEN);
	});
});

describe("publication and immutable original scope", () => {
	test("import-safe module evaluation emits no output or process exit", async () => {
		const logs: string[] = [];
		const original = console.log,
			error = console.error,
			exit = process.exitCode;
		console.log = (...v: unknown[]) => {
			logs.push(String(v));
		};
		console.error = (...v: unknown[]) => {
			logs.push(String(v));
		};
		try {
			const imported = await import(
				`./sync-tool-schemas.ts?offline-import=${Date.now()}`
			);
			expect(typeof imported.main).toBe("function");
			expect(logs).toEqual([]);
			expect(process.exitCode).toBe(exit);
		} finally {
			console.log = original;
			console.error = error;
		}
	});
	test("late analysis/publication clock cannot print PASS or write", async () => {
		const f = fixture((c) => c.finish(report(requiredRows()))),
			log = f.io.log;
		f.io.log = (line) => {
			log(line);
			if (line.startsWith("\nSummary")) f.advance(30_000);
		};
		expect(await main(["--check"], f.io)).toBe(1);
		expect(f.logs.join("\n")).not.toContain("Check passed");
		expect(f.commands).toHaveLength(2);
	});
	test("deadline never renews between apply commands", async () => {
		const rows = ["a", "b"].map((id) => ({
			...row(REQUIRED_PROJECTION_ENDPOINTS[0], id),
			endpoint: "fiction/missing",
		}));
		const f = fixture((c, a, i) => {
			if (i === 2) f.advance(30_000);
			c.finish(report(a.at(-1) === TOOL_SCHEMA_SELECT ? rows : []));
		});
		expect(await main(["--apply", "--only=a,b"], f.io)).toBe(1);
		expect(f.commands).toHaveLength(3);
		expect(f.logs.join("\n")).not.toContain("Apply complete");
	});
	test("nonfinite or backward original monotonic clock refuses", () => {
		const f = fixture(),
			scope = createReaderScope(f.io);
		f.advance(10);
		scope.check();
		f.advance(-1);
		expect(() => scope.check()).toThrow("deadline");
		const g = fixture();
		g.advance(NaN);
		expect(() => createReaderScope(g.io).check()).toThrow("deadline");
	});
});

describe("diagnosable refusals", () => {
	// Regression: a failed deploy repair step printed nothing or only a fixed
	// stage, so a Wrangler failure (e.g. account selection) was undiagnosable.
	test("child failure prints exit status and redacted, bounded stderr/stdout tails", async () => {
		const wranglerError = JSON.stringify({
			error: { text: "More than one account available" },
		});
		const f = fixture((c) =>
			c.finish(
				wranglerError,
				`${"x".repeat(10_000)}\u001b[31m✘ [ERROR]\u001b[0m Authorization: Bearer ${FICTION_TOKEN}\nretry with ${FICTION_TOKEN}`,
				1,
			),
		);
		expect(await main(["--check"], f.io)).toBe(1);
		expect(f.errors[0]).toBe(
			"Schema reader refused: child status or incomplete streams.",
		);
		const cause = f.errors.slice(1).join("\n");
		expect(cause).toStartWith(
			"Cause: `node wrangler.js d1 execute` exited with code 1, signal none",
		);
		expect(cause).toContain("✘ [ERROR] Authorization: Bearer [redacted");
		expect(redactDiagnostic("Authorization: Bearer abcdefgh12345")).toBe(
			"Authorization: Bearer [redacted]",
		);
		expect(cause).toContain("retry with [redacted CLOUDFLARE_API_TOKEN]");
		expect(cause).toContain("More than one account available");
		expect(cause).not.toContain(FICTION_TOKEN);
		expect(cause).not.toContain("\u001b");
		expect(cause).not.toContain(TOOL_SCHEMA_SELECT);
		expect(cause.length).toBeLessThan(2 * READER_DIAGNOSTIC_TAIL_CHARS + 500);
	});
	test("spawn failure names the errno", async () => {
		const f = fixture((c) =>
			c.emit(
				"error",
				Object.assign(Error("spawn /fiction/node ENOENT"), { code: "ENOENT" }),
			),
		);
		expect(await main(["--check"], f.io)).toBe(1);
		expect(f.errors).toEqual([
			"Schema reader refused: spawn.",
			expect.stringContaining("ENOENT"),
		]);
	});
	test("redaction masks secret-named env values, keeps the tail", () => {
		expect(
			redactDiagnostic("a CF_DEPLOY_TOKEN=abcdefgh123 b", {
				CF_DEPLOY_TOKEN: "abcdefgh123",
				HOME: "/home/fiction",
				SHORT_TOKEN: "abc",
			}),
		).toBe("a CF_DEPLOY_TOKEN=[redacted CF_DEPLOY_TOKEN] b");
		expect(redactDiagnostic("0123456789", {}, 4)).toBe("…6789");
	});
	test("the real script, run the way deploy runs it, never fails silently", () => {
		// No node on PATH: the reader must refuse with a printed cause, not exit
		// quietly. Read-only and offline: refusal precedes any Wrangler call.
		const empty = mkdtempSync(join(tmpdir(), "sync-tool-schemas-path-"));
		try {
			const result = spawnSync(
				process.execPath,
				[
					fileURLToPath(new URL("./sync-tool-schemas.ts", import.meta.url)),
					"--check",
				],
				{
					cwd: fileURLToPath(new URL("../../apps/api/", import.meta.url)),
					env: { PATH: empty, HOME: empty },
					encoding: "utf8",
					timeout: 20_000,
				},
			);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(
				"Schema reader refused: installed tools.",
			);
			expect(result.stderr).toMatch(/Cause: failed check: /);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});

describe("installed package preflight", () => {
	const root = "/fiction",
		pkg = "/installed/wrangler";
	function files() {
		return {
			realpath: (p: string) =>
				p === `${root}/node_modules/wrangler`
					? pkg
					: p === `${root}/node_modules/.bin/wrangler`
						? `${pkg}/bin/wrangler.js`
						: p,
			isFile: () => true,
			read: () =>
				JSON.stringify({
					name: "wrangler",
					bin: { wrangler: "./bin/wrangler.js" },
				}),
			findNode: () => "/installed/node",
		};
	}
	test("only exact installed package entry and executable accepted", () => {
		expect(resolveInstalledReaderTools(root, files())).toEqual({
			node: "/installed/node",
			wrangler: `${pkg}/bin/wrangler.js`,
			config: "/fiction/apps/api/wrangler.jsonc",
		});
	});
	const failedCheck = {
		alias: "node_modules/.bin/wrangler resolves to the package entry",
		package: "wrangler package.json name/bin",
		node: "executable node on PATH",
		regular: "node_modules/.bin/wrangler resolves to the package entry",
	} as const;
	for (const kind of ["alias", "package", "node", "regular"] as const)
		test(`${kind} malformed refuses without package fallback, naming the failed check`, () => {
			const f = files();
			if (kind === "alias") f.realpath = () => "/outside";
			if (kind === "package") f.read = () => '{"name":"other"}';
			if (kind === "node") f.findNode = () => null as unknown as string;
			if (kind === "regular") f.isFile = () => false;
			let caught: unknown;
			try {
				resolveInstalledReaderTools(root, f);
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(ReaderRefusal);
			expect((caught as ReaderRefusal).message).toBe(
				"Schema reader refused: installed tools.",
			);
			expect((caught as ReaderRefusal).detail).toContain(failedCheck[kind]);
		});
});
