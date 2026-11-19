const SHA = /^[a-f0-9]{40}$/;
const encoder = new TextEncoder();
const limits = {
	advertisementBytes: 64 * 1024,
	advertisedRefs: 512,
	responseBytes: 64 * 1024,
	totalMs: 30_000,
	httpMs: 10_000,
};

export class ArtifactsGitError extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}

export type ArtifactsGitSendResult =
	| { kind: "acknowledged"; ref: string; oldOid: string; newOid: string }
	| { kind: "rejected"; reason: string }
	| { kind: "unknown"; reason: string };

function check(condition: unknown, reason: string): asserts condition {
	if (!condition) throw new ArtifactsGitError(reason);
}
function deadline(at: number) {
	check(Number.isFinite(at) && at > Date.now(), "deadline");
	return Math.min(at, Date.now() + limits.totalMs);
}
function alive(at: number) {
	check(Date.now() < at, "deadline");
}
async function until<T>(promise: Promise<T>, at: number): Promise<T> {
	alive(at);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new ArtifactsGitError("deadline")),
					Math.max(1, at - Date.now()),
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
function validateDestination(remote: string, targetRef: string) {
	let url: URL;
	try {
		url = new URL(remote);
	} catch {
		throw new ArtifactsGitError("remote");
	}
	check(
		url.protocol === "https:" &&
			/^[a-f0-9]{32}\.artifacts\.cloudflare\.net$/.test(url.hostname) &&
			!url.port &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			/^\/git\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*\.git$/.test(
				url.pathname,
			),
		"remote",
	);
	check(
		/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(targetRef) &&
			!targetRef.includes("..") &&
			!targetRef.includes("//") &&
			!targetRef.endsWith("/") &&
			!targetRef.endsWith(".") &&
			!targetRef
				.split("/")
				.some((part) => part.endsWith(".lock") || part.startsWith(".")),
		"ref",
	);
	return url.toString();
}
function packet(text: string) {
	const bytes = encoder.encode(text);
	const prefix = encoder.encode(
		(bytes.byteLength + 4).toString(16).padStart(4, "0"),
	);
	const out = new Uint8Array(prefix.length + bytes.length);
	out.set(prefix);
	out.set(bytes, 4);
	return out;
}
function packets(bytes: Uint8Array): Array<string | null> {
	const result: Array<string | null> = [];
	let offset = 0;
	while (offset < bytes.length) {
		check(offset + 4 <= bytes.length, "packet");
		const prefix = new TextDecoder().decode(bytes.subarray(offset, offset + 4));
		check(/^[a-f0-9]{4}$/i.test(prefix), "packet");
		const length = Number.parseInt(prefix, 16);
		offset += 4;
		if (length === 0) {
			result.push(null);
			continue;
		}
		check(
			length >= 4 && length <= 65520 && offset + length - 4 <= bytes.length,
			"packet",
		);
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				bytes.subarray(offset, offset + length - 4),
			);
		} catch {
			throw new ArtifactsGitError("packet");
		}
		result.push(text);
		offset += length - 4;
	}
	return result;
}
async function boundedBody(
	response: Response,
	limit: number,
	at: number,
): Promise<Uint8Array> {
	const length = response.headers.get("Content-Length");
	check(
		!length || (/^\d+$/.test(length) && Number(length) <= limit),
		"response_budget",
	);
	check(response.body, "response_missing");
	const reader = response.body.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const next = await until(reader.read(), at);
			if (next.done) break;
			size += next.value.byteLength;
			check(size <= limit, "response_budget");
			check(parts.length < 1024, "response_budget");
			parts.push(next.value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const part of parts) {
			bytes.set(part, offset);
			offset += part.byteLength;
		}
		return bytes;
	} catch (error) {
		void reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}

