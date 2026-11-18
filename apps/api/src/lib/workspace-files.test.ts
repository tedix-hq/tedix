import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { DataResidencyError } from "../services/data-residency";
import {
	WORKSPACE_FILE_PDF_MAX_BYTES,
	pdfFileText,
	readWorkspaceFileContent,
	storeWorkspaceFileText,
	verifyWorkspaceFileSignature,
	workspaceFileSignature,
} from "./workspace-files";

const SECRET = "fictional-local-workspace-file-secret";
const NOW = Date.UTC(2026, 0, 1);
const EXP = NOW / 1000 + 300;
const IDENTITY = [
	"fictional-org",
	"10000000-0000-4000-8000-000000000001",
	"20000000-0000-4000-8000-000000000001",
] as const;
type Identity = readonly [string, string, string];

async function signedUrl(
	action = "read",
	identity: Identity = IDENTITY,
	exp = EXP,
) {
	const url = new URL(
		`/workspace-files/${identity.map(encodeURIComponent).join("/")}`,
		"https://files.example.test",
	);
	url.searchParams.set("exp", String(exp));
	url.searchParams.set(
		"sig",
		await workspaceFileSignature(SECRET, action, ...identity, exp),
	);
	return new URL(url.href);
}

function verify(url: URL, action = "read", identity: Identity = IDENTITY) {
	return verifyWorkspaceFileSignature(SECRET, action, ...identity, url);
}

