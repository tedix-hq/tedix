import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vite-plus/test";
import {
	RuntimeAdmission,
	type AdmissionEvidence,
} from "../../src/runtime-admission";
import type { PiRuntimeFixture } from "./worker";
const owner = { tediId: "tedi", orgId: "org", objectId: "object" },
	digest = "a".repeat(64),
	requestHash = "b".repeat(64);
function fixture() {
	const ns = (
		env as unknown as { PI_TEST: DurableObjectNamespace<PiRuntimeFixture> }
	).PI_TEST;
	return ns.get(ns.idFromName(crypto.randomUUID()));
}
describe("runtime-neutral durable admission", () => {
	it("persists holds and exact claims across reconstruction, excludes dispatch but retains actual late receipts", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			// Existing fixture constructor is outside this core's lifecycle claim.
			const alarm = await state.storage.getAlarm();
			let unknown = 0;
			const verify = (
				action: string,
				input: Readonly<Record<string, unknown>>,
			): AdmissionEvidence => ({
				owner,
				digest,
				complete: true,
				unknown,
				nonterminal: 0,
				...(action === "complete"
					? {
							terminal: true,
							claim: {
								turnId: input.turnId as string,
								requestHash: input.requestHash as string,
								generation: input.generation as number,
							},
						}
					: {}),
			});
			let gate = new RuntimeAdmission(state.storage, owner, verify);
			expect(gate.read()).toBeNull();
			unknown = 1;
			expect(() =>
				gate.initialize({
					operationId: "bad",
					state: "active",
					evidence: digest,
				}),
			).toThrow(/unverified/);
			expect(
				state.storage.sql
					.exec("SELECT name FROM sqlite_master WHERE name='runtime_admission'")
					.toArray(),
			).toEqual([]);
			unknown = 0;
			gate.initialize({
				operationId: "init",
				state: "active",
				evidence: digest,
			});
			const outcomes = await Promise.all([
				Promise.resolve().then(() =>
					gate.beginTurn({
						turnId: "accepted",
						requestHash,
						expectedGeneration: 1,
					}),
				),
				Promise.resolve()
					.then(() =>
						gate.hold({
							operationId: "hold",
							expectedGeneration: 1,
							evidence: digest,
						}),
					)
					.catch(() => null),
			]);
			expect(outcomes[1]).toBeNull();
			gate.quarantine({
				operationId: "quarantine",
				expectedGeneration: 1,
				reason: "receipt pending",
			});
			gate = new RuntimeAdmission(state.storage, owner, verify);
			expect(gate.claim("accepted")?.status).toBe("running");
			expect(() =>
				gate.assertTurn({ turnId: "accepted", requestHash, generation: 1 }),
			).toThrow(/denied/);
			expect(() =>
				gate.release({
					operationId: "release",
					expectedGeneration: 2,
					evidence: digest,
				}),
			).toThrow(/unresolved/);
			gate.completeTurn({
				turnId: "accepted",
				requestHash,
				generation: 1,
				evidence: digest,
			});
			unknown = 1;
			expect(() =>
				gate.release({
					operationId: "release",
					expectedGeneration: 2,
					evidence: digest,
				}),
			).toThrow(/unverified/);
			unknown = 0;
			gate.release({
				operationId: "release",
				expectedGeneration: 2,
				evidence: digest,
			});
			expect(
				gate.beginTurn({
					turnId: "accepted",
					requestHash,
					expectedGeneration: 1,
				}).newlyAccepted,
			).toBe(false);
			gate.hold({
				operationId: "hold",
				expectedGeneration: 3,
				evidence: digest,
			});
			expect(
				new RuntimeAdmission(state.storage, owner, verify).read()?.state,
			).toBe("held");
			expect(() =>
				gate.beginTurn({ turnId: "new", requestHash, expectedGeneration: 4 }),
			).toThrow(/denied/);
			expect(await state.storage.getAlarm()).toEqual(alarm);
		});
	});
	it("permits unverified quarantine and rejects stale generations, malformed evidence, unknown claims and owner substitution", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			const gate = new RuntimeAdmission(state.storage, owner, () => ({
				owner,
				digest,
				complete: false,
				unknown: 0,
				nonterminal: 0,
			}));
			gate.initialize({
				operationId: "quarantine",
				state: "quarantined",
				reason: "unverified baseline",
			});
			expect(() =>
				gate.release({
					operationId: "release",
					expectedGeneration: 1,
					evidence: digest,
				}),
			).toThrow(/unverified/);
			expect(() =>
				gate.completeTurn({
					turnId: "unknown",
					requestHash,
					generation: 1,
					evidence: digest,
				}),
			).toThrow(/unknown/);
			expect(() =>
				gate.release({
					operationId: "stale",
					expectedGeneration: 2,
					evidence: digest,
				}),
			).toThrow(/stale/);
			expect(() =>
				new RuntimeAdmission(
					state.storage,
					{ ...owner, orgId: "other" },
					() => {
						throw Error("unused");
					},
				).read(),
			).toThrow(/owner/);
			expect(gate.read()?.generation).toBe(1);
		});
	});
	it("keeps anonymous physical custody quarantined without fabricating tenant identity", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			const anonymous = {
				tediId: null,
				orgId: null,
				objectId: "orphan-object",
			};
			const gate = new RuntimeAdmission(state.storage, anonymous, () => ({
				owner: anonymous,
				digest,
				complete: true,
				unknown: 0,
				nonterminal: 0,
			}));
			expect(() =>
				gate.initialize({
					operationId: "active",
					state: "active",
					evidence: digest,
				}),
			).toThrow(/anonymous/);
			expect(gate.read()).toBeNull();
			gate.initialize({
				operationId: "custody",
				state: "quarantined",
				reason: "unknown stored tenant identity",
			});
			expect(() =>
				gate.release({
					operationId: "release",
					expectedGeneration: 1,
					evidence: digest,
				}),
			).toThrow(/anonymous/);
			expect(() =>
				new RuntimeAdmission(
					state.storage,
					{ ...owner, objectId: "orphan-object" },
					() => {
						throw Error("unused");
					},
				).read(),
			).toThrow(/owner/);
			expect(gate.read()?.owner).toEqual(anonymous);
		});
	});
});
