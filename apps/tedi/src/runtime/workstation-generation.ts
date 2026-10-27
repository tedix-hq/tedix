import {
	hashTediBodyGenerationToken,
	type TediBodyGenerationStatus,
} from "@tedix/auth/tedi-identity";
import {
	RuntimeGeneration,
	type RuntimeBodyGeneration,
	type RuntimeBodyGenerationRecord,
	type RuntimeBodyStatus,
	type TediGenerationDb,
	verifyArmedBodyGeneration,
} from "./generation";
import {
	workstationExec,
	workstationWriteFile,
	withWorkstationObservationDeadline,
	type WorkstationRuntimeBody,
	type WorkstationRuntimeNamespace,
	type WorkstationExecResult,
} from "../workstation/computer-body";

export interface WorkstationGenerationControl {
	arm(options?: { requireToken?: boolean }): Promise<RuntimeBodyGeneration>;
	ensureBody(): Promise<WorkstationRuntimeBody>;
	exec?(
		command: string,
		options?: { cwd?: string; timeout?: number },
	): Promise<unknown>;
	heartbeat(): Promise<RuntimeBodyStatus>;
	status(status?: TediBodyGenerationStatus): Promise<RuntimeBodyStatus>;
	terminateGeneration(reason?: string): Promise<void>;
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function readProofCommand(proofEnvPath: string): string {
	const path = shellSingleQuote(proofEnvPath);
	return `set -eu; test -f ${path}; . ${path}; printf '%s\\n%s' "$TEDIX_BODY_GENERATION_ID" "$TEDIX_BODY_GENERATION_TOKEN"`;
}

interface BodyProof {
	generationId: string | null;
	token: string | null;
}

async function readBodyProof(
	sandbox: WorkstationRuntimeBody,
	proofEnvPath: string,
): Promise<BodyProof> {
	const result = await workstationExec(
		sandbox,
		readProofCommand(proofEnvPath),
		{
			timeout: 5_000,
		},
	);
	if (
		result.exitCode !== 0 ||
		result.timedOut ||
		result.signal !== undefined ||
		result.truncated
	)
		return { generationId: null, token: null };
	const [generationId, token] = String(result.stdout ?? "").split(/\r?\n/);
	return {
		generationId: generationId || null,
		token: token || null,
	};
}

interface WorkstationGenerationOptions {
	bodyKind: "workstation";
	db: TediGenerationDb;
	externalId?: string;
	namespace: WorkstationRuntimeNamespace;
	proofEnvPath: string;
	record: RuntimeBodyGenerationRecord;
	sandboxId?: string;
	tokenTtlMs?: number;
}

export class WorkstationGeneration
	extends RuntimeGeneration
	implements WorkstationGenerationControl
{
	private sandbox: WorkstationRuntimeBody | null = null;

	constructor(private readonly sandboxParams: WorkstationGenerationOptions) {
		super({
			bodyKind: sandboxParams.bodyKind,
			db: sandboxParams.db,
			externalId: sandboxParams.externalId ?? sandboxParams.record.id,
			record: sandboxParams.record,
			tokenTtlMs: sandboxParams.tokenTtlMs,
		});
	}

	async ensureBody(): Promise<WorkstationRuntimeBody> {
		if (!this.sandbox) {
			this.sandbox = this.sandboxParams.namespace.getByName(
				this.sandboxParams.sandboxId ?? this.sandboxParams.record.tediId,
			);
		}
		return this.sandbox;
	}

	override async terminateGeneration(reason?: string): Promise<void> {
		await super.terminateGeneration(reason);
		this.sandbox = null;
	}

	async exec(
		command: string,
		options?: { cwd?: string; timeout?: number },
	): Promise<WorkstationExecResult> {
		const sandbox = await this.ensureBody();
		return workstationExec(sandbox, command, options);
	}

	async writeBodyGenerationProof(): Promise<void> {
		const generation = await this.arm({ requireToken: true });
		if (!generation.token) return;
		const sandbox = await this.ensureBody();
		const content = [
			`export TEDIX_BODY_GENERATION_ID=${shellSingleQuote(generation.generationId)}`,
			`export TEDIX_BODY_GENERATION_TOKEN=${shellSingleQuote(generation.token)}`,
		].join("\n");
		const path = shellSingleQuote(this.sandboxParams.proofEnvPath);
		const prepared = await workstationExec(
			sandbox,
			`set -eu; mkdir -p "$(dirname -- ${path})"; umask 077; : > ${path}; chmod 600 ${path}`,
			{ timeout: 5_000 },
		);
		if (
			prepared.exitCode !== 0 ||
			prepared.timedOut ||
			prepared.signal !== undefined ||
			prepared.truncated
		) {
			throw new Error("Unable to prepare runtime body credential file");
		}
		await withWorkstationObservationDeadline(
			() =>
				workstationWriteFile(
					sandbox,
					this.sandboxParams.proofEnvPath,
					`${content}\n`,
				),
			{ timeoutMs: 5_000, operation: "body credential write" },
		);
	}

	async verifyBodyProof(): Promise<boolean> {
		let generation = await this.existingGeneration();
		if (!generation) return true;
		generation = await this.refreshTrackingFromStore(generation);
		if (!generation?.trackingEnabled) return true;
		// Proof is intentionally both body-presented and D1-current; the env file
		// alone is not authority for marking a generation ready.
		const sandbox = await this.ensureBody();
		const proof = await readBodyProof(sandbox, this.sandboxParams.proofEnvPath);
		if (!proof.generationId || !proof.token) return false;
		if (proof.generationId !== generation.generationId) return false;
		if (generation.token && proof.token !== generation.token) return false;
		const proofHash = await hashTediBodyGenerationToken(proof.token);
		if (proofHash !== generation.tokenHash) return false;
		return verifyArmedBodyGeneration(this.params.db, {
			generationId: proof.generationId,
			record: this.params.record,
			token: proof.token,
		});
	}

	override async status(
		status: TediBodyGenerationStatus = "ready",
	): Promise<RuntimeBodyStatus> {
		const generation = await this.existingGeneration();
		if (!generation) {
			return {
				externalId: this.params.externalId,
				generationId: "",
				status,
				trackingEnabled: false,
			};
		}
		if (status === "ready" && !(await this.verifyBodyProof())) {
			await this.markStatus("failed");
			throw new Error("Runtime body generation credential verification failed");
		}
		return this.markStatus(status);
	}
}
