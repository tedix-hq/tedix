import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	inspectQualificationReceipts,
	migrateQualificationReceipts,
	runLedgerQualification,
} from "../../../packages/context-core/scripts/qualify-ledger-models";
import {
	getLedgerEvaluationCase,
	hashLedgerEvaluationCase,
	listLedgerEvaluationCases,
} from "../../../packages/context-core/src/ledger-model-evaluation";

const root = await mkdtemp(join(tmpdir(), "qualification-receipt-migration-"));
try {
	const source = join(root, "original");
	const target = join(root, "migrated");
	await mkdir(source);
	const job = {
		...listLedgerEvaluationCases()[0]!,
		promptVariant: "production" as const,
		modelRef: "azure-openai/gpt-6-astra" as const,
		repetition: 0,
	};
	const hashes = await hashLedgerEvaluationCase(
		getLedgerEvaluationCase(job.surface, job.caseId, job.promptVariant)!,
	);
	const file = `${createHash("sha256")
		.update(JSON.stringify({ job, ...hashes }))
		.digest("hex")}.json`;
	const receipt = {
		job,
		evaluationId: "10000000-0000-4000-8000-000000000001",
		state: "completed",
		...hashes,
		grade: { passed: false, failures: ["transport interrupted"], parsed: null },
		denied: true,
		error:
			"Tedix CLI evaluation did not complete; inspect the normal authorization, approval or transport result before continuing",
	};
	const original = JSON.stringify(receipt);
	await writeFile(join(source, file), original);
	await writeFile(
		join(source, "native-preflight.json"),
		"retained original evidence",
	);
	const before = await inspectQualificationReceipts(source);
	assert.equal(before.legacy, 1);
	const migrated = await migrateQualificationReceipts(source, target);
	assert.equal(migrated.after.total, 1);
	assert.equal(migrated.after.legacy, 0);
	assert.notEqual(
		migrated.after.receipts[0]!.sha256,
		before.receipts[0]!.sha256,
	);
	assert.equal(await readFile(join(source, file), "utf8"), original);
	assert.equal(
		await readFile(join(target, "native-preflight.json"), "utf8"),
		"retained original evidence",
	);
	const inspection = JSON.parse(
		execFileSync(
			process.execPath,
			[
				fileURLToPath(
					new URL(
						"../../../packages/context-core/scripts/qualify-ledger-models.ts",
						import.meta.url,
					).href,
				),
				"-w",
				"connect",
				"--organization",
				"org_example",
				"--out",
				target,
				"--inspect-receipts",
			],
			{ encoding: "utf8" },
		),
	);
	assert.equal(inspection.total, 1);
	assert.equal(inspection.legacy, 0);
	const current = JSON.parse(await readFile(join(target, file), "utf8"));
	assert.equal(current.denied, undefined);
	assert.equal(current.interrupted, true);
	assert.equal(current.cliFailure.kind, "indeterminate");
	assert.equal(current.cliFailure.approvalId, null);
	assert.equal(current.evaluationId, receipt.evaluationId);
	assert.deepEqual(current.grade, receipt.grade);
	let calls = 0;
	await assert.rejects(
		runLedgerQualification(target, async () => {
			calls++;
			throw new Error("must not dispatch");
		}),
		/indeterminate CLI failure/,
	);
	assert.equal(calls, 0, "migration never authorizes replay or continuation");
	await assert.rejects(migrateQualificationReceipts(source, target), /EEXIST/);
	await assert.rejects(migrateQualificationReceipts(source, source), /outside/);
	await assert.rejects(
		migrateQualificationReceipts(source, join(source, "..nested")),
		/outside/,
	);

	const deniedSource = join(root, "denied");
	await mkdir(deniedSource);
	const denied = JSON.stringify({
		...receipt,
		cliFailure: { kind: "authorization", errorCode: "FORBIDDEN" },
	});
	await writeFile(join(deniedSource, file), denied);
	await migrateQualificationReceipts(deniedSource, join(root, "denied-copy"));
	assert.equal(await readFile(join(root, "denied-copy", file), "utf8"), denied);
	await assert.rejects(
		runLedgerQualification(join(root, "denied-copy"), async () => {
			calls++;
			throw new Error("must not dispatch");
		}),
		/was denied/,
	);
	assert.equal(calls, 0);

	const unsettled = join(root, "unsettled");
	await mkdir(unsettled);
	await writeFile(
		join(unsettled, file),
		JSON.stringify({ ...receipt, state: "started" }),
	);
	assert.equal((await inspectQualificationReceipts(unsettled)).legacy, 1);
	await assert.rejects(
		migrateQualificationReceipts(unsettled, join(root, "unsettled-copy")),
		/completed indeterminate failure/,
	);
	assert.equal((await readdir(root)).includes("unsettled-copy"), false);

	await symlink(join(source, file), join(source, "linked-evidence"));
	await assert.rejects(
		migrateQualificationReceipts(source, join(root, "unsafe")),
		/without symlinks/,
	);
	assert.equal((await readdir(root)).includes("unsafe"), false);
} finally {
	await rm(root, { recursive: true, force: true });
}
console.log("qualification-receipt-migration.test.ts OK");
