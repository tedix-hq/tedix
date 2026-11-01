import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	evidenceDirVariable,
	specEvidenceName,
} from "../../apps/os/browser-tests/failure-evidence";
import { withInteractionProfile } from "../../apps/os/browser-tests/interaction-profile";

const originalDir = process.env[evidenceDirVariable];
const root = mkdtempSync(join(tmpdir(), "interaction-profile-"));
afterEach(() => {
	if (originalDir === undefined) delete process.env[evidenceDirVariable];
	else process.env[evidenceDirVariable] = originalDir;
	rmSync(root, { recursive: true, force: true });
});

test("without evidence enabled, the interaction runs without tracing", async () => {
	delete process.env[evidenceDirVariable];
	let ran = false;
	let traced = false;
	await withInteractionProfile(
		{
			startTracing: async () => {
				traced = true;
				throw new Error("unexpected trace");
			},
			stopTracing: async () => {
				throw new Error("unexpected stop");
			},
		},
		"remove",
		async () => {
			ran = true;
		},
	);
	expect(ran).toBe(true);
	expect(traced).toBe(false);
});

test("a failed interaction flushes its profile and preserves the original failure", async () => {
	process.env[evidenceDirVariable] = root;
	const failure = new Error("Remove timed out");
	let stopped = false;
	await expect(
		withInteractionProfile(
			{
				startTracing: async () => {},
				stopTracing: async () => {
					stopped = true;
					return Buffer.alloc(0);
				},
			},
			"remove",
			async () => {
				throw failure;
			},
		),
	).rejects.toBe(failure);
	expect(stopped).toBe(true);
});

test("unavailable profiling does not hide an interaction failure", async () => {
	process.env[evidenceDirVariable] = root;
	const failure = new Error("Remove timed out");
	await expect(
		withInteractionProfile(
			{
				startTracing: async () => {},
				stopTracing: async () => {
					throw new Error("renderer disconnected");
				},
			},
			"remove",
			async () => {
				throw failure;
			},
		),
	).rejects.toBe(failure);
	expect(
		readFileSync(
			join(
				root,
				specEvidenceName(process.argv[1]),
				"remove.json.unavailable.txt",
			),
			"utf8",
		),
	).toContain("renderer disconnected");
});

test("a stuck profile flush is bounded and records the missing evidence", async () => {
	process.env[evidenceDirVariable] = root;
	const failure = new Error("Remove timed out");
	await expect(
		withInteractionProfile(
			{
				startTracing: async () => {},
				stopTracing: () => new Promise(() => {}),
			},
			"remove",
			async () => {
				throw failure;
			},
		),
	).rejects.toBe(failure);
	expect(
		readFileSync(
			join(
				root,
				specEvidenceName(process.argv[1]),
				"remove.json.unavailable.txt",
			),
			"utf8",
		),
	).toContain("exceeded 2000ms");
});
