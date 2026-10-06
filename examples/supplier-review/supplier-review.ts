#!/usr/bin/env bun
/**
 * Supplier review: give Tedix one supplier folder and get a decision note.
 *
 * Offline: creates a "Supplier review" workspace in your local Tedix OS and
 * saves the folder as a document you can open there.
 * With --ask (needs `bun run-local --inference ...`): asks Home to write a
 * decision note that cites the folder files and to draft a follow-up email
 * without sending it, then saves the reply next to the folder.
 *
 * Usage: bun examples/supplier-review/supplier-review.ts [--ask] [--refresh-import]
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getApiClient } from "@tedix/api-client/client";
import type { ApiContract } from "@tedix/api-contract/contracts/api";
import {
	refreshSupplierImport,
	supplierDocument,
} from "./supplier-review-document";
import {
	checkedSupplierReply,
	checkSupplierReply,
	supplierCalculationGrounding,
	supplierFacts,
} from "./supplier-review-quality";

const OS_URL = process.env.TEDIX_OS_URL ?? "http://localhost:3030";
const WORKSPACE_NAME = "Supplier review";
const ask = process.argv.includes("--ask");
const refreshImport = process.argv.includes("--refresh-import");

// The local OS signs requests in as the local owner, so no token is needed.
const tedix = getApiClient<ApiContract>(`${OS_URL}/api`);

const folder = join(import.meta.dir, "supplier-folder");
const files = (await readdir(folder)).filter((name) => name.endsWith(".md"));
files.sort();
const sources = await Promise.all(
	files.map(async (name) => ({
		name,
		text: (await readFile(join(folder, name), "utf8")).trim(),
	})),
);

const { items } = await tedix.osWorkspaces.workspaces.list({
	status: "active",
	limit: 200,
});
const workspace =
	items.find((item) => item.name === WORKSPACE_NAME) ??
	(
		await tedix.osWorkspaces.workspaces.create({
			name: WORKSPACE_NAME,
			description:
				"Decide whether to reorder from Globex Components before the Q3 quote expires.",
		})
	).workspace;

const FOLDER_TITLE = "Supplier folder: Globex Components";
const existing = await tedix.osWorkspaces.outputs.list({
	workspaceId: workspace.id,
	limit: 200,
});
const existingFolder = existing.items.find(
	(output) => output.title === FOLDER_TITLE,
);
const folderContent = supplierDocument(
	sources
		.map((source) => `Source: ${source.name}\n\n${source.text}`)
		.join("\n\n"),
);
const folderDocument =
	existingFolder ??
	(
		await tedix.osWorkspaces.outputs.create({
			kind: "document",
			title: FOLDER_TITLE,
			workspaceId: workspace.id,
			note: "Imported from examples/supplier-review/supplier-folder",
			content: folderContent,
		})
	).output;
if (existingFolder) {
	const { currentRevision } = await tedix.osWorkspaces.outputs.get({
		outputId: folderDocument.id,
	});
	await refreshSupplierImport(
		currentRevision,
		folderContent,
		refreshImport,
		(update) =>
			tedix.osWorkspaces.outputs.revise({
				outputId: folderDocument.id,
				...update,
				note: "Refreshed supplier fixtures with --refresh-import",
			}),
	);
}
console.log(
	`"${WORKSPACE_NAME}" holds ${sources.length} supplier files as "${FOLDER_TITLE}".`,
);

if (!ask) {
	console.log(`Open ${OS_URL} and choose Workspaces > ${WORKSPACE_NAME}.`);
	console.log("With inference on, run again with --ask for a decision note.");
	process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
const facts = supplierFacts(sources, today);
const prompt = [
	`Today is ${today} (UTC). Check whether the dated quote is still valid.`,
	"Using only the supplier files below, write a short decision note: should we",
	"accept the Globex Q3 quote for 5,000 GX-200 motors? Cite the file name for",
	"every fact you use and list open questions. Then draft a follow-up email to",
	"Globex asking those questions. Do not send the email or call any tools;",
	"I will review it first.",
	"Include a calculation summary with these exact labels: Price increase: <number>%; Additional cost: <number> EUR; On-time deliveries: <count>/<total>; Quote expired: yes or no. Put each label on its own line. Calculate from the files; do not guess. Outside that summary, cite each claim as usual.",
	...sources.map((source) => `\n--- ${source.name} ---\n${source.text}`),
	`\n${supplierCalculationGrounding(facts, today)}`,
].join(" ");

const turn = await tedix.kernelRuntime.enqueueMessage({
	conversationId: "home:main",
	content: prompt,
	idempotencyKey: crypto.randomUUID(),
	workspaceContext: {
		workspaceId: workspace.id,
		workpiece: { kind: "output", id: folderDocument.id },
	},
});
if (turn.status !== "queued" && turn.status !== "needs_delegation") {
	throw new Error(
		`Home could not take the request (${turn.status}${turn.error ? `: ${turn.error}` : ""}). --ask needs model calls: restart with bun run-local --inference --workers-ai-account=<account-id>.`,
	);
}
console.log(`Home run ${turn.run.id} started; waiting for the reply...`);

let offset = 0;
let closed = false;
const deadline = Date.now() + 180_000;
while (!closed && Date.now() < deadline) {
	const events = await tedix.kernelRuntime.readRunEvents({
		runId: turn.run.id,
		offset,
		waitMs: 10_000,
	});
	offset = events.stream.nextOffset;
	closed = events.stream.closed;
}
if (!closed) throw new Error(`Run ${turn.run.id} did not finish in 3 minutes`);

const { messages } = await tedix.kernelRuntime.readMessages({
	conversationId: turn.conversationId,
	limit: 100,
});
const reply = messages
	.filter(
		(message) =>
			message.role === "assistant" &&
			message.runId === turn.run.id &&
			message.content.trim() !== "",
	)
	.at(-1)?.content;
if (!reply) throw new Error(`Run ${turn.run.id} finished without a reply`);

const issues = checkSupplierReply(reply, facts);
const checkedReply = checkedSupplierReply(reply, issues, today);
await tedix.osWorkspaces.outputs.create({
	kind: "document",
	title: "Decision note: Globex Q3 quote",
	workspaceId: workspace.id,
	note: `Home run ${turn.run.id}`,
	content: supplierDocument(checkedReply),
});
console.log(`\n${checkedReply}\n`);
console.log(`Saved "Decision note: Globex Q3 quote" in ${WORKSPACE_NAME}.`);
console.log(`Open Chat in ${OS_URL} to see run ${turn.run.id}.`);
if (issues.length) process.exitCode = 1;
