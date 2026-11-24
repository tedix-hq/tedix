import { expect, it, vi } from "vite-plus/test";
import { sendArtifactsCommit } from "./artifacts-git-push";

const base = "a".repeat(40);
const next = "b".repeat(40);
const packet = (text: string) =>
	(text.length + 4).toString(16).padStart(4, "0") + text;

async function send(lines: string[]) {
	const fetcher = vi.fn<typeof fetch>(async (_url, init = {}) => {
		if (init.method === "GET")
			return new Response(
				packet("# service=git-receive-pack\n") +
					"0000" +
					lines.map(packet).join("") +
					"0000",
				{
					headers: {
						"Content-Type": "application/x-git-receive-pack-advertisement",
					},
				},
			);
		throw new Error("Unexpected publication");
	});
	const pack = new Uint8Array(32);
	pack.set(new TextEncoder().encode("PACK"));
	const result = sendArtifactsCommit({
		remote: `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/test/theme.git`,
		targetRef: "refs/heads/main",
		expectedOldOid: base,
		commitOid: next,
		pack,
		maxPackBytes: 32,
		authorization: "Bearer fixture",
		deadlineAt: Date.now() + 20_000,
		fetcher,
	});
	return { result, fetcher };
}

it.each([
	[
		`${base} HEAD\0report-status\n`,
		`${base} refs/heads/main^{}\n`,
		`${base} .have\n`,
	],
	[`${"0".repeat(40)} capabilities^{}\0report-status\n`],
	[
		`${base} HEAD\0report-status\n`,
		`${next} refs/heads/main\n`,
		`${base} refs/tags/v1^{}\n`,
	],
])(
	"does not publish without the exact advertised base: %j",
	async (...lines) => {
		const { result, fetcher } = await send(lines);
		await expect(result).resolves.toEqual({
			kind: "rejected",
			reason: "base_changed",
		});
		expect(fetcher).toHaveBeenCalledOnce();
	},
);

it("creates an unadvertised ref when the old oid is all zeros", async () => {
	const zeros = "0".repeat(40);
	const fetcher = vi.fn<typeof fetch>(async (_url, init = {}) => {
		if (init.method === "GET")
			return new Response(
				packet("# service=git-receive-pack\n") +
					"0000" +
					packet(`${base} HEAD\0report-status\n`) +
					packet(`${base} refs/heads/main\n`) +
					"0000",
				{
					headers: {
						"Content-Type": "application/x-git-receive-pack-advertisement",
					},
				},
			);
		return new Response(
			packet("unpack ok\n") + packet(`ok refs/heads/topic\n`) + "0000",
			{
				headers: {
					"Content-Type": "application/x-git-receive-pack-result",
				},
			},
		);
	});
	const pack = new Uint8Array(32);
	pack.set(new TextEncoder().encode("PACK"));
	const result = await sendArtifactsCommit({
		remote: `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/test/theme.git`,
		targetRef: "refs/heads/topic",
		expectedOldOid: zeros,
		commitOid: next,
		pack,
		maxPackBytes: 32,
		authorization: "Bearer fixture",
		deadlineAt: Date.now() + 20_000,
		fetcher,
	});
	expect(result).toEqual({
		kind: "acknowledged",
		ref: "refs/heads/topic",
		oldOid: zeros,
		newOid: next,
	});
	expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([
	[`${base} refs/heads/main\0report-status\n`, `${next} refs/heads/main\n`],
	[`${base} HEAD\0report-status\n`, `invalid refs/heads/main\n`],
])("rejects ambiguous or malformed target entries: %j", async (...lines) => {
	const { result, fetcher } = await send(lines);
	await expect(result).rejects.toThrow("advertisement_ref");
	expect(fetcher).toHaveBeenCalledOnce();
});
