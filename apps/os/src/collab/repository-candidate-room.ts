import {
	RepositoryCandidateRoomRequestSchema,
	type RepositoryCandidateDescriptor,
	type RepositoryCandidateState,
} from "@tedix/api-contract/schemas/repository-candidate";
import {
	repositoryCandidateContentDigest,
	repositoryCandidateContentError,
	repositoryCandidateDocKey,
	repositoryCandidateRoomName,
} from "@tedix/api-contract/utils/repository-candidate";
import {
	serviceBindingFetch,
	type FetcherLike,
} from "@tedix/api-client/internal";
import type { OtAuthority, OtAuthorityStorage } from "./ot/authority";
import type { CodeContent } from "./ot/code-change";
import type { CodeChangeSubmission } from "./ot/wire";
import { isOversizedMessage, parseClientFrame } from "./protocol";

const STORAGE_KEY = "repository-candidate:scope";
type CandidateScope = {
	descriptor: RepositoryCandidateDescriptor;
	sealed: boolean;
	seal: RepositoryCandidateState["seal"];
};

/** Scope and seals belong to the existing room; all text still flows through its OT authority. */
export class RepositoryCandidateRoom {
	#value: CandidateScope | undefined;
	#loaded: Promise<void> | undefined;
	#operations: Promise<unknown> = Promise.resolve();
	#permitUntil = 0;
	constructor(
		private readonly storage: OtAuthorityStorage,
		private readonly authority: OtAuthority,
		private readonly api?: FetcherLike,
	) {}
	async load(): Promise<void> {
		this.#loaded ??= this.storage
			.get<CandidateScope>(STORAGE_KEY)
			.then((value) => {
				this.#value = value;
			});
		await this.#loaded;
	}
	get descriptor(): RepositoryCandidateDescriptor | undefined {
		return this.#value?.descriptor;
	}
	get sealed(): boolean {
		return this.#value?.sealed ?? false;
	}
	matches(descriptor: RepositoryCandidateDescriptor): boolean {
		return JSON.stringify(this.descriptor) === JSON.stringify(descriptor);
	}
	validateContent(content: CodeContent): void {
		if (!this.#value) return;
		if (Date.now() >= this.#permitUntil)
			throw new Error("Repository Attempt authority expired");
		if (this.#value.sealed)
			throw new Error("This repository candidate is sealed");
		const error = repositoryCandidateContentError(
			Object.fromEntries(content),
			this.#value.descriptor.files.map((file) => file.path),
		);
		if (error) throw new Error(error);
	}
	validateSubmission(submission: CodeChangeSubmission): void {
		if (!this.#value || this.#value.sealed)
			throw new Error("Repository candidate is unavailable or sealed");
		const paths = this.#value.descriptor.files.map((file) => file.path);
		if (
			submission.change.some(
				([path, change]) => !paths.includes(path) || !("edit" in change),
			)
		)
			throw new Error(
				"Only text edits to the frozen selected files are permitted",
			);
	}
	async access(userIds: string[]): Promise<Record<string, "build" | null>> {
		await this.load();
		if (!this.#value || this.#value.sealed) return {};
		const result = await this.#checkAccess(this.#value.descriptor, userIds);
		return result?.roles ?? {};
	}
	async #checkAccess(
		descriptor: RepositoryCandidateDescriptor,
		userIds: string[],
	): Promise<{ roles: Record<string, "build" | null> } | null> {
		if (!this.api) {
			this.#permitUntil = 0;
			return null;
		}
		try {
			const response = await serviceBindingFetch(this.api)(
				"https://api/__internal/repository-candidate-access",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ descriptor, userIds }),
					signal: AbortSignal.timeout(5000),
				},
			);
			if (!response.ok) {
				this.#permitUntil = 0;
				return null;
			}
			const result = (await response.json()) as {
				allowed?: boolean;
				roles?: Record<string, unknown>;
				expiresAt?: string | null;
			};
			const expiresAt = result.expiresAt ? Date.parse(result.expiresAt) : NaN;
			if (
				!result.allowed ||
				!Number.isFinite(expiresAt) ||
				expiresAt <= Date.now()
			) {
				this.#permitUntil = 0;
				return null;
			}
			this.#permitUntil = expiresAt;
			return {
				roles: Object.fromEntries(
					userIds.map((id) => [
						id,
						result.roles?.[id] === "build" ? "build" : null,
					]),
				),
			};
		} catch {
			this.#permitUntil = 0;
			return null;
		}
	}
	async handle(request: Request): Promise<Response> {
		if (request.method !== "POST") return new Response(null, { status: 405 });
		const raw = await request.text();
		if (isOversizedMessage(new TextEncoder().encode(raw).byteLength))
			return new Response(null, { status: 413 });
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			return new Response(null, { status: 400 });
		}
		const parsed = RepositoryCandidateRoomRequestSchema.safeParse(value);
		if (!parsed.success) return new Response(null, { status: 400 });
		const input = parsed.data;
		const run = this.#operations.then(async () => {
			try {
				await this.load();
				if (
					input.descriptor.docKey !==
						repositoryCandidateDocKey(input.descriptor) ||
					input.descriptor.roomName !==
						repositoryCandidateRoomName(input.descriptor)
				)
					throw new Error("Repository room identity mismatch");
				if (!(await this.#checkAccess(input.descriptor, [])))
					throw new Error("Repository Attempt authority is unavailable");
				if (input.operation === "initialize") {
					if (
						!input.files ||
						input.submission ||
						input.expectedPosition ||
						input.expectedContentDigest
					)
						throw new Error(
							"Initialization requires only the hydrated source files",
						);
					const error = repositoryCandidateContentError(
						input.files,
						input.descriptor.files.map((file) => file.path),
					);
					if (error) throw new Error(error);
					if (
						input.descriptor.files.some(
							(file) =>
								new TextEncoder().encode(input.files![file.path]!)
									.byteLength !== file.bytes,
						)
					)
						throw new Error(
							"Hydrated source size differs from the frozen descriptor",
						);
					if (this.#value && !this.matches(input.descriptor))
						throw new Error(
							"This room already has a different frozen candidate",
						);
					await this.authority.seed(new Map(Object.entries(input.files)), {
						revision: 0,
						revisionId: input.descriptor.baseRevision,
					});
					const snapshot = await this.authority.snapshot();
					if (
						snapshot.canonical.revision !== 0 ||
						snapshot.canonical.revisionId !== input.descriptor.baseRevision
					)
						throw new Error("Repository candidate base mismatch");
					if (!this.#value) {
						if (
							snapshot.position.generation !== 0 ||
							snapshot.position.revision !== 0 ||
							(await repositoryCandidateContentDigest(
								Object.fromEntries(snapshot.content),
							)) !== (await repositoryCandidateContentDigest(input.files))
						)
							throw new Error(
								"An existing stream cannot become a repository candidate",
							);
						this.#value = {
							descriptor: input.descriptor,
							sealed: false,
							seal: null,
						};
						await this.storage.put(STORAGE_KEY, this.#value);
					}
				} else {
					if (!this.#value || !this.matches(input.descriptor))
						throw new Error(
							"Repository candidate has not been initialized with this descriptor",
						);
					if (input.files)
						throw new Error("A frozen candidate cannot be reseeded");
					if (input.operation === "submit") {
						const frame = parseClientFrame(
							JSON.stringify({
								t: "submit",
								id: 0,
								submission: input.submission,
							}),
						);
						if (frame?.t !== "submit")
							throw new Error("Malformed repository edit");
						this.validateSubmission(frame.submission);
						const result = await this.authority.submit(
							frame.submission,
							input.actor,
						);
						if (!result.ok) throw new Error(result.message);
					} else if (input.operation === "seal") {
						if (
							!input.expectedPosition ||
							!input.expectedContentDigest ||
							input.submission
						)
							throw new Error(
								"Sealing requires an exact stream position and content digest",
							);
						const snapshot = await this.snapshot();
						const head = await this.authority.head();
						const expected = input.expectedPosition;
						if (
							head.generation !== expected.generation ||
							head.revision !== expected.revision ||
							snapshot.snapshot.position.generation !== expected.generation ||
							snapshot.snapshot.position.revision !== expected.revision ||
							snapshot.contentDigest !== input.expectedContentDigest
						)
							throw new Error("Repository candidate changed before sealing");
						if (
							this.#value.seal &&
							(this.#value.seal.position.generation !== expected.generation ||
								this.#value.seal.position.revision !== expected.revision ||
								this.#value.seal.contentDigest !== input.expectedContentDigest)
						)
							throw new Error(
								"Repository candidate already has a different seal",
							);
						this.#value = {
							...this.#value,
							sealed: true,
							seal: {
								position: expected,
								contentDigest: input.expectedContentDigest,
							},
						};
						await this.storage.put(STORAGE_KEY, this.#value);
					} else if (
						input.submission ||
						input.expectedPosition ||
						input.expectedContentDigest
					)
						throw new Error("Unexpected repository read arguments");
				}
				return Response.json(await this.snapshot());
			} catch (error) {
				return Response.json(
					{
						message:
							error instanceof Error
								? error.message
								: "Repository candidate unavailable",
					},
					{ status: 409 },
				);
			}
		});
		this.#operations = run.catch(() => undefined);
		return run;
	}
	async snapshot(): Promise<RepositoryCandidateState> {
		if (!this.#value)
			throw new Error("Repository candidate is not initialized");
		const snapshot = await this.authority.snapshot();
		if (
			snapshot.canonical.revision !== 0 ||
			snapshot.canonical.revisionId !== this.#value.descriptor.baseRevision
		)
			throw new Error("Repository candidate lost its pinned base");
		const files = Object.fromEntries(snapshot.content);
		return {
			snapshot: {
				position: snapshot.position,
				canonical: {
					revision: 0,
					revisionId: this.#value.descriptor.baseRevision,
				},
				files,
			},
			contentDigest: await repositoryCandidateContentDigest(files),
			sealed: this.#value.sealed,
			seal: this.#value.seal,
		};
	}
}
