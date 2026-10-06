import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createLogger, type LogValue, type ReservedLogField } from "./logger";

type TestFields = {
	requestId: string;
	attempt: number;
	outcome: "ok" | "denied";
	// Reserved names a caller might plausibly declare. Declaring them is legal;
	// PASSING them is what must not compile.
	token: string;
	secret: string;
	prompt: string;
	headers: Record<string, string>;
	body: string;
	exception: { type: string };
};

const logger = createLogger<TestFields>({ component: "test.subject" });

function spyOnConsole(level: "debug" | "info" | "warn" | "error") {
	return vi.spyOn(console, level).mockImplementation(() => {});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("reserved-field prohibition (type level)", () => {
	/**
	 * These assertions ARE the guarantee. Each `@ts-expect-error` fails to
	 * compile if the line ever STOPS erroring — so if the `?: never` mapped type
	 * is weakened or a name leaves `ReservedLogField`, `tsc --noEmit` on this
	 * package fails with "Unused '@ts-expect-error' directive".
	 *
	 * Run by `bun run --filter @tedix/worker-kit type-check`, not by Vitest.
	 */
	// Each directive sits directly above the offending PROPERTY, not above the
	// call, so a formatter reflowing the call cannot move the assertion off the
	// line it is asserting about.
	test("a reserved field name is a compile error in call details", () => {
		logger.info("resolved credential", {
			event: "cred.resolved",
			// @ts-expect-error -- `token` is reserved and must never be loggable.
			token: "sk_live_x",
		});
		logger.warn("rotated", {
			event: "cred.rotated",
			// @ts-expect-error -- `secret` is reserved and must never be loggable.
			secret: "hunter2",
		});
		logger.debug("model call", {
			event: "model.call",
			// @ts-expect-error -- `prompt` is reserved and must never be loggable.
			prompt: "you are...",
		});
		logger.info("upstream", {
			event: "http.sent",
			// @ts-expect-error -- `headers` is reserved and must never be loggable.
			headers: { a: "b" },
		});
		logger.error("upstream failed", {
			event: "http.failed",
			// @ts-expect-error -- `body` is reserved and must never be loggable.
			body: "{...}",
		});
		logger.error("upstream failed", {
			event: "http.failed",
			// @ts-expect-error -- only the logger may emit a structured exception.
			exception: { type: "Forged" },
		});
		expect(true).toBe(true);
	});

	test("a reserved field name is a compile error in logger defaults", () => {
		createLogger<TestFields>({
			component: "test.subject",
			// @ts-expect-error -- defaults cannot carry a reserved field either.
			token: "sk_live_x",
		});
		expect(true).toBe(true);
	});

	test("a reserved field name is a compile error in `with()` child fields", () => {
		logger.with({
			// @ts-expect-error -- child-field inheritance cannot smuggle one in.
			secret: "hunter2",
		});
		expect(true).toBe(true);
	});

	test("non-reserved fields still compile, and `event` stays required", () => {
		logger.info("ok", {
			event: "unit.ok",
			requestId: "r1",
			attempt: 1,
			outcome: "ok",
		});
		logger.info(
			"no event",
			// @ts-expect-error -- `event` is required on every call. A MISSING
			// property is reported on the object literal, so this one directive
			// belongs above the argument rather than above a property.
			{ requestId: "r1" },
		);
		logger.info("bad union", {
			event: "unit.bad",
			// @ts-expect-error -- a value outside the declared union is rejected.
			outcome: "maybe",
		});
		logger.info("undeclared", {
			event: "unit.undeclared",
			// @ts-expect-error -- an undeclared field is rejected.
			nope: 1,
		});
		expect(true).toBe(true);
	});

	test("the reserved union is the exact protected set", () => {
		// A compile-time exhaustiveness pin: removing or renaming a member makes
		// this assignment fail, so the union cannot silently shrink.
		const reserved: Record<ReservedLogField, true> = {
			body: true,
			component: true,
			error: true,
			errorStack: true,
			exception: true,
			event: true,
			header: true,
			headers: true,
			message: true,
			prompt: true,
			secret: true,
			token: true,
		};
		expect(Object.keys(reserved).sort()).toEqual([
			"body",
			"component",
			"error",
			"errorStack",
			"event",
			"exception",
			"header",
			"headers",
			"message",
			"prompt",
			"secret",
			"token",
		]);
	});

	test("LogValue admits structured data and rejects nothing it should carry", () => {
		const value: LogValue = { a: 1, b: ["x", true, null], c: new Date(0) };
		expect(value).toBeTruthy();
	});
});

describe("emission", () => {
	test("emits exactly one structured object per call", () => {
		const spy = spyOnConsole("info");
		logger.info("tool resolved", {
			event: "tool.resolved",
			requestId: "r1",
			outcome: "ok",
		});
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]).toHaveLength(1);
		expect(spy.mock.calls[0]?.[0]).toEqual({
			component: "test.subject",
			event: "tool.resolved",
			requestId: "r1",
			outcome: "ok",
			message: "tool resolved",
		});
	});

	test("routes each method to its own console level", () => {
		const debug = spyOnConsole("debug");
		const warn = spyOnConsole("warn");
		const error = spyOnConsole("error");
		logger.debug("d", { event: "e" });
		logger.warn("w", { event: "e" });
		logger.error("x", { event: "e" });
		expect(debug).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalledTimes(1);
	});

	test("`with()` inherits fields without mutating the parent", () => {
		const spy = spyOnConsole("info");
		const child = logger.with({ requestId: "r2" });
		child.info("child", { event: "child.ok" });
		logger.info("parent", { event: "parent.ok" });
		expect(spy.mock.calls[0]?.[0]).toMatchObject({ requestId: "r2" });
		expect(spy.mock.calls[1]?.[0]).not.toHaveProperty("requestId");
	});

	test("call details override inherited fields but never `component`", () => {
		const spy = spyOnConsole("info");
		logger
			.with({ requestId: "inherited" })
			.info("override", { event: "e", requestId: "per-call" });
		expect(spy.mock.calls[0]?.[0]).toMatchObject({
			requestId: "per-call",
			component: "test.subject",
		});
	});

	test("omits `error` entirely when none was passed", () => {
		const spy = spyOnConsole("info");
		logger.info("clean", { event: "e" });
		expect(spy.mock.calls[0]?.[0]).not.toHaveProperty("error");
		expect(spy.mock.calls[0]?.[0]).not.toHaveProperty("errorStack");
		expect(spy.mock.calls[0]?.[0]).not.toHaveProperty("exception");
	});

	test("normalizes an Error into `error` plus `errorStack`", () => {
		const spy = spyOnConsole("error");
		logger.error("boom", { event: "e", error: new TypeError("bad input") });
		const payload = spy.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(payload.error).toBe("TypeError: bad input");
		expect(String(payload.errorStack)).toContain("bad input");
		expect(payload.exception).toMatchObject({
			type: "TypeError",
			message: "bad input",
		});
	});

	test("keeps a bounded, structured cause chain", () => {
		const spy = spyOnConsole("error");
		const root = new Error("database unavailable");
		const error = new TypeError("request failed", { cause: root });
		logger.error("boom", { event: "request.failed", error });
		const payload = spy.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(payload.error).toBe("TypeError: request failed");
		expect(payload.exception).toMatchObject({
			type: "TypeError",
			message: "request failed",
			cause: { type: "Error", message: "database unavailable" },
		});
	});

	test("bounds aggregate errors, cycles and oversized messages", () => {
		const spy = spyOnConsole("error");
		const cycle = new Error("x".repeat(2048));
		(cycle as Error & { cause: unknown }).cause = cycle;
		logger.error("boom", {
			event: "request.failed",
			error: new AggregateError([cycle, "plain throw"], "many failures"),
		});
		const payload = spy.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(payload.exception).toMatchObject({
			type: "AggregateError",
			message: "many failures",
			errors: [
				{
					type: "Error",
					truncated: true,
					cause: { type: "CircularCause", truncated: true },
				},
				{ type: "stringThrown", message: "plain throw" },
			],
		});
		const exception = payload.exception as {
			errors: Array<{ message: string }>;
		};
		expect(exception.errors[0]?.message).toHaveLength(1024);
	});

	test("normalizes a non-Error throw without inventing a stack", () => {
		const spy = spyOnConsole("error");
		logger.error("boom", { event: "e", error: { message: "plain object" } });
		const payload = spy.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(payload.error).toBe("plain object");
		expect(payload).not.toHaveProperty("errorStack");
	});

	test("normalizes a thrown primitive", () => {
		const spy = spyOnConsole("error");
		logger.error("boom", { event: "e", error: "just a string" });
		const payload = spy.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(payload.error).toBe("just a string");
	});

	test("reports a hostile thrown object without throwing again", () => {
		const spy = spyOnConsole("error");
		const thrown = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error("unreadable");
				},
				getOwnPropertyDescriptor() {
					throw new Error("unreadable");
				},
			},
		);
		expect(() =>
			logger.error("boom", { event: "e", error: thrown }),
		).not.toThrow();
		expect(spy.mock.calls[0]?.[0]).toMatchObject({
			error: "Uninspectable thrown value",
			exception: { type: "UninspectableThrown", truncated: true },
		});
	});
});
