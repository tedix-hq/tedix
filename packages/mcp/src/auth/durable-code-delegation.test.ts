import { describe, expect, it } from "vite-plus/test";
import {
	createDurableCodeDelegation,
	createMachineDurableCodeDelegation,
	verifyDurableCodeDelegation,
	requiredDurableCodeCapability,
	type DurableCodeCaller,
	type DurableCodeOperation,
} from "./durable-code-delegation";
const tediId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const now = 1_791_124_574_000;
const binding = {
	tediId,
	organizationId,
	operation: "approve_code_execution" as const,
	arguments: { execution_id: "exec_test" },
};
const caller: DurableCodeCaller = {
	classification: "human",
	principal: {
		authenticated: true,
		verified: true,
		source: "aih-oauth",
		subject: "human-123",
		email: "human@example.com",
		orgId: organizationId,
		scopes: ["mcp:tedis.admin"],
		audiences: ["connect"],
	},
};
const create = (
	changes: Partial<Parameters<typeof createDurableCodeDelegation>[0]> = {},
) => createDurableCodeDelegation({ ...binding, caller, now, ...changes });
const verify = (
	envelope: unknown,
	changes: Partial<Parameters<typeof verifyDurableCodeDelegation>[0]> = {},
) =>
	verifyDurableCodeDelegation({
		...binding,
		transport: "trusted-service-binding",
		envelope,
		now,
		...changes,
	});
