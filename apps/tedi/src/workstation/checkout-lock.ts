import type { NativeProcess } from "@tedix/container-runtime/sandbox";
import {
	WorkstationDispatchUnknownError,
	WorkstationObservationTimeoutError,
	withWorkstationObservationDeadline,
	type WorkstationRuntimeBody,
	type WorkstationExecutionMetadata,
} from "./computer-body";
import { WORKSTATION_DIR } from "./paths";

const ADMISSION_MS = 30_000;
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
export const CHECKOUT_LOCK_PATH = `${WORKSTATION_DIR}/locks/checkout.lock`;
export const CHECKOUT_CLOSING_PATH = `${WORKSTATION_DIR}/locks/checkout.closing`;

// Reserved only for flock acquisition failure, before the command gate opens.
const LOCK_CONFLICT_EXIT = 200;
export class CheckoutAdmissionPendingError extends WorkstationDispatchUnknownError {
	constructor(
		id: string,
		readonly reason: "contention" | "observation",
	) {
		super(id);
		this.message = `checkout preparation pending: ${reason}; executionId=${id}`;
	}
}

export interface CheckoutOperation {
	command: string;
	cwd?: string;
	mode?: "shared" | "exclusive";
	allowClosing?: boolean;
	timeout?: number;
	executionId?: string;
	metadata?: WorkstationExecutionMetadata;
	/** Runs after this exact native process has acquired flock. */
	authorize(): Promise<void>;
}

/** Actual work and its authorization wait share one native process group/lock.
 * Control files are unique scratch data; no handshake enters process output. */
export function checkoutOperationCommand(input: {
	command: string;
	directory: string;
	mode: "shared" | "exclusive";
	allowClosing: boolean;
	token?: string;
}): string {
	const directory = quote(input.directory);
	const transaction = [
		"set -e",
		`trap 'rm -rf -- ${directory}' EXIT`,
		...(input.allowClosing
			? []
			: [
					`test ! -e ${quote(CHECKOUT_CLOSING_PATH)} || { echo 'workstation is closing' >&2; exit 75; }`,
				]),
		`printf acquired > ${quote(`${input.directory}/acquired`)}`,
		// This bounded wait belongs to the supervised process, not its caller.
		`i=0; while [ ! -f ${quote(`${input.directory}/authorized`)} ]; do i=$((i+1)); if [ "$i" -ge 300 ]; then exit 75; fi; sleep 0.1; done`,
		`test ! -L ${quote(`${input.directory}/authorized`)} && test "$(cat ${quote(`${input.directory}/authorized`)})" = ${quote(input.token ?? input.directory)} || exit 75`,
		// Keep flock in the supervising shell while the actual command runs.
		`bash -lc ${quote(input.command)}`,
	].join("\n");
	return [
		"set -e",
		`umask 077; mkdir -p ${quote(`${WORKSTATION_DIR}/locks`)}`,
		`mkdir ${directory}`,
		`exec flock ${input.mode === "exclusive" ? "-x" : "-s"} -w 30 -E ${LOCK_CONFLICT_EXIT} ${quote(CHECKOUT_LOCK_PATH)} bash -lc ${quote(transaction)}`,
	].join("\n");
}

export async function startCheckoutOperation(
	body: WorkstationRuntimeBody,
	input: CheckoutOperation,
): Promise<{ id: string; process: NativeProcess }> {
	const id = input.executionId ?? `checkout-${crypto.randomUUID()}`;
	const directory = `/tmp/tedix-checkout-${crypto.randomUUID()}`;
	const token = crypto.randomUUID();
	const launched = await body
		.launchExecution({
			executionId: id,
			argv: [
				"bash",
				"-lc",
				checkoutOperationCommand({
					command: input.command,
					directory,
					mode: input.mode ?? "exclusive",
					allowClosing: input.allowClosing ?? false,
					token,
				}),
			],
			cwd: input.cwd,
			timeout: input.timeout,
			metadata: input.metadata,
		})
		.catch(() => {
			throw new WorkstationDispatchUnknownError(id);
		});
	if (launched.state !== "started")
		throw new WorkstationDispatchUnknownError(id);
	const process = await body.getProcess(launched.nativeId).catch(() => {
		throw new WorkstationDispatchUnknownError(id);
	});
	if (!process) throw new WorkstationDispatchUnknownError(id);
	const readStatus = () =>
		process.status().catch(() => {
			throw new WorkstationDispatchUnknownError(id);
		});
	let stopped = false;
	let gateDispatched = false;
	const assertObserving = () => {
		if (stopped) throw new Error("Checkout authorization observation ended");
	};
	try {
		await withWorkstationObservationDeadline(
			async () => {
				for (;;) {
					assertObserving();
					const status = await readStatus();
					if (status.state !== "running") {
						if (
							status.state === "exited" &&
							status.exit.code === LOCK_CONFLICT_EXIT
						)
							throw new CheckoutAdmissionPendingError(id, "contention");
						throw new Error("Checkout operation ended before authorization");
					}
					if (
						await body.pathExists(`${directory}/acquired`).catch(() => {
							throw new WorkstationDispatchUnknownError(id);
						})
					)
						break;
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				assertObserving();
				await input.authorize();
				assertObserving();
				if ((await readStatus()).state !== "running")
					throw new Error("Checkout operation lost its native incarnation");
				assertObserving();
				await body
					.writeFile(`${directory}/authorization.tmp`, token)
					.catch(() => {
						throw new WorkstationDispatchUnknownError(id);
					});
				if ((await readStatus()).state !== "running")
					throw new Error("Checkout operation ended before gate publication");
				assertObserving();
				gateDispatched = true;
				await body.renamePath(
					`${directory}/authorization.tmp`,
					`${directory}/authorized`,
				);
			},
			{ timeoutMs: ADMISSION_MS, operation: "checkout authorization" },
		);
		return { id, process };
	} catch (error) {
		stopped = true;
		// Only this newly admitted operation may be canceled. Never revoke another
		// holder, reset the body, or replay an ambiguous native launch.
		if (gateDispatched) throw new WorkstationDispatchUnknownError(id);
		await withWorkstationObservationDeadline(() => process.kill(9), {
			timeoutMs: 1000,
			operation: "checkout admission cancellation",
		}).catch(() => undefined);
		if (error instanceof WorkstationObservationTimeoutError)
			throw new CheckoutAdmissionPendingError(id, "observation");
		throw error;
	}
}
