import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { verifyChange } from "../examples/verify-change.mjs";
import { changeStatement, type ChangeContent } from "./record";
import { encodeBase64, signStatement } from "./seal";

const fixture = (name: string) =>
	readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8");
const valid = JSON.parse(fixture("valid.json"));
const spki = fixture("public-key.spki");
const record: ChangeContent = JSON.parse(fixture("statement.json")).predicate
	.record;

describe("single-change offline profile", () => {
	it("accepts the language-neutral fixture and rejects changed bytes and unsigned input", () => {
		expect(verifyChange(valid, spki).predicate.record.id).toBe(record.id);
		expect(() =>
			verifyChange(JSON.parse(fixture("invalid.json")), spki),
		).toThrow("Signature");
		expect(() => verifyChange({ ...valid, signatures: [] }, spki)).toThrow(
			"Signature",
		);
		expect(() =>
			verifyChange({ ...valid, payloadType: "application/json" }, spki),
		).toThrow("payload type");
	});

	it("keeps missing gateway facts open rather than inventing approval or policy", async () => {
		const {
			approval: _approval,
			environment: _env,
			parent: _parent,
			subject: _task,
			decision: _decision,
			...capture
		} = record;
		const statement = await changeStatement(capture);
		expect(statement.predicate.openFields.map(({ field }) => field)).toEqual([
			"onBehalfOf",
			"trustedTime",
			"task",
			"parent",
			"environment",
			"policyVersion",
			"approval",
			"decision",
		]);
		expect(statement.predicate.approval).toBeNull();
		expect(statement.predicate.time.trustedTime).toBeNull();
	});

	it("verifies UTF-8 payloads with an independent key and rejects a substituted trusted key", async () => {
		const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
			"sign",
			"verify",
		]);
		const key = encodeBase64(
			new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
		);
		const statement = await changeStatement({
			...record,
			operation: "noter café",
		});
		const signed = await signStatement(statement, pair.privateKey, "hint-only");
		expect(verifyChange(signed, key).predicate.cause.operation).toBe(
			"noter café",
		);
		expect(() => verifyChange(signed, spki)).toThrow("Signature");
		for (const corrupt of [
			{
				...statement,
				subject: [{ name: "wrong", digest: { sha256: "0".repeat(64) } }],
			},
			{
				...statement,
				predicate: {
					...statement.predicate,
					actor: { id: "other", kind: "agent" },
				},
			},
			{ ...statement, predicate: { ...statement.predicate, openFields: [] } },
		]) {
			const envelope = await signStatement(
				corrupt,
				pair.privateKey,
				"hint-only",
			);
			expect(() => verifyChange(envelope, key)).toThrow();
		}
	});
});