describe("workspace file signed capabilities", () => {
	beforeEach(() => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);
	});
	afterEach(() => vi.restoreAllMocks());

	it.each(["read", "upload:1", "upload:2"])(
		"verifies a valid %s capability with real Web Crypto",
		async (action) => {
			expect(await verify(await signedUrl(action), action)).toBe(true);
		},
	);

	it.each([
		["read", "upload:1"],
		["upload:1", "read"],
		["upload:1", "upload:2"],
		["upload:2", "upload:1"],
	])("rejects replay from %s to %s", async (issued, requested) => {
		const url = await signedUrl(issued);
		expect(await verify(url, issued)).toBe(true);
		expect(await verify(url, requested)).toBe(false);
	});

	it.each([
		["organization", 0],
		["workspace", 1],
		["resource", 2],
	] as const)("binds the %s independently", async (_, index) => {
		const url = await signedUrl();
		const changed: [string, string, string] = [...IDENTITY];
		changed[index] += "-other";
		expect(await verify(url)).toBe(true);
		expect(await verify(url, "read", changed)).toBe(false);
	});

	it("rejects a different secret", async () => {
		const url = await signedUrl();
		expect(await verify(url)).toBe(true);
		expect(
			await verifyWorkspaceFileSignature(
				`${SECRET}-other`,
				"read",
				...IDENTITY,
				url,
			),
		).toBe(false);
	});

	it("binds expiry even when the changed value remains within the valid window", async () => {
		const url = await signedUrl();
		expect(await verify(url)).toBe(true);
		url.searchParams.set("exp", String(EXP + 1));
		expect(await verify(url)).toBe(false);
	});

	it.each([
		["one millisecond before expiry", EXP * 1000 - 1, true],
		["exactly at expiry", EXP * 1000, false],
		["one millisecond after expiry", EXP * 1000 + 1, false],
		[
			"one millisecond beyond the maximum lifetime",
			EXP * 1000 - 900_001,
			false,
		],
		["exactly at the maximum lifetime", EXP * 1000 - 900_000, true],
		["one millisecond inside the maximum lifetime", EXP * 1000 - 899_999, true],
	] as const)("checks the clock %s", async (_, now, accepted) => {
		const url = await signedUrl();
		vi.mocked(Date.now).mockReturnValue(now);
		expect(await verify(url)).toBe(accepted);
	});

	it.each([
		["expired by one second", NOW / 1000 - 1, false],
		["expires now", NOW / 1000, false],
		["expires in one second", NOW / 1000 + 1, true],
		["expires in 899 seconds", NOW / 1000 + 899, true],
		["expires in 900 seconds", NOW / 1000 + 900, true],
		["expires in 901 seconds", NOW / 1000 + 901, false],
	] as const)(
		"checks a correctly signed expiry that %s",
		async (_, exp, accepted) => {
			expect(await verify(await signedUrl("read", IDENTITY, exp))).toBe(
				accepted,
			);
		},
	);

	it.each([
		"not-a-number",
		"NaN",
		"Infinity",
		"-Infinity",
		"",
		" ",
		"0",
		"-1",
		String(EXP + 0.5),
		String(Number.MAX_SAFE_INTEGER),
		String(Number.MAX_SAFE_INTEGER + 1),
		"9007199254740993",
	])(
		"rejects malformed or invalid expiry %j even with its numeric value signed",
		async (raw) => {
			const url = await signedUrl("read", IDENTITY, Number(raw));
			url.searchParams.set("exp", raw);
			expect(await verify(url)).toBe(false);
		},
	);

	it.each(["exp", "sig", "both"])(
		"rejects missing %s query fields",
		async (field) => {
			const url = await signedUrl();
			if (field !== "sig") url.searchParams.delete("exp");
			if (field !== "exp") url.searchParams.delete("sig");
			expect(await verify(url)).toBe(false);
		},
	);

	it.each(["empty", "shorter", "longer"])(
		"rejects a %s signature",
		async (change) => {
			const url = await signedUrl();
			const sig = url.searchParams.get("sig")!;
			url.searchParams.set(
				"sig",
				change === "empty"
					? ""
					: change === "shorter"
						? sig.slice(1)
						: `${sig}A`,
			);
			expect(await verify(url)).toBe(false);
		},
	);

	it.each([0, 21, 42])(
		"rejects a same-length signature changed at byte %i",
		async (index) => {
			const url = await signedUrl();
			const sig = url.searchParams.get("sig")!;
			const replacement = sig[index] === "A" ? "B" : "A";
			url.searchParams.set(
				"sig",
				sig.slice(0, index) + replacement + sig.slice(index + 1),
			);
			expect(await verify(url)).toBe(false);
		},
	);

	it("round-trips URL-encoded punctuation and Unicode in every identity field", async () => {
		const identity: Identity = [
			'fictional/org%+ &?=#,:["雪"]',
			'workspace/%2F+ &?=#,:["é"]',
			'resource/%25+ &?=#,:["☃"]',
		];
		const url = await signedUrl("upload:2", identity);
		const decoded = url.pathname.split("/").slice(2).map(decodeURIComponent);
		expect(decoded).toEqual(identity);
		expect(await verify(url, "upload:2", identity)).toBe(true);
		expect(
			await verify(url, "upload:2", [decoded[0]!, decoded[1]!, decoded[2]!]),
		).toBe(true);
	});

	it.each([
		["slash versus encoded slash", "a/b", "a%2Fb"],
		["plus versus space", "a+b", "a b"],
		["comma versus quoted comma", "a,b", 'a","b'],
		["Unicode versus percent encoding", "雪", "%E9%9B%AA"],
	] as const)(
		"does not alias %s in any identity field",
		async (_, original, changed) => {
			for (const index of [0, 1, 2]) {
				const issued: [string, string, string] = [...IDENTITY];
				issued[index] = original;
				const requested: [string, string, string] = [...issued];
				requested[index] = changed;
				const url = await signedUrl("read", issued);
				expect(await verify(url, "read", issued)).toBe(true);
				expect(await verify(url, "read", requested)).toBe(false);
			}
		},
	);

	it.each([
		[
			["a/b", "c", "d"],
			["a", "b/c", "d"],
		],
		[
			["a", "b/c", "d"],
			["a", "b", "c/d"],
		],
		[
			['a","b', "c", "d"],
			["a", 'b","c', "d"],
		],
	] as const)(
		"keeps punctuation-separated identity tuples distinct: %j versus %j",
		async (issued, requested) => {
			const url = await signedUrl("read", issued);
			expect(await verify(url, "read", issued)).toBe(true);
			expect(await verify(url, "read", requested)).toBe(false);
		},
	);
});