describe("durable-code request binding", () => {
	it("preserves a positively classified operator on the exact trusted request", async () => {
		const envelope = await create();
		const result = await verify(envelope);
		expect(result.ok).toBe(true);
		if (result.ok)
			expect(result.delegation.operator).toEqual({
				classification: "human",
				subject: "human-123",
				email: "human@example.com",
			});
		expect(await verify(envelope, { transport: "public" })).toEqual({
			ok: false,
			reason: "untrusted_transport",
		});
	});
	it("denies human-shaped external agents, machines and services", async () => {
		for (const classification of [
			"external-agent",
			"tedi",
			"m2m",
			"service",
		] as const)
			await expect(
				create({ caller: { ...caller, classification } }),
			).rejects.toThrow("Verified human");
		for (const patch of [
			{ verified: false },
			{ authenticated: false },
			{ tediId },
			{ email: undefined },
			{ subject: undefined },
			{ source: "aih-m2m" as const },
			{ source: "service-binding" as const },
			{ orgId: tediId },
		])
			await expect(
				create({
					caller: { ...caller, principal: { ...caller.principal, ...patch } },
				}),
			).rejects.toThrow("Verified human");
	});
	it("does not promote read/write authority to approval administration", async () => {
		for (const scope of ["mcp:tedis.read", "mcp:tedis.write"])
			await expect(
				create({
					caller: {
						...caller,
						principal: { ...caller.principal, scopes: [scope] },
					},
				}),
			).rejects.toThrow("operation permission");
		const expected: Record<DurableCodeOperation, string> = {
			run_durable_code: "mcp:tedis.write",
			list_code_executions: "mcp:tedis.read",
			get_code_execution: "mcp:tedis.read",
			approve_code_execution: "mcp:tedis.admin",
			reject_code_execution: "mcp:tedis.admin",
			rollback_code_execution: "mcp:tedis.admin",
			recover_code_execution: "mcp:tedis.admin",
		};
		for (const [operation, scope] of Object.entries(expected))
			expect(
				requiredDurableCodeCapability(operation as DurableCodeOperation),
			).toBe(scope);
	});
	it("binds worker, organization, operation, capability and arguments", async () => {
		const envelope = await create();
		for (const patch of [
			{ tediId: organizationId },
			{ organizationId: tediId },
			{ operation: "rollback_code_execution" as const },
			{ arguments: { execution_id: "other" } },
		])
			expect(await verify(envelope, patch)).toEqual({
				ok: false,
				reason: "binding_mismatch",
			});
		expect(
			await verify({ ...envelope, capability: "mcp:tedis.write" }),
		).toEqual({ ok: false, reason: "binding_mismatch" });
	});
	it("normalizes key ordering without changing arrays or code text", async () => {
		const envelope = await create({
			arguments: { z: 2, a: { right: 2, left: 1 }, array: [1, 2], code: " a " },
		});
		expect(
			(
				await verify(envelope, {
					arguments: {
						code: " a ",
						array: [1, 2],
						a: { left: 1, right: 2 },
						z: 2,
					},
				})
			).ok,
		).toBe(true);
		for (const argumentsValue of [
			{ z: 2, a: { right: 2, left: 1 }, array: [2, 1], code: " a " },
			{ z: 2, a: { right: 2, left: 1 }, array: [1, 2], code: "a" },
		])
			expect((await verify(envelope, { arguments: argumentsValue })).ok).toBe(
				false,
			);
	});
	it("rejects malformed provenance and invalid temporal bounds", async () => {
		const envelope = await create();
		for (const patch of [
			{ issuer: "other" },
			{ audience: "other" },
			{ version: 2 },
			{ operator: { ...envelope.operator, classification: "external-agent" } },
			{ argumentsDigest: "bad" },
			{ unknown: true },
		])
			expect(await verify({ ...envelope, ...patch })).toEqual({
				ok: false,
				reason: "invalid_envelope",
			});
		for (const patch of [
			{ expiresAt: now },
			{ issuedAt: now + 5001 },
			{ expiresAt: now + 60001 },
			{ issuedAt: now, expiresAt: now - 1 },
		])
			expect(await verify({ ...envelope, ...patch })).toEqual({
				ok: false,
				reason: "invalid_time",
			});
		for (const lifetimeMs of [0, -1, 60001, 1.5])
			await expect(create({ lifetimeMs })).rejects.toThrow("lifetime");
	});
	it("claims request binding only; repeat verification is allowed until expiry", async () => {
		const envelope = await create({ lifetimeMs: 1000 });
		expect((await verify(envelope)).ok).toBe(true);
		expect((await verify(envelope, { now: now + 999 })).ok).toBe(true);
		expect(await verify(envelope, { now: now + 1000 })).toEqual({
			ok: false,
			reason: "invalid_time",
		});
	});
	it("rejects prototype keys before parsing can silently discard them", async () => {
		const envelope = await create();
		for (const argumentsValue of [
			JSON.parse('{"execution_id":"exec_test","__proto__":{"admin":true}}'),
			JSON.parse(
				'{"execution_id":"exec_test","nested":{"__proto__":{"admin":true}}}',
			),
			JSON.parse(
				'{"execution_id":"exec_test","nested":[{"__proto__":{"admin":true}}]}',
			),
		]) {
			await expect(create({ arguments: argumentsValue })).rejects.toThrow(
				"Unsafe delegation",
			);
			expect(await verify(envelope, { arguments: argumentsValue })).toEqual({
				ok: false,
				reason: "binding_mismatch",
			});
		}
	});
	it("requires the owning schema to normalize defaults before binding", async () => {
		const request = {
			operation: "list_code_executions" as const,
			arguments: { limit: 20 },
		};
		const envelope = await create({
			...request,
			caller: {
				...caller,
				principal: { ...caller.principal, scopes: ["mcp:tedis.read"] },
			},
		});
		expect((await verify(envelope, request)).ok).toBe(true);
		expect((await verify(envelope, { ...request, arguments: {} })).ok).toBe(
			false,
		);
	});
	it("rejects invalid creation clocks and overflowed expiry", async () => {
		for (const nowValue of [
			NaN,
			Infinity,
			-1,
			1.5,
			Number.MAX_SAFE_INTEGER + 1,
			Number.MAX_SAFE_INTEGER,
		])
			await expect(create({ now: nowValue })).rejects.toThrow();
	});
	it("retains ordinary constructor keys and rejects cycles without granting authority", async () => {
		const argumentsValue = JSON.parse(
			'{"execution_id":"exec_test","constructor":{"value":1}}',
		);
		const envelope = await create({ arguments: argumentsValue });
		expect((await verify(envelope, { arguments: argumentsValue })).ok).toBe(
			true,
		);
		expect((await verify(envelope)).ok).toBe(false);
		const cycle: { nested?: unknown } = {};
		cycle.nested = cycle;
		await expect(create({ arguments: cycle as never })).rejects.toThrow(
			"Cyclic",
		);
		expect((await verify(envelope, { arguments: cycle as never })).ok).toBe(
			false,
		);
	});
});

