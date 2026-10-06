import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * Unit coverage for the `email()` entrypoint: MIME parse → R2 archive →
 * durable mailbox row via apps/api → Agents SDK routing decision. All
 * bindings are mocked — no live D1/R2/service bindings.
 */
const mocks = vi.hoisted(() => ({
	callRpc: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	routeAgentEmail: vi.fn<(...args: unknown[]) => Promise<void>>(),
	getTediEmailIngressRouteBySlug:
		vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("@tedix/api-client/internal", () => ({
	callRpc: mocks.callRpc,
	serviceBindingFetch: vi.fn(() => vi.fn()),
}));

vi.mock("agents", () => ({
	routeAgentEmail: mocks.routeAgentEmail,
}));

vi.mock("agents/email", () => ({
	createSecureReplyEmailResolver: vi.fn(),
}));

vi.mock("@tedix/db/queries/tedi-runtime-bootstrap", () => ({
	getTediEmailIngressRouteBySlug: mocks.getTediEmailIngressRouteBySlug,
}));

import { handleInboundEmail } from "../src/email-ingress";

type EmailEnv = Parameters<typeof handleInboundEmail>[1];

function makeEnv() {
	const bucket = {
		put: vi.fn(async (_key: string) => ({})),
		delete: vi.fn(async () => {}),
	};
	const env = {
		API_SERVICE: {} as Fetcher,
		DB: {} as D1Database,
		TEDI_AGENT: { idFromName: vi.fn() } as unknown as DurableObjectNamespace,
		TEDI_STORAGE: bucket as unknown as R2Bucket,
		ENVIRONMENT: "production",
	} as EmailEnv;
	return { env, bucket };
}

function makeMessage(raw: string, to: string) {
	const bytes = new TextEncoder().encode(raw);
	const message = {
		from: "sender@example.com",
		to,
		rawSize: bytes.byteLength,
		raw: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
		headers: new Headers(),
		setReject: vi.fn(),
		forward: vi.fn(),
		reply: vi.fn(),
	};
	return message as unknown as ForwardableEmailMessage;
}

const ctx = {
	waitUntil: vi.fn(),
	passThroughOnException: vi.fn(),
	props: {},
} as unknown as ExecutionContext;
const mailboxMessageId = "6e213b19-e9c2-49d3-8103-318e019c231b";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("email() entrypoint", () => {
	it("parses MIME, archives to R2, persists the durable row, and routes to the tedi agent", async () => {
		const { env, bucket } = makeEnv();
		mocks.callRpc.mockResolvedValue({
			delivered: true,
			threadId: "thread-1",
			messageId: mailboxMessageId,
		});
		mocks.getTediEmailIngressRouteBySlug.mockResolvedValue({
			agentId: "agent-cto",
		});
		mocks.routeAgentEmail.mockResolvedValue(undefined);

		const raw = [
			"From: Ada Lovelace <ada@example.com>",
			"To: CTO <cto@tedix.tech>",
			"Subject: Quarterly numbers",
			"Message-ID: <msg-1@example.com>",
			'Content-Type: multipart/mixed; boundary="outer"',
			"",
			"--outer",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Please review the attached invoice.",
			"--outer",
			"Content-Type: application/pdf; name=invoice.pdf",
			"Content-Disposition: attachment; filename=invoice.pdf",
			"Content-Transfer-Encoding: base64",
			"",
			"SGVsbG8=",
			"--outer--",
		].join("\r\n");
		const message = makeMessage(raw, "cto@tedix.tech");

		await handleInboundEmail(message, env, ctx);

		// Archive: raw .eml plus the attachment landed in R2 under the slug prefix.
		const putKeys = bucket.put.mock.calls.map((call) => call[0] as string);
		expect(putKeys.some((key) => key.endsWith("/raw.eml"))).toBe(true);
		expect(putKeys.some((key) => key.includes("/attachments/"))).toBe(true);
		for (const key of putKeys) expect(key.startsWith("email/cto/")).toBe(true);

		// Durable mailbox persistence precedes the content-free dispatch receipt.
		expect(mocks.callRpc).toHaveBeenCalledTimes(2);
		const [procedure, payload] = mocks.callRpc.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(procedure).toBe("tediEmail/inboundEmail");
		expect(payload.slug).toBe("cto");
		expect(payload.subject).toBe("Quarterly numbers");
		expect(payload.from).toEqual({
			email: "ada@example.com",
			name: "Ada Lovelace",
		});
		expect(payload.body).toBe("Please review the attached invoice.");
		expect(payload.rawR2Key).toMatch(/\/raw\.eml$/);
		const attachments = payload.attachments as Array<Record<string, unknown>>;
		expect(attachments).toHaveLength(1);
		expect(attachments[0]?.filename).toBe("invoice.pdf");
		expect(attachments[0]?.r2Key).toMatch(/\/attachments\//);
		expect(mocks.callRpc.mock.calls[1]?.[0]).toBe("tediEmail/recordOutcome");
		expect(mocks.callRpc.mock.calls[1]?.[1]).toMatchObject({
			kind: "worker_dispatch",
			messageId: mailboxMessageId,
			result: "sdk_returned",
		});
		const receipt = mocks.callRpc.mock.calls[1]?.[1] as Record<string, unknown>;
		expect(receipt.elapsedMs).toEqual(expect.any(Number));
		expect(receipt.elapsedMs).toBeGreaterThanOrEqual(0);
		expect(Object.keys(receipt).sort()).toEqual([
			"elapsedMs",
			"kind",
			"messageId",
			"result",
		]);

		// Routing decision: exactly one routeAgentEmail call whose resolver pins
		// the message to the TEDI_AGENT namespace with the resolved agent id.
		expect(mocks.routeAgentEmail).toHaveBeenCalledTimes(1);
		const routeOptions = mocks.routeAgentEmail.mock.calls[0]?.[2] as {
			resolver: (email: unknown, env: unknown) => Promise<unknown>;
		};
		await expect(routeOptions.resolver({}, env)).resolves.toEqual({
			agentName: "TEDI_AGENT",
			agentId: "agent-cto",
		});

		// One bounded D1 lookup resolves dispatch eligibility and the DO name.
		expect(mocks.getTediEmailIngressRouteBySlug).toHaveBeenCalledWith(
			env.DB,
			"cto",
		);

		expect(message.setReject).not.toHaveBeenCalled();
	});

	it("records an SDK no-route observation without rejecting persisted mail", async () => {
		const { env } = makeEnv();
		mocks.callRpc.mockResolvedValue({
			delivered: true,
			threadId: "thread-1",
			messageId: mailboxMessageId,
		});
		mocks.getTediEmailIngressRouteBySlug.mockResolvedValue({
			agentId: "agent-cto",
		});
		mocks.routeAgentEmail.mockImplementation(
			async (_message, _env, options) => {
				(options as { onNoRoute: () => void }).onNoRoute();
			},
		);
		const message = makeMessage("Subject: test\r\n\r\nBody", "cto@tedix.tech");

		await handleInboundEmail(message, env, ctx);

		expect(mocks.callRpc.mock.calls[1]?.[1]).toMatchObject({
			kind: "worker_dispatch",
			messageId: mailboxMessageId,
			result: "no_route",
		});
		expect(message.setReject).not.toHaveBeenCalled();
	});

	it("keeps persisted mail delivered when routing or receipt recording fails", async () => {
		const { env } = makeEnv();
		mocks.callRpc
			.mockResolvedValueOnce({
				delivered: true,
				threadId: "thread-1",
				messageId: mailboxMessageId,
			})
			.mockRejectedValueOnce(new Error("receipt unavailable"));
		mocks.getTediEmailIngressRouteBySlug.mockResolvedValue({
			agentId: "agent-cto",
		});
		mocks.routeAgentEmail.mockRejectedValue(new Error("SDK unavailable"));
		const message = makeMessage("Subject: test\r\n\r\nBody", "cto@tedix.tech");

		await expect(
			handleInboundEmail(message, env, ctx),
		).resolves.toBeUndefined();
		expect(mocks.callRpc.mock.calls[1]?.[1]).toMatchObject({
			kind: "worker_dispatch",
			messageId: mailboxMessageId,
			result: "failed",
		});
		expect(message.setReject).not.toHaveBeenCalled();
	});

	it("records skipped dispatch for a persisted mailbox row with no SDK route", async () => {
		const { env } = makeEnv();
		mocks.callRpc.mockResolvedValue({
			delivered: true,
			threadId: "thread-1",
			messageId: mailboxMessageId,
		});
		mocks.getTediEmailIngressRouteBySlug.mockResolvedValue(null);
		const message = makeMessage("Subject: test\r\n\r\nBody", "cto@tedix.tech");

		await handleInboundEmail(message, env, ctx);

		expect(mocks.routeAgentEmail).not.toHaveBeenCalled();
		expect(mocks.callRpc.mock.calls[1]?.[1]).toMatchObject({
			kind: "worker_dispatch",
			messageId: mailboxMessageId,
			result: "skipped",
		});
	});

	it("rejects malformed mail for unknown recipients and cleans up archived objects", async () => {
		const { env, bucket } = makeEnv();
		mocks.callRpc.mockResolvedValue({ delivered: false });

		// Malformed MIME: declared boundary never appears and there is no
		// header/body separator — the parser must still fail soft into the
		// fallback text path rather than throw.
		const raw = [
			"From: mallory@example.com",
			'Content-Type: multipart/mixed; boundary="missing"',
			"Subject: garbage",
		].join("\r\n");
		const message = makeMessage(raw, "nobody@tedix.tech");

		await handleInboundEmail(message, env, ctx);

		expect(mocks.callRpc).toHaveBeenCalledTimes(1);
		expect(message.setReject).toHaveBeenCalledWith(
			"Unknown tedi email recipient",
		);
		// Everything archived before the delivery verdict is deleted again.
		const putKeys = bucket.put.mock.calls.map((call) => call[0] as string);
		expect(putKeys.length).toBeGreaterThan(0);
		expect(bucket.delete).toHaveBeenCalledWith(putKeys);
		expect(mocks.routeAgentEmail).not.toHaveBeenCalled();
	});
});
