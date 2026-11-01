import { describe, expect, it, vi } from "vite-plus/test";
import type { ArtifactsBinding } from "../types";
import { readThemeArtifactHead } from "./artifact-source-read";

const COMMIT = "a".repeat(40);

function fixture(
	options: {
		hashes?: readonly string[];
		missing?: boolean;
		fail?: boolean;
		code?: string;
	} = {},
) {
	const dispose = vi.fn();
	const repo = {
		[Symbol.dispose]: dispose,
		log: vi.fn(async () => {
			if (options.fail)
				throw Object.assign(new Error("private provider detail"), {
					code: options.code,
				});
			return (options.hashes ?? [COMMIT]).map((hash) => ({
				hash,
				message: "private draft message",
				author: { name: "Private author", email: "private@example.test" },
			}));
		}),
		readCommit: vi.fn(async (hash: string) =>
			options.missing ? null : { hash, treeHash: "b".repeat(40) },
		),
		createToken: vi.fn(() => {
			throw new Error("must not create credentials");
		}),
	};
	const get = vi.fn(async () => repo);
	const read = () =>
		readThemeArtifactHead({
			orgSlug: "acme",
			artifacts: { get } as unknown as ArtifactsBinding,
		});
	return { read, repo, get, dispose };
}

describe("native theme main-branch read", () => {
	it("reads a fresh tenant-bound main ref and returns only the verified commit", async () => {
		const f = fixture();
		expect(await f.read()).toEqual({ branch: "main", sourceCommit: COMMIT });
		expect(f.get).toHaveBeenCalledWith("cms-theme-acme");
		expect(f.repo.log).toHaveBeenCalledWith({
			ref: "main",
			limit: 1,
			offset: 0,
		});
		expect(f.repo.readCommit).toHaveBeenCalledWith(COMMIT);
		expect(f.repo.createToken).not.toHaveBeenCalled();
		expect(f.dispose).toHaveBeenCalledOnce();
	});

	it.each([
		{ hashes: [] },
		{ hashes: ["main"] },
		{ hashes: [COMMIT, "c".repeat(40)] },
		{ missing: true },
		{ fail: true },
	])("fails closed without leaking provider errors for %j", async (options) => {
		const f = fixture(options);
		await expect(f.read()).rejects.toThrow(
			"Unable to read the current Artifacts theme branch",
		);
		expect(f.repo.createToken).not.toHaveBeenCalled();
		expect(f.dispose).toHaveBeenCalledOnce();
	});

	it.each([
		[{ hashes: [] }, "main_validation: main_not_found"],
		[{ hashes: ["invalid"] }, "main_validation: invalid_main_history"],
		[{ missing: true }, "commit_verification: provider_failure"],
		[{ fail: true, code: "INVALID_INPUT" }, "main_history: INVALID_INPUT"],
		[
			{ fail: true, code: "private secret code" },
			"main_history: provider_failure",
		],
	] as const)(
		"reports only a safe stage and known code for %j",
		async (options, diagnostic) => {
			const f = fixture(options);
			let message = "";
			try {
				await f.read();
			} catch (error) {
				message = (error as Error).message;
			}
			expect(message).toContain(diagnostic);
			expect(message).not.toContain("private");
			expect(f.repo.createToken).not.toHaveBeenCalled();
		},
	);
});
