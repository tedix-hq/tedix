/**
 * Regression coverage for Miniflare remote Artifacts errors. In local dev,
 * remote binding errors can lose the structured `code` field and surface only
 * as Error.message, but the isolate daily-log writer still needs to lazy-create
 * missing repos.
 * Run: `bun run src/artifacts-git.test.ts`.
 */
import assert from "node:assert/strict";
import { isArtifactsErrorCode } from "./artifacts-contract";

assert.equal(
	isArtifactsErrorCode({ code: "NOT_FOUND" }, "NOT_FOUND"),
	true,
	"structured NOT_FOUND code is recognized",
);

assert.equal(
	isArtifactsErrorCode(
		new Error(
			"ArtifactsError: Repository not found: 5eed0035-0000-4000-8000-000000000035.",
		),
		"NOT_FOUND",
	),
	true,
	"Miniflare remote-proxy repository-not-found message is recognized",
);

assert.equal(
	isArtifactsErrorCode(
		new Error("ArtifactsError: Repository already exists: repo-1."),
		"ALREADY_EXISTS",
	),
	true,
	"remote-proxy already-exists message is recognized",
);

assert.equal(
	isArtifactsErrorCode(new Error("ArtifactsError: Unauthorized"), "NOT_FOUND"),
	false,
	"unrelated Artifacts errors are not misclassified as not found",
);

// ── planPrefixRemovals (workspace_snapshot prefix-replacing semantics) ─────
{
	const { planPrefixRemovals } = await import("./artifacts-git");

	assert.deepEqual(
		planPrefixRemovals(
			["workspace/a.md", "workspace/gone.md", "logs/2026-07-16.md"],
			["workspace/a.md"],
			"workspace/",
		),
		["workspace/gone.md"],
		"removes stale prefix paths only",
	);

	assert.deepEqual(
		planPrefixRemovals(
			["logs/2026-07-16.md", "MEMORY.md"],
			["workspace/new.md"],
			"workspace/",
		),
		[],
		"paths outside the prefix are never removed",
	);

	assert.deepEqual(
		planPrefixRemovals([], ["workspace/a.md"], "workspace/"),
		[],
		"empty repo plans no removals",
	);

	assert.deepEqual(
		planPrefixRemovals(["workspace/b.md", "workspace/a.md"], [], "workspace/"),
		["workspace/a.md", "workspace/b.md"],
		"emptied subtree removes all prior snapshot paths, sorted",
	);
}

console.log("artifacts-git OK");

