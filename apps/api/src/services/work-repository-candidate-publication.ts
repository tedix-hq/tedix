import {
	RepositoryCandidateDescriptorSchema,
	RepositoryCandidatePublicationRecordSchema,
	RepositoryCandidatePublicationFailureSchema,
	RepositoryCandidatePreparationSchema,
	type RepositoryCandidatePreparation,
	type RepositoryCandidatePublicationRecord,
	type RepositoryCandidatePublicationObservation,
	type RepositoryCandidateState,
} from "@tedix/api-contract/schemas/repository-candidate";
import {
	WorkAttemptRepositorySchema,
	type WorkAttemptRepository,
} from "@tedix/api-contract/schemas/work-items";
import {
	repositoryCandidateContentDigest,
	repositoryCandidateContentError,
} from "@tedix/api-contract/utils/repository-candidate";
import type { WorkAttempt, WorkItem } from "@tedix/db/schema/work-items";
import {
	liveRepositoryCandidateScope,
	recordedRepositoryCandidate,
	RepositoryCandidateError,
} from "./work-repository-draft";
import { workAttemptRepositoryDescriptionPrefix } from "./work-artifacts-repository";
import type {
	buildCandidateCommit,
	sendCandidateCommit,
} from "./repository-candidate-git";

type Scope = {
	work: WorkItem;
	attempt: WorkAttempt;
	fence?: {
		executor: { type: "external_agent" | "tedi"; id: string };
		sessionId?: string;
		externalSessionKey?: string;
	};
};
export interface CandidatePublicationIO {
	artifacts: Pick<Artifacts, "get"> | undefined;
	waitUntil?: (promise: Promise<unknown>) => void;
	authority: () => Promise<Scope>;
	readCandidate: (scope: Scope) => Promise<RepositoryCandidateState>;
	reserve: (
		scope: Scope,
		record: RepositoryCandidatePublicationRecord,
	) => Promise<RepositoryCandidatePublicationRecord | null>;
	claim: (
		scope: Scope,
		digest: string,
	) => Promise<RepositoryCandidatePublicationRecord | null>;
	observe: (
		preparation: RepositoryCandidatePreparation,
		observation: RepositoryCandidatePublicationObservation,
	) => Promise<unknown>;
	priorEffect: (
		preparation: RepositoryCandidatePreparation,
	) => Promise<"acknowledged" | "observed" | null>;
	build: typeof buildCandidateCommit;
	send: typeof sendCandidateCommit;
}
export type CandidatePublicationSelection = {
	expectedBaseRevision: string;
	expectedPosition: { generation: number; revision: number };
	expectedContentDigest: string;
};

