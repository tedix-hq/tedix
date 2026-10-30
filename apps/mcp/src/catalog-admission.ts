import type { McpServer } from "@modelcontextprotocol/server";

const MAX_CATALOG_WAITERS = 16;
const CATALOG_QUEUE_WAIT_MS = 20_000;

function unavailable(reason: "full" | "deadline"): Response {
	return Response.json(
		{
			error: "mcp_catalog_busy",
			reason,
			message: "Tedix is serving another catalog request. Retry shortly.",
		},
		{
			status: 503,
			headers: { "Retry-After": "1", "Cache-Control": "private, no-store" },
		},
	);
}

/** A response timeout/cancel does not settle the SDK's dispatched handler. */
export class CatalogRequestLifetime {
	private handlers = 0;
	private operationDone = false;
	private responseDone = false;
	private closed = false;
	private closing: Promise<void> | undefined;
	private readonly cleanups: Array<() => Promise<void>> = [];

	constructor(private readonly release: () => void) {}

	attach(server: McpServer): void {
		const lifetime = this;
		server.server.setRequestHandler = new Proxy(
			server.server.setRequestHandler,
			{
				apply(target, receiver, args) {
					const handlerIndex = typeof args[1] === "function" ? 1 : 2;
					const handler = args[handlerIndex];
					args[handlerIndex] = function (this: unknown, ...input: unknown[]) {
						return lifetime.track(async () =>
							Reflect.apply(handler, this, input),
						);
					};
					return Reflect.apply(target, receiver, args);
				},
			},
		);
		this.cleanups.push(() => server.close());
	}

	async track<T>(handler: () => Promise<T>): Promise<T> {
		this.handlers++;
		try {
			return await handler();
		} finally {
			this.handlers--;
			this.maybeRelease();
		}
	}

	operationEnded(): void {
		this.operationDone = true;
		this.maybeRelease();
	}

	async responseEnded(): Promise<void> {
		this.responseDone = true;
		this.closing ??= (async () => {
			await Promise.allSettled(this.cleanups.splice(0).map((close) => close()));
			this.closed = true;
			this.maybeRelease();
		})();
		await this.closing;
	}

	private maybeRelease(): void {
		if (
			this.operationDone &&
			this.responseDone &&
			this.closed &&
			this.handlers === 0
		)
			this.release();
	}
}

type Admission = { queued: boolean; release: () => void };
type Waiter = { admit: () => void };

/** One hydrated catalog graph per isolate; queued requests have no server yet. */
export class CatalogAdmission {
	private active = false;
	private readonly waiters: Waiter[] = [];

	constructor(
		private readonly maxWaiters = MAX_CATALOG_WAITERS,
		private readonly waitMs = CATALOG_QUEUE_WAIT_MS,
	) {}

	private permit(queued: boolean): Admission {
		this.active = true;
		let released = false;
		return {
			queued,
			release: () => {
				if (released) return;
				released = true;
				this.active = false;
				this.waiters.shift()?.admit();
			},
		};
	}

	private acquire(signal: AbortSignal): Promise<Admission | Response> {
		if (signal.aborted)
			return Promise.resolve(new Response(null, { status: 499 }));
		if (!this.active) return Promise.resolve(this.permit(false));
		if (this.waiters.length >= this.maxWaiters)
			return Promise.resolve(unavailable("full"));
		return new Promise((resolve) => {
			const remove = () => {
				const index = this.waiters.indexOf(waiter);
				if (index >= 0) this.waiters.splice(index, 1);
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
			};
			const abort = () => {
				remove();
				resolve(new Response(null, { status: 499 }));
			};
			const waiter = {
				admit: () => {
					remove();
					resolve(this.permit(true));
				},
			};
			const timer = setTimeout(() => {
				remove();
				resolve(unavailable("deadline"));
			}, this.waitMs);
			signal.addEventListener("abort", abort, { once: true });
			this.waiters.push(waiter);
		});
	}

	async run(
		request: Request,
		handler: (
			lifetime: CatalogRequestLifetime,
			queued: boolean,
		) => Promise<Response>,
	): Promise<Response> {
		const admission = await this.acquire(request.signal);
		if (admission instanceof Response) return admission;
		if (request.signal.aborted) {
			admission.release();
			return new Response(null, { status: 499 });
		}
		const lifetime = new CatalogRequestLifetime(admission.release);
		let handedOff = false;
		try {
			const response = await handler(lifetime, admission.queued);
			lifetime.operationEnded();
			if (!response.body) {
				await lifetime.responseEnded();
				return response;
			}
			let reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
				response.body.getReader();
			const end = async () => {
				request.signal.removeEventListener("abort", abort);
				reader?.releaseLock();
				reader = undefined;
				await lifetime.responseEnded();
			};
			const cancel = async (reason?: unknown) => {
				try {
					await reader?.cancel(reason);
				} finally {
					await end();
				}
			};
			const abort = () => {
				void cancel(request.signal.reason).catch(() => {});
			};
			request.signal.addEventListener("abort", abort, { once: true });
			if (request.signal.aborted) {
				await cancel(request.signal.reason);
				return new Response(null, { status: 499 });
			}
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						const next = reader ? await reader.read() : { done: true as const };
						if (next.done) {
							await end();
							controller.close();
						} else controller.enqueue(next.value);
					} catch (error) {
						await end();
						controller.error(error);
					}
				},
				cancel,
			});
			const wrapped = new Response(body, response);
			handedOff = true;
			return wrapped;
		} finally {
			lifetime.operationEnded();
			if (!handedOff) await lifetime.responseEnded();
		}
	}
}

export const hydratedCatalogAdmission = new CatalogAdmission();