export async function sendArtifactsCommit(input: {
	remote: string;
	targetRef: string;
	expectedOldOid: string;
	commitOid: string;
	pack: Uint8Array;
	maxPackBytes: number;
	authorization: string;
	fetcher?: typeof fetch;
	deadlineAt: number;
	beforePost?: () => Promise<void>;
}): Promise<ArtifactsGitSendResult> {
	const at = deadline(input.deadlineAt),
		remote = validateDestination(input.remote, input.targetRef);
	check(
		SHA.test(input.expectedOldOid) &&
			SHA.test(input.commitOid) &&
			input.commitOid !== input.expectedOldOid,
		"oids",
	);
	check(
		input.pack.byteLength >= 32 &&
			input.pack.byteLength <= input.maxPackBytes &&
			new TextDecoder().decode(input.pack.subarray(0, 4)) === "PACK",
		"pack",
	);
	check(
		input.authorization.startsWith("Bearer ") &&
			input.authorization.length <= 512 &&
			!/[\r\n\0]/.test(input.authorization),
		"authorization",
	);
	const fetcher = input.fetcher ?? fetch;
	async function request(path: string, init: RequestInit) {
		const controller = new AbortController();
		const end = Math.min(at, Date.now() + limits.httpMs);
		const timer = setTimeout(
			() => controller.abort(),
			Math.max(1, end - Date.now()),
		);
		try {
			const response = await until(
				fetcher(`${remote}${path}`, {
					...init,
					redirect: "manual",
					signal: controller.signal,
					headers: { ...init.headers, Authorization: input.authorization },
				}),
				end,
			);
			check(response.status === 200, "http_status");
			return { response, end, timer, controller };
		} catch {
			clearTimeout(timer);
			controller.abort();
			throw new ArtifactsGitError("http");
		}
	}
	const advertised = await request("/info/refs?service=git-receive-pack", {
		method: "GET",
		headers: { Accept: "application/x-git-receive-pack-advertisement" },
	});
	let lines: Array<string | null>;
	try {
		check(
			advertised.response.headers.get("Content-Type")?.split(";")[0]?.trim() ===
				"application/x-git-receive-pack-advertisement",
			"advertisement_type",
		);
		lines = packets(
			await boundedBody(
				advertised.response,
				limits.advertisementBytes,
				advertised.end,
			),
		);
	} finally {
		clearTimeout(advertised.timer);
		advertised.controller.abort();
	}
	check(
		lines.length >= 4 &&
			lines[0] === "# service=git-receive-pack\n" &&
			lines[1] === null &&
			lines.at(-1) === null,
		"advertisement",
	);
	const refs = new Map<string, string>();
	let capabilities: string[] = [];
	for (let index = 2; index < lines.length - 1; index++) {
		const line = lines[index];
		check(typeof line === "string", "advertisement");
		const parts = line.replace(/\n$/, "").split("\0");
		check(parts.length === (index === 2 ? 2 : 1), "advertisement");
		if (index === 2) capabilities = parts[1]!.split(" ");
		const match = /^([a-f0-9]{40}) (HEAD|refs\/[A-Za-z0-9._/-]+)$/.exec(
			parts[0]!,
		);
		check(
			match &&
				(match[2] !== "HEAD" || index === 2) &&
				!refs.has(match[2]!) &&
				refs.size < limits.advertisedRefs,
			"advertisement_ref",
		);
		refs.set(match[2]!, match[1]!);
	}
	check(capabilities.includes("report-status"), "report_status_required");
	if (refs.get(input.targetRef) !== input.expectedOldOid)
		return { kind: "rejected", reason: "base_changed" };
	const update = packet(
		`${input.expectedOldOid} ${input.commitOid} ${input.targetRef}\0report-status\n`,
	);
	const body = new Uint8Array(update.length + 4 + input.pack.length);
	body.set(update);
	body.set(encoder.encode("0000"), update.length);
	body.set(input.pack, update.length + 4);
	alive(at);
	if (input.beforePost) await until(input.beforePost(), at);
	alive(at);
	try {
		const sent = await request("/git-receive-pack", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-git-receive-pack-request",
				Accept: "application/x-git-receive-pack-result",
			},
			body,
		});
		try {
			check(
				sent.response.headers.get("Content-Type")?.split(";")[0]?.trim() ===
					"application/x-git-receive-pack-result",
				"result_type",
			);
			const status = packets(
				await boundedBody(sent.response, limits.responseBytes, sent.end),
			);
			check(status.length === 3 && status[2] === null, "status");
			check(
				typeof status[0] === "string" &&
					/^unpack [^\0\r\n]+\n$/.test(status[0]),
				"status",
			);
			const denied =
				typeof status[1] === "string" &&
				status[1].startsWith(`ng ${input.targetRef} `) &&
				/^ng [^\0\r\n]+\n$/.test(status[1]);
			if (status[0] !== "unpack ok\n") {
				check(denied, "status");
				return { kind: "rejected", reason: "unpack_rejected" };
			}
			if (status[1] === `ok ${input.targetRef}\n`)
				return {
					kind: "acknowledged",
					ref: input.targetRef,
					oldOid: input.expectedOldOid,
					newOid: input.commitOid,
				};
			check(denied, "status");
			return { kind: "rejected", reason: "ref_rejected" };
		} finally {
			clearTimeout(sent.timer);
			sent.controller.abort();
		}
	} catch {
		return { kind: "unknown", reason: "publication_unknown" };
	}
}