// Exercise the real isomorphic-git protocol and HTTP adapter; only the
// Artifacts RPC and external Git server are test boundaries.
{
	const {
		commitDailyLogs,
		createArtifactsGitHttp,
		readFileFromRepo,
		commitPrefixSnapshot,
	} = await import("./artifacts-git");
	const originalFetch = globalThis.fetch;
	const packet = (text: string) =>
		`${(Buffer.byteLength(text) + 4).toString(16).padStart(4, "0")}${text}`;
	const advertisement = (
		service: string,
		ref = "0000000000000000000000000000000000000000 capabilities^{}",
	) =>
		packet(`# service=${service}\n`) +
		"0000" +
		packet(`${ref}\0report-status delete-refs ofs-delta side-band-64k\n`) +
		"0000";
	let active = true,
		gets = 0,
		tokens = 0,
		creates = 0,
		requests = 0,
		uploads = 0;
	const assertReady = async () => {
		if (!active) throw new Error("original operation held");
	};
	const artifacts = {
		get: async () => {
			gets++;
			return {
				createToken: async () => {
					tokens++;
					return { plaintext: "secret?expires=123" };
				},
			};
		},
		create: async () => {
			creates++;
			return { token: "secret" };
		},
	} as unknown as Artifacts;
	const args = {
		artifacts,
		assertReady,
		accountId: "account",
		namespace: "tedix-prod",
		tediId: "tedi",
		slug: "tedi",
		files: [
			{ path: "workspace/daily/2026-10-04.md", content: "owned original" },
		],
		message: "original log",
	};
	try {
		globalThis.fetch = (async (input: any, init: any) => {
			requests++;
			const url = String(input);
			if (init?.method === "POST") {
				uploads++;
				assert.ok(init.body instanceof Uint8Array);
				assert.ok(init.body.byteLength > 0);
				active = false; // ACK belongs to the already-issued original upload.
				return new Response(
					packet(
						"\x01" +
							packet("unpack ok\n") +
							packet("ok refs/heads/main\n") +
							"0000",
					) + "0000",
					{
						headers: {
							"Content-Type": "application/x-git-receive-pack-result",
						},
					},
				);
			}
			const service = url.includes("git-receive-pack")
				? "git-receive-pack"
				: "git-upload-pack";
			return new Response(advertisement(service), {
				headers: { "Content-Type": `application/x-${service}-advertisement` },
			});
		}) as typeof fetch;
		const receipt = await commitDailyLogs(args);
		assert.match(receipt.commitOid, /^[a-f0-9]{40}$/);
		assert.equal(receipt.acknowledgedRef, "refs/heads/main");
		assert.equal(receipt.pushedRefs[receipt.acknowledgedRef]?.ok, true);
		assert.equal(receipt.fileCount, 1);
		assert.equal(uploads, 1);
		assert.equal(creates, 0);
		const before = requests;
		await assert.rejects(commitDailyLogs(args), /held/);
		assert.equal(requests, before);
		active = true;
		requests = 0;
		uploads = 0;
		// Revocation while upload bytes are awaited must precede the actual fetch.
		async function* delayedBody() {
			yield new Uint8Array([1]);
			await Promise.resolve();
			active = false;
			yield new Uint8Array([2]);
		}
		await assert.rejects(
			createArtifactsGitHttp(assertReady).request({
				url: "https://account.artifacts.cloudflare.net/git/receive-pack",
				method: "POST",
				body: delayedBody(),
			}),
			/held/,
		);
		assert.equal(requests, 0);
		active = true;
		const missing = {
			get: async () => {
				throw { code: "NOT_FOUND" };
			},
			create: async () => {
				throw new Error("reads must not provision");
			},
		} as unknown as Artifacts;
		assert.equal(
			await readFileFromRepo(
				missing,
				"account",
				"tedix-prod",
				"tedi",
				"tedi",
				"workspace/daily/day.md",
				assertReady,
			),
			null,
		);
		// A successful nonempty advertisement followed by a clone transport error
		// cannot become a freshly initialized forced repository replacement.
		requests = 0;
		globalThis.fetch = (async () => {
			requests++;
			if (requests > 1) throw new Error("clone network failure");
			return new Response(
				advertisement(
					"git-upload-pack",
					"1111111111111111111111111111111111111111 refs/heads/main",
				),
				{
					headers: {
						"Content-Type": "application/x-git-upload-pack-advertisement",
					},
				},
			);
		}) as typeof fetch;
		await assert.rejects(
			commitPrefixSnapshot({ ...args, prefix: "workspace/" }),
			/clone network failure/,
		);
		assert.equal(uploads, 0);
		requests = 0;
		await assert.rejects(
			readFileFromRepo(
				artifacts,
				"account",
				"tedix-prod",
				"tedi",
				"tedi",
				"workspace/daily/day.md",
				assertReady,
			),
			/clone network failure/,
		);
		active = true;
		uploads = 0;
		globalThis.fetch = (async (input: any, init: any) => {
			if (init?.method === "POST") {
				uploads++;
				throw new Error("unexpected destructive upload");
			}
			const receive = String(input).includes("git-receive-pack");
			const service = receive ? "git-receive-pack" : "git-upload-pack";
			return new Response(
				advertisement(
					service,
					receive
						? "1111111111111111111111111111111111111111 refs/heads/main"
						: undefined,
				),
				{
					headers: { "Content-Type": `application/x-${service}-advertisement` },
				},
			);
		}) as typeof fetch;
		await assert.rejects(commitDailyLogs(args));
		assert.equal(
			uploads,
			0,
			"a competing first commit cannot be overwritten by a force push",
		);
		active = true;
		globalThis.fetch = (async (input: any, init: any) => {
			if (init?.method === "POST")
				return new Response("0000", {
					headers: { "Content-Type": "application/x-git-receive-pack-result" },
				});
			const service = String(input).includes("git-receive-pack")
				? "git-receive-pack"
				: "git-upload-pack";
			return new Response(advertisement(service), {
				headers: { "Content-Type": `application/x-${service}-advertisement` },
			});
		}) as typeof fetch;
		await assert.rejects(commitDailyLogs(args), /Expected|acknowledged/);
		// Revocation between binding get and token issuance rejects the token effect.
		active = true;
		const priorTokens = tokens;
		const revoked = {
			get: async () => {
				active = false;
				return {
					createToken: async () => {
						tokens++;
						return { plaintext: "secret" };
					},
				};
			},
		} as unknown as Artifacts;
		await assert.rejects(
			commitDailyLogs({ ...args, artifacts: revoked }),
			/held/,
		);
		assert.equal(tokens, priorTokens);
		assert.ok(gets > 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
}
console.log(
	"PASS real Git HTTP admission, delayed-body revocation, original push ACK and fail-closed clone",
);
