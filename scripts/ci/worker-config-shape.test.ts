import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detachedGitEnv } from "../oss/git-env.ts";
import {
	diffShapes,
	isWorkerConfigPath,
	shapeOfSource,
	shapeWarning,
	workerConfigShapeWarning,
} from "./worker-config-shape.mjs";

const BASE = `{
	// comment
	"name": "example-api",
	"vars": { "LOG_LEVEL": "info" },
	"d1_databases": [{ "binding": "DB", "database_id": "placeholder" }],
	"ai": { "binding": "AI" },
	"durable_objects": { "bindings": [{ "name": "KERNEL", "class_name": "Kernel" }] },
	"queues": { "producers": [{ "binding": "EVENTS", "queue": "q" }] },
	"ratelimits": [{ "name": "LIMITER", "namespace_id": "1" }],
	"migrations": [{ "tag": "v1", "new_classes": ["Kernel"] }],
	"secrets": { "required": ["MASTER_KEY"] },
	"env": {
		"production": {
			"vars": { "LOG_LEVEL": "warn" },
			"d1_databases": [{ "binding": "DB", "database_id": "placeholder" }],
		},
	},
}`;

describe("shapeOfSource", () => {
	test("names every binding with its kind, every var key and secret, per env", () => {
		expect([...shapeOfSource(BASE)].sort()).toEqual([
			"binding AI (ai)",
			"binding DB (d1_databases)",
			"binding EVENTS (queues)",
			"binding KERNEL (durable_objects)",
			"binding LIMITER (ratelimits)",
			"env.production binding DB (d1_databases)",
			"env.production var LOG_LEVEL",
			"secret MASTER_KEY",
			"var LOG_LEVEL",
		]);
	});

	test("a missing file has an empty shape", () => {
		expect(shapeOfSource(null).size).toBe(0);
	});
});

describe("diffShapes", () => {
	test("a changed var VALUE or resource id keeps the shape", () => {
		const after = BASE.replace('"warn"', '"debug"').replace(
			'"database_id": "placeholder" }],\n\t"ai"',
			'"database_id": "other" }],\n\t"ai"',
		);
		expect(diffShapes(shapeOfSource(BASE), shapeOfSource(after))).toEqual([]);
	});

	test("reports added, removed and retyped names", () => {
		const after = BASE.replace(
			'"secrets": { "required": ["MASTER_KEY"] }',
			'"secrets": { "required": ["MASTER_KEY", "NEW_TOKEN"] }',
		)
			.replace('"ai": { "binding": "AI" },', '"browser": { "binding": "AI" },')
			.replace('"vars": { "LOG_LEVEL": "info" }', '"vars": {}');
		expect(diffShapes(shapeOfSource(BASE), shapeOfSource(after))).toEqual([
			"+ binding AI (browser)",
			"+ secret NEW_TOKEN",
			"- binding AI (ai)",
			"- var LOG_LEVEL",
		]);
	});
});

describe("shapeWarning", () => {
	test("is null when nothing changed shape", () => {
		expect(shapeWarning({ "apps/api/wrangler.jsonc": [] })).toBeNull();
	});

	test("names each config and points at the ops overlay", () => {
		expect(
			shapeWarning({ "apps/api/wrangler.jsonc": ["+ secret NEW_TOKEN"] }),
		).toBe(
			"This changes Worker configuration shape (apps/api/wrangler.jsonc: + secret NEW_TOKEN). " +
				"Land the matching tedix-cloud-ops production overlay edit in the same change, " +
				"or Ship will fail at plan for every surface.",
		);
	});
});

test("only product Worker configs are watched, not CMS templates", () => {
	expect(isWorkerConfigPath("apps/api/wrangler.jsonc")).toBe(true);
	expect(isWorkerConfigPath("apps/cms/templates/blog/wrangler.jsonc")).toBe(
		false,
	);
	expect(isWorkerConfigPath("apps/api/src/index.ts")).toBe(false);
});

describe("workerConfigShapeWarning against git history", () => {
	function git(cwd: string, ...args: string[]) {
		const result = spawnSync("git", args, {
			cwd,
			encoding: "utf8",
			env: {
				...detachedGitEnv(),
				GIT_AUTHOR_NAME: "Fixture",
				GIT_AUTHOR_EMAIL: "fixture@example.com",
				GIT_COMMITTER_NAME: "Fixture",
				GIT_COMMITTER_EMAIL: "fixture@example.com",
			},
		});
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	}

	function fixture(after: string) {
		const repo = mkdtempSync(join(tmpdir(), "worker-shape-"));
		git(repo, "init", "-q");
		mkdirSync(join(repo, "apps/api"), { recursive: true });
		writeFileSync(join(repo, "apps/api/wrangler.jsonc"), BASE);
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "base");
		const base = git(repo, "rev-parse", "HEAD");
		writeFileSync(join(repo, "apps/api/wrangler.jsonc"), after);
		git(repo, "commit", "-q", "-am", "change");
		return { repo, base, head: git(repo, "rev-parse", "HEAD") };
	}

	test("warns when a pushed commit adds a binding", () => {
		const { repo, base, head } = fixture(
			BASE.replace(
				'"ai": { "binding": "AI" },',
				'"ai": { "binding": "AI" },\n\t"kv_namespaces": [{ "binding": "CACHE", "id": "x" }],',
			),
		);
		try {
			expect(
				workerConfigShapeWarning(
					repo,
					["apps/api/wrangler.jsonc"],
					[{ base, head }],
				),
			).toContain("apps/api/wrangler.jsonc: + binding CACHE (kv_namespaces)");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test("stays silent when only a value changed", () => {
		const { repo, base, head } = fixture(BASE.replace('"info"', '"debug"'));
		try {
			expect(
				workerConfigShapeWarning(
					repo,
					["apps/api/wrangler.jsonc"],
					[{ base, head }],
				),
			).toBeNull();
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
