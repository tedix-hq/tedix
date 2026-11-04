import { describe, it, expect, vi } from "vite-plus/test";
import { repositoryCandidateContentDigest } from "@tedix/api-contract/utils/repository-candidate";
import type {
	RepositoryCandidatePublicationRecord,
	RepositoryCandidateState,
	RepositoryCandidatePublicationObservation,
} from "@tedix/api-contract/schemas/repository-candidate";
import type { WorkItem, WorkAttempt } from "@tedix/db/schema/work-items";
import { repositoryCandidateDescriptor } from "./work-repository-draft";
import {
	applyRepositoryCandidatePublication,
	reconcileRepositoryCandidatePublication,
	type CandidatePublicationIO,
} from "./work-repository-candidate-publication";

const A = "a".repeat(40),
	B = "b".repeat(40),
	C = "c".repeat(40),
	T = "d".repeat(40),
	M = "e".repeat(64);
async function fixture(base = A) {
	const work = {
		id: "11111111-1111-4111-8111-111111111111",
		orgId: "org",
		disposition: "accepted",
		completedAt: null,
		cancelledAt: null,
	} as WorkItem;
	const attempt = {
		id: "22222222-2222-4222-8222-222222222222",
		orgId: "org",
		workItemId: work.id,
		admissionId: "33333333-3333-4333-8333-333333333333",
		runtimeState: "running",
		expiresAt: new Date(Date.now() + 300_000).toISOString(),
		metadata: {},
	} as WorkAttempt;
	const repository = {
		version: 1,
		provider: "cloudflare_artifacts",
		status: "ready",
		mode: "create",
		repositoryId: "isolated-id",
		repositoryName: "isolated",
		remote: "https://artifacts.example/isolated.git",
		defaultBranch: "main",
		sourceRepositoryName: null,
		sourceRef: null,
		baseRevision: null,
		workItemId: work.id,
		workItemVersion: 1,
		admissionSpecRevision: "spec",
		admissionId: attempt.admissionId,
		attemptId: attempt.id,
		observedAt: new Date().toISOString(),
		reason: null,
	};
	attempt.metadata.repository = repository;
	const descriptor = await repositoryCandidateDescriptor({
		work,
		attempt,
		baseRevision: base,
		selected: [{ path: "file.ts", blobRevision: B, bytes: 3 }],
	});
	attempt.metadata.repositoryCandidate = descriptor;
	const files = { "file.ts": "changed" },
		contentDigest = await repositoryCandidateContentDigest(files),
		position = { generation: 0, revision: 2 };
	const state: RepositoryCandidateState = {
		snapshot: { position, canonical: { revision: 0, revisionId: base }, files },
		contentDigest,
		sealed: true,
		seal: { position, contentDigest },
	};
	const input = {
		expectedBaseRevision: base,
		expectedPosition: position,
		expectedContentDigest: contentDigest,
	};
	let head = base,
		object = false,
		prior: "acknowledged" | "observed" | null = null;
	let recipe: {
		message: string;
		author: {
			name: string;
			email: string;
			timestamp: number;
			timezoneOffset: number;
		};
		committer: {
			name: string;
			email: string;
			timestamp: number;
			timezoneOffset: number;
		};
	};
	let sends = 0,
		mints = 0,
		revokes = 0,
		authorityCalls = 0;
	const observations: RepositoryCandidatePublicationObservation[] = [];
	const repo = {
		info: vi.fn(async () => ({
			id: repository.repositoryId,
			name: repository.repositoryName,
			description: `tedix-work:${work.id};attempt:${attempt.id};admission:${attempt.admissionId}`,
			remote: repository.remote,
			defaultBranch: "main",
		})),
		log: vi.fn(async (_opts?: { ref: string; limit: number }) => [
			{ hash: head },
		]),
		readCommit: vi.fn(async (oid: string) =>
			oid === base
				? { hash: base, treeHash: B }
				: object
					? {
							hash: C,
							treeHash: T,
							parents: [base],
							message: recipe.message,
							author: recipe.author,
							committer: recipe.committer,
							authoredAt: recipe.author.timestamp,
							committedAt: recipe.committer.timestamp,
						}
					: null,
		),
		readTree: vi.fn(async () => []),
		createToken: vi.fn(async () => {
			mints++;
			return {
				id: "private-token-id",
				plaintext: "private-fixture-token?expires=60",
				scope: "write",
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			};
		}),
		revokeToken: vi.fn(async () => {
			revokes++;
			return true;
		}),
		[Symbol.dispose]: vi.fn(),
	};
	const background: Promise<unknown>[] = [];
	const io: CandidatePublicationIO = {
		waitUntil: (p) => {
			background.push(p);
		},
		artifacts: { get: async () => repo as unknown as ArtifactsRepo } as Pick<
			Artifacts,
			"get"
		>,
		authority: async () => {
			authorityCalls++;
			return { work, attempt };
		},
		readCandidate: async () => state,
		reserve: async (_scope, record) => {
			if (attempt.metadata.repositoryCandidatePublication) return null;
			attempt.metadata.repositoryCandidatePublication = structuredClone(record);
			return record;
		},
		claim: async () => {
			const record = attempt.metadata
				.repositoryCandidatePublication as RepositoryCandidatePublicationRecord;
			if (record.attemptedAt) return null;
			record.attemptedAt = new Date().toISOString();
			return structuredClone(record);
		},
		observe: async (_p, o) => {
			observations.push(o);
			if (o.effect === "acknowledged" || o.effect === "observed")
				prior = o.effect;
		},
		priorEffect: async () => prior,
		build: async (params) => {
			recipe = params.commitRecipe;
			return {
				unchanged: false,
				commitOid: C,
				treeOid: T,
				pack: new Uint8Array([1, 2]),
				objectManifestDigest: M,
				counters: {
					treeCount: 1,
					treeBytes: 1,
					rawObjectBytes: 1,
					looseObjectCount: 1,
					storedBytes: 1,
					packBytes: 2,
				},
			};
		},
		send: async (params) => {
			expect(params.authorization).toBe(
				"Bearer private-fixture-token?expires=60",
			);
			await params.beforePost();
			sends++;
			head = C;
			object = true;
			return {
				kind: "acknowledged",
				ref: "refs/heads/main",
				oldOid: base,
				newOid: C,
			};
		},
	};
	return {
		work,
		attempt,
		repository,
		descriptor,
		state,
		input,
		repo,
		io,
		observations,
		background,
		stats: () => ({ sends, mints, revokes, authorityCalls }),
		setHead: (v: string) => {
			head = v;
		},
		setObject: (v: boolean) => {
			object = v;
		},
	};
}