function requireThat(value: unknown, message: string): asserts value {
	if (!value) throw new RepositoryCandidateError(message);
}
async function hash(value: unknown) {
	const bytes = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(JSON.stringify(value)),
		),
	);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function within<T>(run: () => Promise<T>, at: number): Promise<T> {
	requireThat(Date.now() < at, "Candidate publication deadline elapsed");
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			run(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new RepositoryCandidateError(
								"Candidate publication deadline elapsed",
							),
						),
					Math.max(1, at - Date.now()),
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
function positionEqual(
	a: { generation: number; revision: number },
	b: { generation: number; revision: number },
) {
	return a.generation === b.generation && a.revision === b.revision;
}
export function repositoryCandidatePublicationRecord(
	attempt: WorkAttempt,
): RepositoryCandidatePublicationRecord | null {
	const value = attempt.metadata.repositoryCandidatePublication;
	if (value === undefined) return null;
	const parsed = RepositoryCandidatePublicationRecordSchema.safeParse(value);
	requireThat(parsed.success, "Recorded publication preparation is invalid");
	return parsed.data;
}

export async function validateRepositoryCandidatePreparation(
	p: RepositoryCandidatePreparation,
	scope: Scope,
) {
	const parsed = WorkAttemptRepositorySchema.safeParse(
		scope.attempt.metadata.repository,
	);
	const descriptor = RepositoryCandidateDescriptorSchema.safeParse(
		scope.attempt.metadata.repositoryCandidate,
	);
	requireThat(
		parsed.success && descriptor.success,
		"Recorded publication provenance is unavailable",
	);
	const r = parsed.data,
		d = p.descriptor;
	requireThat(
		r.status === "ready" &&
			r.repositoryId === d.repositoryId &&
			r.repositoryName === d.repositoryName &&
			r.baseRevision === p.repositoryBaseRevision &&
			r.attemptId === scope.attempt.id &&
			r.workItemId === scope.work.id &&
			r.admissionId === scope.attempt.admissionId &&
			d.organizationId === scope.work.orgId &&
			scope.attempt.orgId === scope.work.orgId &&
			scope.attempt.workItemId === scope.work.id &&
			d.workItemId === scope.work.id &&
			d.attemptId === scope.attempt.id &&
			d.admissionId === scope.attempt.admissionId &&
			JSON.stringify(descriptor.data) === JSON.stringify(d) &&
			p.remote === r.remote &&
			p.targetRef === `refs/heads/${r.defaultBranch}`,
		"Recorded publication has different repository or Attempt provenance",
	);
	const { preparationDigest, ...payload } = p;
	requireThat(
		(await hash(payload)) === preparationDigest,
		"Recorded publication preparation digest is invalid",
	);
	return r;
}
function assertLive(scope: Scope) {
	liveRepositoryCandidateScope(scope.work, scope.attempt);
	requireThat(
		Date.parse(scope.attempt.expiresAt ?? "") - Date.now() >= 90_000,
		"Candidate publication requires at least 90 seconds of remaining lease",
	);
	return recordedRepositoryCandidate(scope.work, scope.attempt);
}
function assertSelection(
	p: RepositoryCandidatePreparation,
	input: CandidatePublicationSelection,
) {
	requireThat(
		p.descriptor.baseRevision === input.expectedBaseRevision &&
			p.contentDigest === input.expectedContentDigest &&
			positionEqual(p.position, input.expectedPosition),
		"Sealed candidate selection does not match the prepared publication",
	);
}
async function verifiedRepository(
	artifacts: CandidatePublicationIO["artifacts"],
	r: WorkAttemptRepository,
	at: number,
) {
	requireThat(artifacts, "Cloudflare Artifacts binding is unavailable");
	const repo = await within(() => artifacts.get(r.repositoryName), at);
	try {
		const info = await within(() => repo.info(), at);
		const prefix = workAttemptRepositoryDescriptionPrefix(r);
		const description =
			r.mode === "fork"
				? `${prefix};source:${r.sourceRepositoryName};ref:${encodeURIComponent(r.sourceRef!)};base:${r.baseRevision}`
				: prefix;
		const url = new URL(info.remote);
		requireThat(
			info.id === r.repositoryId &&
				info.name === r.repositoryName &&
				info.description === description &&
				info.remote === r.remote &&
				info.defaultBranch === r.defaultBranch &&
				url.protocol === "https:" &&
				!url.username &&
				!url.password &&
				!url.search &&
				!url.hash &&
				/^[A-Za-z0-9_./-]+$/.test(info.defaultBranch) &&
				!info.defaultBranch
					.split("/")
					.some((v) => !v || v === "." || v === ".."),
			"Repository identity, remote or recorded branch changed",
		);
		return { repo, info };
	} catch (error) {
		repo[Symbol.dispose]();
		throw error;
	}
}
async function observed(
	repo: ArtifactsRepo,
	p: RepositoryCandidatePreparation,
	prior: "acknowledged" | "observed" | null,
	effect: RepositoryCandidatePublicationObservation["effect"],
	cleanup: RepositoryCandidatePublicationObservation["cleanup"],
	at: number,
): Promise<RepositoryCandidatePublicationObservation> {
	let headRevision: string | null = null,
		objectPresent: boolean | null = null;
	try {
		const [head] = await within(
			() =>
				repo.log({ ref: p.targetRef.slice("refs/heads/".length), limit: 1 }),
			at,
		);
		if (head && /^[a-f0-9]{40}$/.test(head.hash)) headRevision = head.hash;
	} catch {
		/* Missing readback cannot establish publication. */
	}
	try {
		const object = await within(() => repo.readCommit(p.commitRevision), at);
		objectPresent =
			!!object &&
			object.hash === p.commitRevision &&
			object.treeHash === p.treeRevision &&
			(p.unchanged ||
				(object.parents.length === 1 &&
					object.parents[0] === p.descriptor.baseRevision)) &&
			(p.unchanged ||
				(object.message === p.recipe.message.replace(/\n$/, "") &&
					object.author.name === p.recipe.author.name &&
					object.author.email === p.recipe.author.email &&
					object.authoredAt === p.recipe.author.timestamp &&
					object.committer.name === p.recipe.committer.name &&
					object.committer.email === p.recipe.committer.email &&
					object.committedAt === p.recipe.committer.timestamp));
	} catch {
		/* Object availability alone never establishes a ref update. */
	}
	const actual = p.unchanged
		? "unchanged"
		: effect === "acknowledged" || prior === "acknowledged"
			? "acknowledged"
			: prior === "observed" ||
				  (headRevision === p.commitRevision && objectPresent)
				? "observed"
				: effect;
	return {
		effect: actual,
		headRevision,
		objectPresent,
		superseded:
			(actual === "acknowledged" || actual === "observed") &&
			headRevision !== null &&
			headRevision !== p.commitRevision,
		cleanup,
		observedAt: new Date().toISOString(),
	};
}

async function persistObservation(
	io: Pick<CandidatePublicationIO, "observe">,
	p: RepositoryCandidatePreparation,
	o: RepositoryCandidatePublicationObservation,
	at: number,
) {
	try {
		await within(() => io.observe(p, o), at);
		return true;
	} catch {
		return false;
	}
}

/** Historical reconciliation reads the provider and appends facts; it never mints or sends Git. */
export async function reconcileRepositoryCandidatePublication(
	io: Pick<CandidatePublicationIO, "artifacts" | "priorEffect" | "observe">,
	scope: Scope,
	finalAt = Date.now() + 30_000,
) {
	const at = finalAt - 5_000,
		record = repositoryCandidatePublicationRecord(scope.attempt);
	requireThat(record, "This Attempt has no prepared repository publication");
	const repository = await validateRepositoryCandidatePreparation(
		record.preparation,
		scope,
	);
	let prior: "acknowledged" | "observed" | null = null;
	try {
		prior = await within(() => io.priorEffect(record.preparation), at);
	} catch {
		/* Provider facts can still be observed without the prior evidence read. */
	}
	let observation: RepositoryCandidatePublicationObservation = {
		effect: prior ?? (record.attemptedAt ? "unknown" : "prepared"),
		headRevision: null,
		objectPresent: null,
		superseded: false,
		cleanup: "not_minted",
		observedAt: new Date().toISOString(),
	};
	try {
		const { repo } = await verifiedRepository(io.artifacts, repository, at);
		try {
			observation = await observed(
				repo,
				record.preparation,
				prior,
				observation.effect,
				"not_minted",
				at,
			);
		} finally {
			repo[Symbol.dispose]();
		}
	} catch (error) {
		if (error instanceof RepositoryCandidateError) throw error;
	}
	const evidenceRecorded = await persistObservation(
		io,
		record.preparation,
		observation,
		finalAt,
	);
	return { record, observation, evidenceRecorded };
}

export async function applyRepositoryCandidatePublication(
	io: CandidatePublicationIO,
	input: CandidatePublicationSelection,
) {
	const finalAt = Date.now() + 30_000,
		at = finalAt - 5_000,
		first = await within(io.authority, at),
		descriptor = assertLive(first);
	let record = repositoryCandidatePublicationRecord(first.attempt);
	if (record) {
		await validateRepositoryCandidatePreparation(record.preparation, first);
		assertSelection(record.preparation, input);
		if (record.attemptedAt)
			return reconcileRepositoryCandidatePublication(io, first, finalAt);
	}
	const state = await within(() => io.readCandidate(first), at);
	requireThat(
		state.sealed &&
			state.seal &&
			positionEqual(state.seal.position, input.expectedPosition) &&
			positionEqual(state.snapshot.position, input.expectedPosition) &&
			state.seal.contentDigest === input.expectedContentDigest &&
			state.contentDigest === input.expectedContentDigest &&
			descriptor.baseRevision === input.expectedBaseRevision &&
			state.snapshot.canonical.revisionId === descriptor.baseRevision &&
			!repositoryCandidateContentError(
				state.snapshot.files,
				descriptor.files.map((f) => f.path),
			) &&
			(await repositoryCandidateContentDigest(state.snapshot.files)) ===
				input.expectedContentDigest,
		"Candidate seal, content, position or base changed",
	);
	const repository = liveRepositoryCandidateScope(first.work, first.attempt);
	const { repo, info } = await verifiedRepository(io.artifacts, repository, at);
	let cleanup: RepositoryCandidatePublicationObservation["cleanup"] =
			"not_minted",
		tokenId: string | null = null,
		mintStarted = false;
	let pendingMint: Promise<ArtifactsCreateTokenResult> | null = null,
		disposeLater = false;
	try {
		const [head] = await within(
			() => repo.log({ ref: info.defaultBranch, limit: 1 }),
			at,
		);
		requireThat(
			head?.hash === descriptor.baseRevision,
			"Repository head changed; the sealed candidate is stale",
		);
		const base = await within(
			() => repo.readCommit(descriptor.baseRevision),
			at,
		);
		requireThat(
			base && base.hash === descriptor.baseRevision,
			"Candidate base commit is unavailable",
		);
		const timestamp = Math.floor(Date.now() / 1000),
			person = {
				name: "Tedix repository candidate",
				email: "repository-candidate@tedix.invalid",
				timestamp,
				timezoneOffset: 0,
			};
		const recipe = record?.preparation.recipe ?? {
			message: `Apply sealed candidate ${input.expectedContentDigest}\n\nWork-Item: ${descriptor.workItemId}\nWork-Attempt: ${descriptor.attemptId}`,
			author: person,
			committer: person,
		};
		const built = await within(
			() =>
				io.build({
					baseCommitOid: descriptor.baseRevision,
					baseTreeOid: base.treeHash,
					frozenFiles: state.snapshot.files,
					selectedEntries: descriptor.files,
					commitRecipe: recipe,
					readTree: (oid) => within(() => repo.readTree(oid), at),
					deadlineAt: at,
				}),
			at,
		);
		if (record) {
			requireThat(
				built.commitOid === record.preparation.commitRevision &&
					built.treeOid === record.preparation.treeRevision &&
					built.objectManifestDigest ===
						record.preparation.objectManifestDigest &&
					built.unchanged === record.preparation.unchanged,
				"Prepared candidate object changed during replay",
			);
		} else {
			const payload = {
				version: 1 as const,
				descriptor,
				position: input.expectedPosition,
				contentDigest: input.expectedContentDigest,
				repositoryBaseRevision: repository.baseRevision,
				targetRef: `refs/heads/${info.defaultBranch}`,
				remote: info.remote,
				recipe,
				treeRevision: built.treeOid,
				commitRevision: built.commitOid,
				objectManifestDigest: built.objectManifestDigest,
				unchanged: built.unchanged,
				preparedAt: new Date().toISOString(),
			};
			const preparation = RepositoryCandidatePreparationSchema.parse({
				...payload,
				preparationDigest: await hash(payload),
			});
			const current = await within(io.authority, at);
			requireThat(
				JSON.stringify(assertLive(current)) === JSON.stringify(descriptor),
				"Candidate provenance changed before preparation",
			);
			record = await within(
				() => io.reserve(current, { preparation, attemptedAt: null }),
				at,
			);
			if (!record) {
				const winner = await within(io.authority, at);
				return reconcileRepositoryCandidatePublication(io, winner, finalAt);
			}
		}
		let effect: RepositoryCandidatePublicationObservation["effect"] =
			built.unchanged ? "unchanged" : "prepared";
		let stage: "authority" | "token" | "send" | "claim" = "authority";
		let failure: RepositoryCandidatePublicationObservation["failure"];
		if (!built.unchanged) {
			try {
				const current = await within(io.authority, at);
				assertLive(current);
				await validateRepositoryCandidatePreparation(
					record.preparation,
					current,
				);
				requireThat(
					io.waitUntil,
					"Publication requires a managed cleanup lifetime",
				);
				stage = "token";
				mintStarted = true;
				pendingMint = repo.createToken("write", 60).then((t) => {
					tokenId = t.id || t.plaintext || null;
					return t;
				});
				const token = await within(() => pendingMint!, at);
				requireThat(
					token.id &&
						token.scope === "write" &&
						token.plaintext &&
						Number.isFinite(Date.parse(token.expiresAt)) &&
						Date.parse(token.expiresAt) > Date.now() + 10_000 &&
						Date.parse(token.expiresAt) <= Date.now() + 65_000,
					"Artifacts did not issue the requested bounded write token",
				);
				stage = "send";
				const sent = await within(
					() =>
						io.send({
							remote: info.remote,
							targetRef: record!.preparation.targetRef,
							expectedOldOid: descriptor.baseRevision,
							commitOid: built.commitOid,
							pack: built.pack,
							authorization: `Bearer ${token.plaintext}`,
							deadlineAt: at,
							// Admission and Git CAS are separate: revocation after this check
							// cannot cancel a POST already dispatched to the provider.
							beforePost: async () => {
								stage = "claim";
								const renewed = await within(io.authority, at);
								assertLive(renewed);
								await validateRepositoryCandidatePreparation(
									record!.preparation,
									renewed,
								);
								const claimed = await within(
									() =>
										io.claim(renewed, record!.preparation.preparationDigest),
									at,
								);
								requireThat(
									claimed && claimed.attemptedAt,
									"Another request already claimed this publication or authority expired",
								);
								record = claimed;
							},
						}),
					at,
				);
				effect =
					sent.kind === "acknowledged" &&
					sent.ref === record.preparation.targetRef &&
					sent.oldOid === descriptor.baseRevision &&
					sent.newOid === built.commitOid
						? "acknowledged"
						: sent.kind === "rejected"
							? "rejected"
							: "unknown";
			} catch (error) {
				const parsed = RepositoryCandidatePublicationFailureSchema.safeParse({
					stage,
					reason:
						error instanceof Error &&
						error.name === "CandidateGitError" &&
						"reason" in error
							? error.reason
							: "publication_failed",
				});
				failure = parsed.success
					? parsed.data
					: { stage, reason: "publication_failed" };
				effect = record.attemptedAt ? "unknown" : "prepared";
			} finally {
				if (tokenId) {
					try {
						cleanup = (await within(
							() => repo.revokeToken(tokenId!),
							finalAt - 1_000,
						))
							? "revoked"
							: "failed";
					} catch {
						cleanup = "failed";
					}
				} else if (mintStarted) {
					cleanup = "failed";
					if (pendingMint) {
						disposeLater = true;
						// A late mint retains its capability until its own bounded revocation finishes.
						const lateCleanup = pendingMint
							.then(async (token) => {
								if (token.id || token.plaintext)
									await within(
										() => repo.revokeToken(token.id || token.plaintext),
										Date.now() + 5_000,
									);
							})
							.catch(() => undefined)
							.finally(() => repo[Symbol.dispose]());
						io.waitUntil!(lateCleanup);
					}
				}
			}
		}
		const prepared = record.preparation;
		let prior: "acknowledged" | "observed" | null = null;
		try {
			prior = await within(() => io.priorEffect(prepared), at);
		} catch {
			/* Preserve a known send result even when the evidence read is unavailable. */
		}
		const observation = await observed(
			repo,
			record.preparation,
			prior,
			effect,
			cleanup,
			at,
		);
		if (failure) observation.failure = failure;
		const evidenceRecorded = await persistObservation(
			io,
			record.preparation,
			observation,
			finalAt,
		);
		return { record, observation, evidenceRecorded };
	} finally {
		if (!disposeLater) repo[Symbol.dispose]();
	}
}