describe("machine durable-code provenance", () => {
	const machines: DurableCodeCaller[] = [
		{
			classification: "external-agent",
			principal: {
				...caller.principal,
				source: "service-binding",
				subject: "external-agent",
				clientId: "external-client",
			},
		},
		{
			classification: "tedi",
			principal: {
				...caller.principal,
				source: "tedi-jwt",
				subject: "worker",
				tediId: "worker",
			},
		},
		{
			classification: "tedi",
			principal: {
				...caller.principal,
				source: "service-binding",
				subject: "worker",
				tediId: "worker",
			},
		},
		{
			classification: "api-key",
			principal: { ...caller.principal, source: "api-key", subject: "key-id" },
		},
		{
			classification: "m2m",
			principal: {
				...caller.principal,
				source: "aih-m2m",
				subject: "machine",
				clientId: "machine-client",
			},
		},
		{
			classification: "service",
			principal: {
				...caller.principal,
				source: "service-binding",
				subject: "service",
				clientId: "service-client",
			},
		},
	];
	it.each(machines)(
		"preserves verified $classification read/write without operator authority",
		async (machine) => {
			for (const operation of [
				"get_code_execution",
				"run_durable_code",
			] as const) {
				const request = {
					...binding,
					operation,
					arguments:
						operation === "run_durable_code"
							? { code: "return 1" }
							: binding.arguments,
				};
				const envelope = await createMachineDurableCodeDelegation({
					...request,
					now,
					caller: {
						...machine,
						principal: {
							...machine.principal,
							scopes: [requiredDurableCodeCapability(operation)],
						},
					},
				});
				expect(envelope.operator).toEqual({
					classification: machine.classification,
					subject: machine.principal.subject,
				});
				expect(
					(
						await verifyDurableCodeDelegation({
							...request,
							envelope,
							now,
							transport: "trusted-service-binding",
						})
					).ok,
				).toBe(true);
				expect(
					(
						await verifyDurableCodeDelegation({
							...request,
							envelope,
							now,
							transport: "public",
						})
					).ok,
				).toBe(false);
			}
			await expect(
				createMachineDurableCodeDelegation({
					...binding,
					caller: machine,
					now,
				}),
			).rejects.toThrow();
			await expect(create({ caller: machine })).rejects.toThrow();
		},
	);
	it("fails closed on machine identity, capability, tenant and classification mismatches", async () => {
		const machine = machines[4]!;
		for (const changes of [
			{ verified: false },
			{ authenticated: false },
			{ subject: undefined },
			{ clientId: undefined },
			{ source: "user-jwt" as const },
			{ orgId: tediId },
			{ scopes: [] },
			{ tediId: "unexpected-tedi" },
		]) {
			await expect(
				createMachineDurableCodeDelegation({
					...binding,
					operation: "get_code_execution",
					now,
					caller: {
						...machine,
						principal: {
							...machine.principal,
							scopes: ["mcp:tedis.read"],
							...changes,
						},
					},
				}),
			).rejects.toThrow();
		}
		await expect(
			createMachineDurableCodeDelegation({
				...binding,
				operation: "get_code_execution",
				now,
				caller,
			}),
		).rejects.toThrow();
	});
	it("rejects forged machine operator resolutions at verification", async () => {
		const envelope = await create();
		for (const machine of machines) {
			expect(
				(
					await verify({
						...envelope,
						operator: {
							classification: machine.classification,
							subject: machine.principal.subject,
						},
					})
				).ok,
			).toBe(false);
		}
	});
});

it("binds human recovery to its exact operation and execution and denies machines", async () => {
	const recovery = { ...binding, operation: "recover_code_execution" as const };
	const envelope = await create({ operation: recovery.operation });
	expect((await verify(envelope, { operation: recovery.operation })).ok).toBe(
		true,
	);
	expect(
		(
			await verify(envelope, {
				operation: recovery.operation,
				arguments: { execution_id: "another" },
			})
		).ok,
	).toBe(false);
	expect((await verify(envelope)).ok).toBe(false);
	await expect(
		createMachineDurableCodeDelegation({
			...recovery,
			caller: {
				classification: "api-key",
				principal: { ...caller.principal, source: "api-key" },
			},
			now,
		}),
	).rejects.toThrow();
});
