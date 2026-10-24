import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createPiTelemetry, type PiTraceSink } from "./pi-telemetry";

const secret = "PRIVATE prompt tool payload credential https://private.example";
const warnings: unknown[] = [];
const originalWarn = console.warn;
console.warn = (...fields) => warnings.push(fields);
try {
	const active = new AsyncLocalStorage<string>();
	const spans: Array<{
		name: string;
		parent?: string;
		attributes: Record<string, unknown>;
	}> = [];
	const rejections: unknown[] = [];
	const enter: PiTraceSink = async (name, run) => {
		const row = {
			name,
			parent: active.getStore(),
			attributes: {} as Record<string, unknown>,
		};
		spans.push(row);
		try {
			return await active.run(name, () =>
				run({
					setAttribute(key, value) {
						row.attributes[key] = value;
					},
				}),
			);
		} catch (error) {
			rejections.push(error);
			throw error;
		}
	};
	const telemetry = createPiTelemetry(enter);
	const failure = Object.assign(new Error(secret), { name: secret });
	await active.run("existing.worker.parent", async () => {
		await assert.rejects(
			telemetry.startSpan(
				{
					name: "pi.durable.phase",
					attributes: {
						"task.id": 41,
						"task.name": "pi.generation",
						phase: "request",
						resumed: true,
						"tool.name": secret,
						[secret]: 123,
						provider: secret,
						"usage.output": Infinity,
					},
				},
				async (span) => {
					await Promise.resolve();
					span.setStatus({
						status: "error",
						error: { name: secret, message: secret },
					});
					await span.startSpan(
						{ name: "pi.ai.request", attributes: { model: secret } },
						async (child) => {
							child.setAttributes({
								"usage.output": 17,
								"response.id": secret,
								phase: secret,
							});
							child.addEvent("pi.ai.block", {
								type: "text",
								chars: 10,
								tool: secret,
							});
							child.addEvent(secret, { chars: 5 });
						},
					);
					throw failure;
				},
			),
			(error) => error === failure,
		);
	});
	assert.deepEqual(
		rejections,
		[],
		"private failures never reject the native trace callback",
	);
	assert.equal(spans[0]?.parent, "existing.worker.parent");
	assert.equal(spans[1]?.parent, "pi.durable.phase");
	assert.equal(spans[2]?.parent, "pi.ai.request");
	assert.equal(spans[0]?.attributes["task.id"], 41);
	assert.equal(spans[0]?.attributes["pi.status"], "error");
	assert.equal(spans[1]?.attributes["usage.output"], 17);
	assert.ok(!JSON.stringify(spans).includes("PRIVATE"));
	assert.ok(!JSON.stringify(spans).includes("private.example"));
	assert.equal(spans.length, 3);
	await telemetry.startSpan({ name: secret }, async () => {});
	assert.equal(spans.at(-1)?.name, "pi.operation");
	const hostile = Object.defineProperty({}, "task.id", {
		enumerable: true,
		get() {
			throw failure;
		},
	});
	let metadataCalls = 0;
	for (const options of [
		{ name: "pi.durable.phase", attributes: hostile },
		Object.defineProperty({ name: "pi.durable.phase" }, "attributes", {
			get() {
				throw failure;
			},
		}),
		Object.defineProperty({ name: "pi.durable.phase" }, "name", {
			get() {
				throw failure;
			},
		}),
	]) {
		assert.equal(
			await telemetry.startSpan(options, async (span) => {
				metadataCalls++;
				span.setAttributes(hostile);
				span.addEvent("pi.ai.block", hostile);
				return "preserved";
			}),
			"preserved",
		);
	}
	assert.equal(metadataCalls, 3);
	let nameReads = 0;
	const changingName = Object.defineProperty(
		{ name: "pi.durable.phase" },
		"name",
		{
			get() {
				return nameReads++ === 0 ? "pi.durable.phase" : secret;
			},
		},
	);
	await telemetry.startSpan(changingName, async () => {});
	assert.equal(nameReads, 1);
	assert.ok(!JSON.stringify(spans).includes("PRIVATE"));

	for (const mode of [
		"throw-before",
		"reject-before",
		"throw-after",
		"reject-after",
		"throw-attribute",
		"reject-attribute",
	] as const) {
		let calls = 0;
		const broken: PiTraceSink = (name, run) => {
			if (mode === "throw-before") throw new Error(secret);
			if (mode === "reject-before") return Promise.reject(new Error(secret));
			const pending = run({
				setAttribute() {
					if (mode === "throw-attribute") throw new Error(secret);
					if (mode === "reject-attribute")
						return Promise.reject(new Error(secret));
				},
			});
			if (mode === "throw-after") throw new Error(secret);
			if (mode === "reject-after")
				return pending.then(() => {
					throw new Error(secret);
				});
			return pending;
		};
		const adapter = createPiTelemetry(broken);
		assert.equal(
			await adapter.startSpan(
				{ name: "pi.durable.phase", attributes: { "task.id": 1 } },
				async (span) => {
					calls++;
					span.setStatus({ status: "ok" });
					return "owned result";
				},
			),
			"owned result",
		);
		assert.equal(calls, 1, mode);
		await assert.rejects(
			adapter.startSpan({ name: "pi.durable.phase" }, async () => {
				throw failure;
			}),
			(error) => error === failure,
		);
		const aborted = new DOMException(secret, "AbortError");
		await assert.rejects(
			adapter.startSpan({ name: "pi.durable.phase" }, async () => {
				throw aborted;
			}),
			(error) => error === aborted,
		);
	}
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.ok(!JSON.stringify(warnings).includes("PRIVATE"));
} finally {
	console.warn = originalWarn;
}
console.log(
	"Native Pi tracing: active parent, fixed metadata, exact errors and optional sink containment pass",
);
