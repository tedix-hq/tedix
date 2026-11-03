import assert from "node:assert/strict";
import {
	commitRepoChanges,
	readRepoRevisionExpectation,
	RepoStaleRevisionError,
} from "./repo-api";
import {
	readReviewedRepoBase,
	executeRepoCommitFromLedger,
} from "./repo-commit";

const A = "a".repeat(40),
	B = "b".repeat(40),
	C = "c".repeat(40);
const input = {
	owner: "fictional",
	repo: "demo",
	baseRef: "main",
	branch: "feat/change",
	token: "fictional-test-token",
};
const publish = {
	...input,
	message: "Reviewed change",
	changes: [{ path: "demo.txt", content: "hello" }],
};
const originalFetch = globalThis.fetch;
function provider(
	options: {
		base?: string;
		target?: string | null;
		afterCommit?: () => void;
		race?: boolean;
	} = {},
) {
	const state = {
		base: options.base ?? A,
		target: options.target === undefined ? A : options.target,
		writes: [] as {
			method: string;
			path: string;
			body: Record<string, unknown>;
		}[],
	};
	globalThis.fetch = async (request, init) => {
		const path = new URL(String(request)).pathname;
		const method = init?.method ?? "GET";
		const reply = (data: unknown, status = 200) =>
			new Response(JSON.stringify(data), { status });
		if (method === "GET") {
			if (path.endsWith("/git/ref/heads/main"))
				return reply({ object: { sha: state.base } });
			if (path.endsWith("/git/ref/heads/feat/change"))
				return state.target === null
					? reply({}, 404)
					: reply({ object: { sha: state.target } });
			if (path.endsWith(`/git/commits/${A}`))
				return reply({ sha: A, tree: { sha: "tree-old" } });
			throw new Error(`Unexpected GET ${path}`);
		}
		const body = JSON.parse(String(init?.body));
		state.writes.push({ method, path, body });
		if (path.endsWith("/git/blobs")) return reply({ sha: "blob-new" });
		if (path.endsWith("/git/trees")) return reply({ sha: "tree-new" });
		if (path.endsWith("/git/commits")) {
			options.afterCommit?.();
			return reply({ sha: C });
		}
		if (options.race) {
			state.target = B;
			return reply({ message: "Reference changed" }, 422);
		}
		if (path.includes("/git/refs")) {
			state.target = C;
			return reply({ sha: C });
		}
		throw new Error(`Unexpected write ${path}`);
	};
	return state;
}
try {
	let state = provider({ base: B });
	await assert.rejects(
		readRepoRevisionExpectation(input, A),
		RepoStaleRevisionError,
	);
	assert.equal(
		state.writes.length,
		0,
		"stale checkout cannot propose against newer remote",
	);

	state = provider({ base: B });
	await assert.rejects(
		commitRepoChanges({
			...publish,
			revisionExpectation: { baseSha: A, targetSha: A },
		}),
		RepoStaleRevisionError,
	);
	assert.equal(
		state.writes.length,
		0,
		"remote advance after approval creates no objects",
	);

	state = provider({
		afterCommit: () => {
			state.target = B;
		},
	});
	await assert.rejects(
		commitRepoChanges({
			...publish,
			revisionExpectation: { baseSha: A, targetSha: A },
		}),
		RepoStaleRevisionError,
	);
	assert.equal(
		state.writes.some((w) => w.path.includes("/git/refs")),
		false,
		"changed head before final check never publishes",
	);

	state = provider({ race: true });
	await assert.rejects(
		commitRepoChanges({
			...publish,
			revisionExpectation: { baseSha: A, targetSha: A },
		}),
		RepoStaleRevisionError,
	);
	assert.deepEqual(
		state.writes.at(-1)?.body,
		{ sha: C, force: false },
		"non-fast-forward provider race cannot force publish",
	);

	state = provider({ target: null, race: true });
	await assert.rejects(
		commitRepoChanges({
			...publish,
			revisionExpectation: { baseSha: A, targetSha: null },
		}),
		RepoStaleRevisionError,
	);
	assert.equal(state.writes.at(-1)?.method, "POST");
	assert.equal(
		state.writes.some((w) => w.method === "PATCH"),
		false,
		"concurrent branch creation never falls back to updating it",
	);

	state = provider();
	assert.deepEqual(
		await commitRepoChanges({
			...publish,
			revisionExpectation: { baseSha: A, targetSha: A },
		}),
		{ commitSha: C, branchRef: "refs/heads/feat/change" },
	);
	assert.deepEqual(
		state.writes.find((w) => w.path.endsWith("/git/commits"))?.body.parents,
		[A],
		"published parent is the approved source",
	);
	assert.deepEqual(state.writes.at(-1)?.body, { sha: C, force: false });

	state = provider({ target: null });
	await commitRepoChanges({
		...publish,
		revisionExpectation: { baseSha: A, targetSha: null },
	});
	assert.deepEqual(state.writes.at(-1)?.body, {
		ref: "refs/heads/feat/change",
		sha: C,
	});
	console.log(
		"PASS pinned source/target checks, concurrent movement, new branch and non-force publication",
	);
} finally {
	globalThis.fetch = originalFetch;
}

for (const origin of [
	"https://github.com/fictional/demo.git",
	"https://github.com/fictional/demo",
]) {
	const calls: string[][] = [];
	assert.equal(
		await readReviewedRepoBase({
			...input,
			git: async (argv) => {
				calls.push(argv);
				return { stdout: argv[0] === "config" ? origin : A, exitCode: 0 };
			},
		}),
		A,
	);
	assert.deepEqual(calls, [
		["config", "--get", "remote.origin.url"],
		["rev-parse", "HEAD"],
	]);
}
for (const origin of [
	"https://github.com/other/demo.git",
	"https://user:secret@github.com/fictional/demo.git",
	"https://github.com:443/fictional/demo.git?x=1",
	"https://gitlab.com/fictional/demo.git",
]) {
	assert.equal(
		await readReviewedRepoBase({
			...input,
			git: async () => ({ stdout: origin, exitCode: 0 }),
		}),
		null,
	);
}
assert.equal(
	await readReviewedRepoBase({
		...input,
		git: async () => ({ stdout: "", exitCode: 128 }),
	}),
	null,
);
assert.equal(
	await readReviewedRepoBase({
		...input,
		baseRef: "../main",
		git: async () => ({
			stdout: "https://github.com/fictional/demo.git",
			exitCode: 0,
		}),
	}),
	null,
);
assert.equal(
	await readReviewedRepoBase({
		...input,
		git: async (argv) => ({
			stdout:
				argv[0] === "config" ? "https://github.com/fictional/demo.git" : "HEAD",
			exitCode: 0,
		}),
	}),
	null,
);
let decrypted = false;
const missing = await executeRepoCommitFromLedger({
	row: {
		id: "fictional-ledger",
		...input,
		message: "demo",
		changesJson: JSON.stringify({ changes: publish.changes }),
		openPr: false,
		prBase: null,
	},
	deps: {
		decryptPat: async () => {
			decrypted = true;
			return "unused";
		},
		commitRepoChanges: async () => {
			throw new Error("must not publish");
		},
		openPullRequest: async () => {
			throw new Error("must not create PR");
		},
	},
});
assert.equal(missing.ok, false);
assert.equal(!missing.ok && missing.code, "repo_revision_missing");
assert.equal(
	decrypted,
	false,
	"legacy ledger is rejected before credentials are read",
);
console.log(
	"PASS checkout provenance, safe SDK argv and legacy ledger refusal",
);
