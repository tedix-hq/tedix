import { describe, expect, it } from "vite-plus/test";
import { guardedFetch, SsrfBlockedError, validateUrl } from "./index";

describe("validateUrl", () => {
	describe("valid public URLs", () => {
		it("allows HTTPS URLs to public hosts", () => {
			expect(validateUrl("https://example.com/path")).toBeNull();
		});

		it("allows HTTP when allowHttp is true", () => {
			expect(validateUrl("http://example.com", { allowHttp: true })).toBeNull();
		});

		it("requires caller-scoped permission for Tedix tunnel hostnames", () => {
			const url = "https://dev-tunnel.tedix.tech/openapi.yaml";
			expect(validateUrl(url)).toBe("Cannot connect to internal services");
			expect(validateUrl(url, { allowInternalHosts: true })).toBeNull();
			expect(validateUrl(url, { allowTedixHosts: true })).toBeNull();
		});
	});

	describe("protocol enforcement", () => {
		it("rejects HTTP by default", () => {
			expect(validateUrl("http://example.com")).toBe("URL must use HTTPS");
		});

		it("rejects file:// protocol", () => {
			expect(validateUrl("file:///etc/passwd")).toBe("URL must use HTTPS");
		});

		it("rejects ftp:// protocol", () => {
			expect(validateUrl("ftp://files.example.com")).toBe("URL must use HTTPS");
		});

		it("rejects invalid URLs", () => {
			expect(validateUrl("not-a-url")).toBe("Invalid URL");
		});
	});

	describe("blocked hosts", () => {
		it("blocks api.tedix.dev", () => {
			expect(validateUrl("https://api.tedix.dev/rpc")).toBe("Blocked host");
		});

		it("blocks mcp.tedix.dev", () => {
			expect(validateUrl("https://mcp.tedix.dev/mcp")).toBe("Blocked host");
		});

		it("blocks localhost", () => {
			expect(validateUrl("https://localhost")).toBe("Blocked host");
		});

		it("blocks staging hosts", () => {
			expect(validateUrl("https://api.tedi.club")).toBe("Blocked host");
		});

		it("blocks dev-tunnel hosts", () => {
			expect(validateUrl("https://api.tedix.tech")).toBe("Blocked host");
			expect(validateUrl("https://mcp.tedix.tech/mcp")).toBe("Blocked host");
		});
	});

	describe("blocked domain suffixes", () => {
		it("blocks *.tedix.dev subdomains", () => {
			expect(validateUrl("https://anything.tedix.dev")).toBe(
				"Cannot connect to internal services",
			);
		});

		it("blocks *.tedi.club subdomains", () => {
			expect(validateUrl("https://app.tedi.club")).toBe(
				"Cannot connect to internal services",
			);
		});

		it("blocks *.tedix.tech dev-tunnel subdomains", () => {
			expect(validateUrl("https://os.tedix.tech")).toBe(
				"Cannot connect to internal services",
			);
		});

		it("blocks .local domains", () => {
			expect(validateUrl("https://myservice.local")).toBe(
				"Cannot connect to internal services",
			);
		});

		it("blocks .internal domains", () => {
			expect(validateUrl("https://service.internal")).toBe(
				"Cannot connect to internal services",
			);
		});
	});

	describe("allowTedixHosts", () => {
		const opts = { allowTedixHosts: true, allowHttp: true };

		it("allows tedix-owned hosts, suffixes and apexes", () => {
			expect(validateUrl("https://api.tedix.dev/rpc", opts)).toBeNull();
			expect(validateUrl("https://mcp.tedix.tech/mcp", opts)).toBeNull();
			expect(validateUrl("https://builder.tedix.dev/mcp", opts)).toBeNull();
			expect(validateUrl("https://acme.cms.tedix.dev/", opts)).toBeNull();
			expect(validateUrl("https://tedix.dev/", opts)).toBeNull();
			expect(validateUrl("https://app.tedi.club/", opts)).toBeNull();
		});

		it("still blocks localhost and local-resolution suffixes", () => {
			expect(validateUrl("http://localhost:8787/", opts)).toBe("Blocked host");
			expect(validateUrl("http://tedix.mcp.localhost:8787/mcp", opts)).toBe(
				"Cannot connect to internal services",
			);
			expect(validateUrl("https://myservice.local", opts)).toBe(
				"Cannot connect to internal services",
			);
			expect(validateUrl("http://metadata.google.internal/", opts)).toBe(
				"Cannot connect to internal services",
			);
			expect(validateUrl("https://internal", opts)).toBe(
				"Cannot connect to internal services",
			);
		});

		it("still blocks every private, loopback and metadata IP literal", () => {
			for (const host of [
				"127.0.0.1",
				"0.0.0.0",
				"[::1]",
				"169.254.169.254",
				"10.0.0.1",
				"172.16.0.1",
				"192.168.1.1",
				"2130706433",
				"0x7f.0.0.1",
				"[fd00::1]",
				"[fe80::1]",
				"[::ffff:127.0.0.1]",
			]) {
				expect(validateUrl(`http://${host}/`, opts)).toBe(
					"Cannot connect to private networks",
				);
			}
		});

		it("is a strict subset of allowInternalHosts", () => {
			expect(
				validateUrl("http://tedix.mcp.localhost:8787/mcp", {
					allowInternalHosts: true,
					allowHttp: true,
				}),
			).toBeNull();
		});
	});

	describe("private IPv4 ranges", () => {
		it("blocks 10.x.x.x", () => {
			expect(validateUrl("https://10.0.0.1")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks 172.16-31.x.x", () => {
			expect(validateUrl("https://172.16.0.1")).toBe(
				"Cannot connect to private networks",
			);
			expect(validateUrl("https://172.31.255.255")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("allows 172.32.x.x (not private)", () => {
			expect(validateUrl("https://172.32.0.1")).toBeNull();
		});

		it("blocks 192.168.x.x", () => {
			expect(validateUrl("https://192.168.1.1")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks 127.x.x.x (loopback)", () => {
			expect(validateUrl("https://127.0.0.1")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks 169.254.x.x (link-local)", () => {
			expect(validateUrl("https://169.254.169.254")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks 100.64-127.x.x (CGNAT)", () => {
			expect(validateUrl("https://100.64.0.1")).toBe(
				"Cannot connect to private networks",
			);
			expect(validateUrl("https://100.127.255.255")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("allows 100.128.x.x (not CGNAT)", () => {
			expect(validateUrl("https://100.128.0.1")).toBeNull();
		});
	});

	describe("numeric IP bypass attempts", () => {
		it("blocks decimal 127.0.0.1 (2130706433)", () => {
			expect(validateUrl("https://2130706433")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks hex 127.0.0.1 (0x7f000001)", () => {
			expect(validateUrl("https://0x7f000001")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks decimal 10.0.0.1 (167772161)", () => {
			expect(validateUrl("https://167772161")).toBe(
				"Cannot connect to private networks",
			);
		});
	});

	describe("octal IP bypass attempts", () => {
		it("blocks octal 127.0.0.1 (0177.0.0.1)", () => {
			expect(validateUrl("https://0177.0.0.1")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks octal 10.0.0.1 (012.0.0.1)", () => {
			expect(validateUrl("https://012.0.0.1")).toBe(
				"Cannot connect to private networks",
			);
		});
	});

	describe("IPv6 private ranges", () => {
		it("blocks ::1 (loopback)", () => {
			expect(validateUrl("https://[::1]")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks :: (unspecified)", () => {
			expect(validateUrl("https://[::]")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks fc00::/7 (unique local)", () => {
			expect(validateUrl("https://[fc00::1]")).toBe(
				"Cannot connect to private networks",
			);
			expect(validateUrl("https://[fd12::1]")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks fe80::/10 (link-local)", () => {
			expect(validateUrl("https://[fe80::1]")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", () => {
			expect(validateUrl("https://[::ffff:127.0.0.1]")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks IPv4-mapped IPv6 private (::ffff:10.0.0.1)", () => {
			expect(validateUrl("https://[::ffff:10.0.0.1]")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks IPv4-mapped IPv6 hex form (::ffff:7f00:1)", () => {
			expect(validateUrl("https://[::ffff:7f00:1]")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks full loopback form (0:0:0:0:0:0:0:1)", () => {
			expect(validateUrl("https://[0:0:0:0:0:0:0:1]")).toBe(
				"Cannot connect to private networks",
			);
		});
	});

	describe("cloud metadata endpoints", () => {
		it("blocks AWS metadata (169.254.169.254)", () => {
			expect(validateUrl("https://169.254.169.254/latest/meta-data/")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks GCP metadata (metadata.google.internal)", () => {
			expect(
				validateUrl("https://metadata.google.internal/computeMetadata/v1/"),
			).toBe("Cannot connect to internal services");
		});
	});
});

describe("validateUrl hardening", () => {
	describe("long-form IPv6 loopback", () => {
		it("blocks zero-padded full loopback ([0:0:0:0:0:0:0:0001])", () => {
			expect(validateUrl("https://[0:0:0:0:0:0:0:0001]")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks partially compressed loopback forms", () => {
			expect(validateUrl("https://[0::1]")).toBe(
				"Cannot connect to private networks",
			);
			expect(validateUrl("https://[::0:1]")).toBe(
				"Cannot connect to private networks",
			);
			expect(validateUrl("https://[0:0::0:1]")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks zero-padded unspecified ([0:0:0:0:0:0:0:0000])", () => {
			expect(validateUrl("https://[0:0:0:0:0:0:0:0000]")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("still allows a public IPv6 address", () => {
			expect(validateUrl("https://[2606:4700:4700::1111]")).toBeNull();
		});
	});

	describe("dotted hex/octal IPv4 forms", () => {
		it("blocks dotted hex loopback (0x7f.0.0.1)", () => {
			expect(validateUrl("https://0x7f.0.0.1")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks mixed hex/decimal private (0xa.0.0.1)", () => {
			expect(validateUrl("https://0xa.0.0.1")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("blocks shorthand loopback (127.1)", () => {
			expect(validateUrl("https://127.1")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("allows a public dotted hex form", () => {
			expect(validateUrl("https://0x8.0x8.0x8.0x8")).toBeNull();
		});
	});

	describe("added reserved IPv4 ranges", () => {
		it("blocks 192.0.2.0/24 (TEST-NET-1)", () => {
			expect(validateUrl("https://192.0.2.1")).toBe(
				"Cannot connect to private networks",
			);
			expect(validateUrl("https://192.0.2.255")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("allows 192.0.3.1 (outside TEST-NET-1)", () => {
			expect(validateUrl("https://192.0.3.1")).toBeNull();
		});

		it("blocks 198.18.0.0/15 (benchmarking)", () => {
			expect(validateUrl("https://198.18.0.1")).toBe(
				"Cannot connect to private networks",
			);
			expect(validateUrl("https://198.19.255.255")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("allows 198.20.0.1 (outside benchmarking range)", () => {
			expect(validateUrl("https://198.20.0.1")).toBeNull();
		});

		it("blocks 224.0.0.0/4 (multicast)", () => {
			expect(validateUrl("https://224.0.0.1")).toBe(
				"Cannot connect to private networks",
			);
			expect(validateUrl("https://239.255.255.255")).toBe(
				"Cannot connect to private networks",
			);
		});

		it("allows 223.1.1.1 (below multicast)", () => {
			expect(validateUrl("https://223.1.1.1")).toBeNull();
		});

		it("blocks IPv4-mapped IPv6 forms of the added ranges", () => {
			expect(validateUrl("https://[::ffff:192.0.2.1]")).toBe(
				"Cannot connect to private networks",
			);
			expect(validateUrl("https://[::ffff:c612:1]")).toBe(
				"Cannot connect to private networks",
			);
		});
	});
});

describe("guardedFetch", () => {
	interface RecordedCall {
		url: string;
		init: RequestInit | undefined;
	}

	function recordingFetch(responder: (url: string, call: number) => Response): {
		calls: RecordedCall[];
		fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
	} {
		const calls: RecordedCall[] = [];
		return {
			calls,
			fetchFn: async (url, init) => {
				calls.push({ url, init });
				return responder(url, calls.length);
			},
		};
	}

	function redirectResponse(location: string, status = 302): Response {
		return new Response(null, { status, headers: { Location: location } });
	}

	function headerValue(
		init: RequestInit | undefined,
		name: string,
	): string | null {
		return new Headers(init?.headers).get(name);
	}

	it("returns a non-redirect response and forces redirect: manual", async () => {
		const { calls, fetchFn } = recordingFetch(
			() => new Response("ok", { status: 200 }),
		);
		const response = await guardedFetch(
			"https://example.com/api",
			{ method: "POST", body: "{}" },
			{ fetchFn },
		);
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.init?.redirect).toBe("manual");
		expect(calls[0]?.init?.method).toBe("POST");
	});

	it("throws SsrfBlockedError without fetching when the URL is blocked", async () => {
		const { calls, fetchFn } = recordingFetch(
			() => new Response("ok", { status: 200 }),
		);
		await expect(
			guardedFetch("https://169.254.169.254/latest", {}, { fetchFn }),
		).rejects.toThrow(SsrfBlockedError);
		expect(calls).toHaveLength(0);
	});

	it("re-validates every redirect hop and blocks private targets", async () => {
		const { calls, fetchFn } = recordingFetch((url) =>
			url === "https://example.com/start"
				? redirectResponse("https://192.168.1.1/internal")
				: new Response("ok", { status: 200 }),
		);
		await expect(
			guardedFetch("https://example.com/start", {}, { fetchFn }),
		).rejects.toThrow(SsrfBlockedError);
		expect(calls).toHaveLength(1);
	});

	it("blocks an http downgrade redirect by default", async () => {
		const { fetchFn } = recordingFetch(() =>
			redirectResponse("http://example.com/insecure"),
		);
		await expect(
			guardedFetch("https://example.com/start", {}, { fetchFn }),
		).rejects.toThrow("URL must use HTTPS");
	});

	it("follows a same-origin redirect and keeps credentials", async () => {
		const { calls, fetchFn } = recordingFetch((url) =>
			url === "https://example.com/a"
				? redirectResponse("https://example.com/b")
				: new Response("done", { status: 200 }),
		);
		const response = await guardedFetch(
			"https://example.com/a",
			{ headers: { Authorization: "Bearer secret", Accept: "text/plain" } },
			{ fetchFn },
		);
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.url).toBe("https://example.com/b");
		expect(headerValue(calls[1]?.init, "Authorization")).toBe("Bearer secret");
	});

	it("strips Authorization and Cookie on a cross-origin redirect", async () => {
		const { calls, fetchFn } = recordingFetch((url) =>
			url === "https://example.com/a"
				? redirectResponse("https://other.example.net/b")
				: new Response("done", { status: 200 }),
		);
		const response = await guardedFetch(
			"https://example.com/a",
			{
				headers: {
					Authorization: "Bearer secret",
					Cookie: "session=1",
					Accept: "text/plain",
				},
			},
			{ fetchFn },
		);
		expect(response.status).toBe(200);
		expect(headerValue(calls[1]?.init, "Authorization")).toBeNull();
		expect(headerValue(calls[1]?.init, "Cookie")).toBeNull();
		expect(headerValue(calls[1]?.init, "Accept")).toBe("text/plain");
	});

	it("resolves a relative Location against the current URL", async () => {
		const { calls, fetchFn } = recordingFetch((url) =>
			url === "https://example.com/a/start"
				? redirectResponse("../next")
				: new Response("done", { status: 200 }),
		);
		await guardedFetch("https://example.com/a/start", {}, { fetchFn });
		expect(calls[1]?.url).toBe("https://example.com/next");
	});

	it("switches POST to GET and drops the body on a 303", async () => {
		const { calls, fetchFn } = recordingFetch((url) =>
			url === "https://example.com/form"
				? redirectResponse("https://example.com/result", 303)
				: new Response("done", { status: 200 }),
		);
		await guardedFetch(
			"https://example.com/form",
			{ method: "POST", body: "payload" },
			{ fetchFn },
		);
		expect(calls[1]?.init?.method).toBe("GET");
		expect(calls[1]?.init?.body).toBeUndefined();
	});

	it("enforces the redirect cap (default 3)", async () => {
		const { calls, fetchFn } = recordingFetch((url) => {
			const hop = Number(new URL(url).pathname.slice(1) || 0);
			return redirectResponse(`https://example.com/${hop + 1}`);
		});
		await expect(
			guardedFetch("https://example.com/0", {}, { fetchFn }),
		).rejects.toThrow("Redirect limit exceeded (3)");
		expect(calls).toHaveLength(4); // initial + 3 followed hops
	});

	it("honors a custom maxRedirects", async () => {
		const { calls, fetchFn } = recordingFetch(() =>
			redirectResponse("https://example.com/loop"),
		);
		await expect(
			guardedFetch(
				"https://example.com/start",
				{},
				{ fetchFn, maxRedirects: 0 },
			),
		).rejects.toThrow("Redirect limit exceeded (0)");
		expect(calls).toHaveLength(1);
	});

	it("returns a redirect-status response without a Location as-is", async () => {
		const { fetchFn } = recordingFetch(
			() => new Response(null, { status: 304 }),
		);
		const response = await guardedFetch(
			"https://example.com/cached",
			{},
			{ fetchFn },
		);
		expect(response.status).toBe(304);
	});

	it("passes validate options through (allowInternalHosts + allowHttp)", async () => {
		const { calls, fetchFn } = recordingFetch(
			() => new Response("ok", { status: 200 }),
		);
		const response = await guardedFetch(
			"http://tedix.mcp.localhost:8787/mcp",
			{},
			{ fetchFn, allowHttp: true, allowInternalHosts: true },
		);
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
	});
});