describe("the whole text of an uploaded file", () => {
	const converted = (pages: string[]) =>
		`# report.pdf\n## Metadata\n- Title=Report\n\n## Contents\n${pages
			.map((text, index) => `### Page ${index + 1}\n${text}\n`)
			.join("")}`;
	const stored = (bytes: Uint8Array) =>
		({
			SKILL_ARTIFACTS: {
				get: async () => ({
					size: bytes.length,
					arrayBuffer: async () => bytes.buffer,
				}),
			},
		}) as unknown as Pick<CloudflareEnv, "SKILL_ARTIFACTS">;
	const pdf = (size = 9) => ({
		filename: "report.pdf",
		mimeType: "application/pdf",
		size,
	});

	it("writes a PDF as pages of lines and drops the converter's heading", () => {
		expect(
			pdfFileText(converted(["First page.\nMore.", "", "Last page."]), "r.pdf"),
		).toBe(
			"## Page 1\n\nFirst page.\nMore.\n\n## Page 2\n\n(This page has no readable text.)\n\n## Page 3\n\nLast page.",
		);
	});

	it("reports a scanned PDF as having no text instead of an empty file", async () => {
		expect(pdfFileText(converted(["", "  "]), "scan.pdf")).toBeNull();
		const read = await readWorkspaceFileContent(
			stored(new Uint8Array(9)),
			"key",
			pdf(),
			async () => converted(["", ""]),
		);
		expect(read).toEqual({ blocks: [], text: { status: "no_text", text: "" } });
	});

	it("reads a PDF through the converter and says why when it cannot", async () => {
		const env = stored(new Uint8Array(9));
		const names: string[] = [];
		expect(
			await readWorkspaceFileContent(env, "key", pdf(), async (bytes, name) => {
				names.push(`${name}:${bytes.length}`);
				return converted(["The fee is 40 EUR."]);
			}),
		).toEqual({
			blocks: [],
			text: { status: "text", text: "## Page 1\n\nThe fee is 40 EUR." },
		});
		expect(names).toEqual(["report.pdf:9"]);
		const status = async (
			file: { filename: string; mimeType: string; size: number },
			convert?: () => Promise<string>,
		) =>
			(await readWorkspaceFileContent(env, "key", file, convert)).text.status;
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(
			await status(pdf(), async () => {
				throw new Error("converter down");
			}),
		).toBe("failed");
		expect(await status(pdf())).toBe("failed");
		expect(
			await status(pdf(), async () => {
				throw new DataResidencyError("EU_PROVIDER_ROUTE_REQUIRED", "blocked");
			}),
		).toBe("not_allowed");
		expect(
			await status(pdf(WORKSPACE_FILE_PDF_MAX_BYTES + 1), async () => ""),
		).toBe("too_large");
		expect(
			await status({ filename: "clip.mp4", mimeType: "video/mp4", size: 9 }),
		).toBe("unsupported");
	});

	it("keeps the text where the workspace reads it and never fails the upload", async () => {
		const puts: Array<[string, string]> = [];
		const file = {
			organizationId: "fictional-org",
			workspaceId: "w1",
			resourceId: "r1",
		};
		await storeWorkspaceFileText(
			{
				R2_BUCKET: {
					put: async (key: string, value: string) => puts.push([key, value]),
				},
			} as unknown as Pick<CloudflareEnv, "R2_BUCKET">,
			file,
			{ status: "text", text: "hello" },
		);
		expect(puts).toEqual([
			[
				"workspace-file-text/v1/fictional-org/w1/r1.json",
				'{"status":"text","text":"hello"}',
			],
		]);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(
			storeWorkspaceFileText(
				{} as unknown as Pick<CloudflareEnv, "R2_BUCKET">,
				file,
				{ status: "failed", text: "" },
			),
		).resolves.toBeUndefined();
	});
});