describe("candidate publication authority and replay", () => {
	it("prepares durably before credentials, claims one POST and revokes privately", async () => {
		const f = await fixture();
		const mint = f.repo.createToken.getMockImplementation()!;
		f.repo.createToken.mockImplementation(async () => {
			expect(f.attempt.metadata.repositoryCandidatePublication).toBeTruthy();
			return mint();
		});
		const r = await applyRepositoryCandidatePublication(f.io, f.input);
		expect(r.observation).toMatchObject({
			effect: "acknowledged",
			headRevision: C,
			objectPresent: true,
			cleanup: "revoked",
			superseded: false,
		});
		expect(f.stats()).toMatchObject({ sends: 1, mints: 1, revokes: 1 });
		expect(JSON.stringify(r)).not.toContain("private-fixture-token");
		expect(JSON.stringify(r)).not.toContain("private-token-id");
		await applyRepositoryCandidatePublication(f.io, f.input);
		expect(f.stats()).toMatchObject({ sends: 1, mints: 1, revokes: 1 });
	});
	it("reads the recorded branch name through the binding after publication", async () => {
		const f = await fixture();
		const log = f.repo.log.getMockImplementation()!;
		f.repo.log.mockImplementation(async (...args) => {
			expect(args[0]).toEqual({ ref: "main", limit: 1 });
			return log();
		});
		const r = await applyRepositoryCandidatePublication(f.io, f.input);
		expect(r.observation.headRevision).toBe(C);
	});
	it.each(["candidate_git_packet", "private-fixture-token"])(
		"reports only an allowlisted pre-POST reason: %s",
		async (reason) => {
			const f = await fixture();
			f.io.send = async () => {
				const error = new Error("private-fixture-token");
				error.name = "CandidateGitError";
				throw Object.assign(error, { reason });
			};
			const r = await applyRepositoryCandidatePublication(f.io, f.input);
			expect(r.record.attemptedAt).toBeNull();
			expect(r.observation).toMatchObject({
				effect: "prepared",
				cleanup: "revoked",
				failure: {
					stage: "send",
					reason:
						reason === "candidate_git_packet" ? reason : "publication_failed",
				},
			});
			expect(JSON.stringify(r)).not.toContain("private-fixture-token");
			expect(f.stats()).toMatchObject({ sends: 0, mints: 1, revokes: 1 });
		},
	);
	it("admits only one concurrent POST winner", async () => {
		const f = await fixture();
		await Promise.all([
			applyRepositoryCandidatePublication(f.io, f.input),
			applyRepositoryCandidatePublication(f.io, f.input),
		]);
		expect(f.stats().sends).toBe(1);
		expect(f.stats().mints).toBe(f.stats().revokes);
	});
	it.each(["position", "content", "base", "seal"])(
		"refuses changed %s before credentials",
		async (kind) => {
			const f = await fixture();
			if (kind === "position")
				f.state.snapshot.position = { generation: 0, revision: 9 };
			if (kind === "content") f.state.snapshot.files["file.ts"] = "other";
			if (kind === "base") f.input.expectedBaseRevision = B;
			if (kind === "seal") f.state.sealed = false;
			await expect(
				applyRepositoryCandidatePublication(f.io, f.input),
			).rejects.toThrow();
			expect(f.stats()).toMatchObject({ sends: 0, mints: 0 });
		},
	);
	it("refuses foreign repository provenance and short leases", async () => {
		const f = await fixture();
		f.attempt.expiresAt = new Date(Date.now() + 89_000).toISOString();
		await expect(
			applyRepositoryCandidatePublication(f.io, f.input),
		).rejects.toThrow(/90 seconds/);
		f.attempt.expiresAt = new Date(Date.now() + 300_000).toISOString();
		f.repo.info.mockResolvedValue({ ...(await f.repo.info()), id: "other" });
		await expect(
			applyRepositoryCandidatePublication(f.io, f.input),
		).rejects.toThrow(/identity/);
		expect(f.stats().mints).toBe(0);
	});
	it("rechecks authority immediately before POST and always revokes", async () => {
		const f = await fixture();
		const authority = f.io.authority;
		let calls = 0;
		f.io.authority = async () => {
			if (++calls === 4) throw new Error("revoked");
			return authority();
		};
		const r = await applyRepositoryCandidatePublication(f.io, f.input);
		expect(r.observation.effect).toBe("prepared");
		expect(r.observation.failure).toEqual({
			stage: "claim",
			reason: "publication_failed",
		});
		expect(f.stats()).toMatchObject({ sends: 0, mints: 1, revokes: 1 });
	});
	it("rejects an unbounded token and revokes even that invalid grant", async () => {
		const f = await fixture();
		f.repo.createToken.mockResolvedValue({
			id: "private-token-id",
			plaintext: "private-fixture-token",
			scope: "write",
			expiresAt: new Date(Date.now() + 600_000).toISOString(),
		});
		const r = await applyRepositoryCandidatePublication(f.io, f.input);
		expect(r.observation.effect).toBe("prepared");
		expect(r.observation.failure).toEqual({
			stage: "token",
			reason: "publication_failed",
		});
		expect(f.repo.revokeToken).toHaveBeenCalledWith("private-token-id");
		expect(f.stats().sends).toBe(0);
	});
	it("records cleanup failure separately from an acknowledged effect", async () => {
		const f = await fixture();
		f.repo.revokeToken.mockRejectedValue(new Error("private-fixture-token"));
		const r = await applyRepositoryCandidatePublication(f.io, f.input);
		expect(r.observation).toMatchObject({
			effect: "acknowledged",
			cleanup: "failed",
		});
		expect(JSON.stringify(r)).not.toContain("private-fixture-token");
	});
	it("keeps ACK H acknowledged if the branch subsequently advances to B", async () => {
		const f = await fixture(),
			send = f.io.send;
		f.io.send = async (p) => {
			const ack = await send(p);
			f.setHead(B);
			return ack;
		};
		const r = await applyRepositoryCandidatePublication(f.io, f.input);
		expect(r.observation).toMatchObject({
			effect: "acknowledged",
			headRevision: B,
			objectPresent: true,
			superseded: true,
		});
		const again = await reconcileRepositoryCandidatePublication(f.io, {
			work: f.work,
			attempt: f.attempt,
		});
		expect(again.observation.effect).toBe("acknowledged");
		expect(f.stats().sends).toBe(1);
	});
	it("does not equate an object-only unknown response with publication or retry it", async () => {
		const f = await fixture();
		f.io.send = async (p) => {
			await p.beforePost();
			f.setObject(true);
			f.setHead(B);
			return { kind: "unknown", reason: "transport" };
		};
		const r = await applyRepositoryCandidatePublication(f.io, f.input);
		expect(r.observation).toMatchObject({
			effect: "unknown",
			headRevision: B,
			objectPresent: true,
		});
		const mints = f.stats().mints;
		await applyRepositoryCandidatePublication(f.io, f.input);
		expect(f.stats().mints).toBe(mints);
	});
	it("can observe exact head H after an ambiguous response, including after expiry", async () => {
		const f = await fixture();
		f.io.send = async (p) => {
			await p.beforePost();
			f.setObject(true);
			f.setHead(C);
			return { kind: "unknown", reason: "lost ACK" };
		};
		const applied = await applyRepositoryCandidatePublication(f.io, f.input);
		expect(applied.observation.effect).toBe("observed");
		const metadata = JSON.stringify(f.attempt.metadata),
			stats = f.stats();
		f.attempt.runtimeState = "expired";
		f.attempt.expiresAt = new Date(Date.now() - 1).toISOString();
		f.io.authority = async () => {
			throw new Error("must not revive Attempt");
		};
		const r = await reconcileRepositoryCandidatePublication(f.io, {
			work: f.work,
			attempt: f.attempt,
		});
		expect(r.observation.effect).toBe("observed");
		expect(JSON.stringify(f.attempt.metadata)).toBe(metadata);
		expect(f.stats()).toEqual(stats);
	});
	it("refuses tampered immutable preparation on replay", async () => {
		const f = await fixture();
		await applyRepositoryCandidatePublication(f.io, f.input);
		const record = f.attempt.metadata
			.repositoryCandidatePublication as RepositoryCandidatePublicationRecord;
		record.preparation.recipe.message = "forged";
		await expect(
			reconcileRepositoryCandidatePublication(f.io, {
				work: f.work,
				attempt: f.attempt,
			}),
		).rejects.toThrow(/digest/);
	});
	it("returns unchanged without a token or POST", async () => {
		const f = await fixture(),
			build = f.io.build;
		f.io.build = async (p) => ({
			...(await build(p)),
			unchanged: true,
			commitOid: A,
			treeOid: B,
			pack: new Uint8Array(),
		});
		const r = await applyRepositoryCandidatePublication(f.io, f.input);
		expect(r.observation.effect).toBe("unchanged");
		expect(f.stats()).toMatchObject({ mints: 0, sends: 0 });
	});
});

describe("publication deadlines and historical provenance", () => {
	it("keeps the original null create base independent of the candidate commit", async () => {
		const f = await fixture(),
			r = await applyRepositoryCandidatePublication(f.io, f.input);
		expect(r.record.preparation.repositoryBaseRevision).toBeNull();
		expect(r.record.preparation.descriptor.baseRevision).toBe(A);
	});
	it("preserves an advanced fork candidate B while its original repository base remains A", async () => {
		const f = await fixture(B),
			info = f.repo.info.getMockImplementation()!;
		Object.assign(f.repository, {
			mode: "fork",
			baseRevision: A,
			sourceRepositoryName: "source",
			sourceRef: "main",
		});
		f.repo.info.mockImplementation(async () => ({
			...(await info()),
			description: `tedix-work:${f.work.id};attempt:${f.attempt.id};admission:${f.attempt.admissionId};source:source;ref:main;base:${A}`,
		}));
		const r = await applyRepositoryCandidatePublication(f.io, f.input);
		expect(r.observation.effect).toBe("acknowledged");
		expect(r.record.preparation.repositoryBaseRevision).toBe(A);
		expect(r.record.preparation.descriptor.baseRevision).toBe(B);
		f.repository.baseRevision = C;
		await expect(
			reconcileRepositoryCandidatePublication(f.io, {
				work: f.work,
				attempt: f.attempt,
			}),
		).rejects.toThrow(/provenance/);
	});
	it("revokes a malformed grant by plaintext when the provider omits its token id", async () => {
		const f = await fixture();
		f.repo.createToken.mockResolvedValue({
			id: "",
			plaintext: "private-fixture-token",
			scope: "write",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		const r = await applyRepositoryCandidatePublication(f.io, f.input);
		expect(r.observation.effect).toBe("prepared");
		expect(f.repo.revokeToken).toHaveBeenCalledWith("private-fixture-token");
		expect(f.stats().sends).toBe(0);
		expect(JSON.stringify(r)).not.toContain("private-fixture-token");
	});

	it("preserves a known ACK if evidence persistence fails", async () => {
		const f = await fixture();
		f.io.observe = async () => {
			throw new Error("D1 unavailable");
		};
		const r = await applyRepositoryCandidatePublication(f.io, f.input);
		expect(r.observation.effect).toBe("acknowledged");
		expect(r.evidenceRecorded).toBe(false);
		expect(f.stats().sends).toBe(1);
	});
	it("reserves cleanup time after the work deadline instead of skipping revocation", async () => {
		const f = await fixture();
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		try {
			let postPending = false;
			const postStarted = Promise.withResolvers<void>();
			f.io.send = async (p) => {
				await p.beforePost();
				postPending = true;
				postStarted.resolve();
				return new Promise(() => {});
			};
			const pending = applyRepositoryCandidatePublication(f.io, f.input);
			await postStarted.promise;
			expect(postPending).toBe(true);
			expect(f.repo.createToken).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(25_001);
			const r = await pending;
			expect(f.repo.revokeToken).toHaveBeenCalledTimes(1);
			expect(r.observation).toMatchObject({
				effect: "unknown",
				cleanup: "revoked",
			});
		} finally {
			vi.useRealTimers();
		}
	});
	it("revokes a late mint before disposing its retained capability and never sends", async () => {
		const f = await fixture();
		const mintStarted = Promise.withResolvers<void>();
		let resolve!: (t: {
			id: string;
			plaintext: string;
			scope: string;
			expiresAt: string;
		}) => void;
		f.repo.createToken.mockImplementation(
			() =>
				new Promise((r) => {
					resolve = r;
					mintStarted.resolve();
				}),
		);
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		try {
			const pending = applyRepositoryCandidatePublication(f.io, f.input);
			await mintStarted.promise;
			expect(f.repo.createToken).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(25_001);
			const result = await pending;
			expect(result.observation.cleanup).toBe("failed");
			expect(f.background).toHaveLength(1);
			expect(f.repo[Symbol.dispose]).not.toHaveBeenCalled();
			f.repo.revokeToken.mockImplementation(async () => {
				expect(f.repo[Symbol.dispose]).not.toHaveBeenCalled();
				return true;
			});
			resolve({
				id: "late-private-token",
				plaintext: "late-private-secret",
				scope: "write",
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			});
			await Promise.all(f.background);
			expect(f.repo.revokeToken).toHaveBeenCalledWith("late-private-token");
			expect(f.repo[Symbol.dispose]).toHaveBeenCalledTimes(1);
			expect(f.stats().sends).toBe(0);
			expect(JSON.stringify(result)).not.toContain("late-private-secret");
		} finally {
			vi.useRealTimers();
		}
	});
	it("bounds stuck evidence persistence without losing an acknowledged result", async () => {
		const f = await fixture();
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		let observed = false;
		try {
			const observationStarted = Promise.withResolvers<void>();
			f.io.observe = async () => {
				observed = true;
				observationStarted.resolve();
				return new Promise(() => {});
			};
			const pending = applyRepositoryCandidatePublication(f.io, f.input);
			await observationStarted.promise;
			expect(observed).toBe(true);
			await vi.advanceTimersByTimeAsync(30_001);
			const r = await pending;
			expect(r.observation.effect).toBe("acknowledged");
			expect(r.evidenceRecorded).toBe(false);
			expect(f.stats().sends).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
