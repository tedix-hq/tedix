import { validateUrl } from "@tedix/ssrf-guard";

type FetchLike = typeof fetch;
type Status = "pass" | "fail" | "neutral";
type Category = "discoverability" | "content" | "bot_access" | "capabilities";

interface FetchEvidence {
	request: { method: string; url: string; headers: Record<string, string> };
	response: {
		url: string;
		status: number;
		headers: Record<string, string>;
		bodySnippet: string;
	};
}

export interface ReadinessCheck {
	key: string;
	category: Category;
	status: Status;
	detail: string;
	evidence: FetchEvidence;
}

const RESPONSE_HEADERS = [
	"content-type",
	"link",
	"location",
	"www-authenticate",
];

function selectedHeaders(headers: Headers): Record<string, string> {
	return Object.fromEntries(
		RESPONSE_HEADERS.flatMap((name) => {
			const value = headers.get(name);
			return value ? [[name, value]] : [];
		}),
	);
}

async function boundedBody(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let body = "";
	try {
		while (body.length < 1_000) {
			const chunk = await reader.read();
			if (chunk.done) break;
			body += decoder.decode(chunk.value, { stream: true });
		}
		return body.slice(0, 1_000);
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

async function evidenceFetch(
	rawUrl: string,
	headers: Record<string, string>,
	fetchImpl: FetchLike,
): Promise<FetchEvidence> {
	let url = rawUrl;
	for (let redirects = 0; redirects <= 3; redirects += 1) {
		const unsafe = validateUrl(url);
		if (unsafe) throw new Error(unsafe);
		const response = await fetchImpl(url, {
			method: "GET",
			headers,
			redirect: "manual",
			signal: AbortSignal.timeout(5_000),
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (location && redirects < 3) {
				url = new URL(location, url).toString();
				continue;
			}
		}
		const body = await boundedBody(response);
		return {
			request: { method: "GET", url, headers },
			response: {
				url,
				status: response.status,
				headers: selectedHeaders(response.headers),
				bodySnippet: body,
			},
		};
	}
	throw new Error("Too many redirects");
}

async function safeEvidenceFetch(
	rawUrl: string,
	headers: Record<string, string>,
	fetchImpl: FetchLike,
): Promise<FetchEvidence> {
	try {
		return await evidenceFetch(rawUrl, headers, fetchImpl);
	} catch (error) {
		return {
			request: { method: "GET", url: rawUrl, headers },
			response: {
				url: rawUrl,
				status: 0,
				headers: {},
				bodySnippet: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

function check(
	key: string,
	category: Category,
	status: Status,
	detail: string,
	evidence: FetchEvidence,
): ReadinessCheck {
	return { key, category, status, detail, evidence };
}

function reachableStatus(evidence: FetchEvidence, passed: boolean): Status {
	return evidence.response.status === 0 ? "neutral" : passed ? "pass" : "fail";
}

export async function scanAgentReadiness(
	rawUrl: string,
	profile: "all" | "content",
	fetchImpl: FetchLike = fetch,
) {
	const input = new URL(rawUrl);
	input.hash = "";
	const unsafeInput = validateUrl(input.toString());
	if (unsafeInput) throw new Error(unsafeInput);
	const origin = input.origin;
	const [home, robots] = await Promise.all([
		safeEvidenceFetch(input.toString(), { Accept: "text/markdown" }, fetchImpl),
		safeEvidenceFetch(
			`${origin}/robots.txt`,
			{ Accept: "text/plain" },
			fetchImpl,
		),
	]);
	const robotsText = robots.response.bodySnippet;
	const sitemapUrl =
		robotsText.match(/^sitemap:\s*(\S+)/im)?.[1] ?? `${origin}/sitemap.xml`;
	const sitemap = await safeEvidenceFetch(
		sitemapUrl,
		{ Accept: "application/xml,text/xml" },
		fetchImpl,
	);

	const checks: ReadinessCheck[] = [
		check(
			"robotsTxt",
			"discoverability",
			reachableStatus(robots, robots.response.status === 200),
			robots.response.status === 200
				? "robots.txt is reachable"
				: "robots.txt is not reachable",
			robots,
		),
		check(
			"sitemap",
			"discoverability",
			reachableStatus(sitemap, sitemap.response.status === 200),
			sitemap.response.status === 200
				? "A sitemap advertised by robots.txt is reachable"
				: "No reachable sitemap was found",
			sitemap,
		),
		check(
			"linkHeaders",
			"discoverability",
			reachableStatus(home, Boolean(home.response.headers.link)),
			home.response.headers.link
				? "Homepage publishes Link discovery headers"
				: "Homepage publishes no Link discovery headers",
			home,
		),
		check(
			"markdownNegotiation",
			"content",
			reachableStatus(
				home,
				Boolean(
					home.response.headers["content-type"]
						?.toLowerCase()
						.includes("text/markdown"),
				),
			),
			home.response.headers["content-type"]
				?.toLowerCase()
				.includes("text/markdown")
				? "Accept: text/markdown returned Markdown"
				: "Accept: text/markdown did not return Markdown",
			home,
		),
		check(
			"robotsTxtAiRules",
			"bot_access",
			reachableStatus(
				robots,
				/user-agent:\s*(gptbot|chatgpt-user|claudebot|perplexitybot|google-extended)/i.test(
					robotsText,
				),
			),
			/user-agent:\s*(gptbot|chatgpt-user|claudebot|perplexitybot|google-extended)/i.test(
				robotsText,
			)
				? "robots.txt contains explicit AI crawler rules"
				: "robots.txt contains no explicit AI crawler rules",
			robots,
		),
		check(
			"contentSignals",
			"bot_access",
			reachableStatus(robots, /content-signal:/i.test(robotsText)),
			/content-signal:/i.test(robotsText)
				? "robots.txt declares Content Signals"
				: "robots.txt does not declare Content Signals",
			robots,
		),
	];

	const capabilityPaths = [
		["apiCatalog", "/.well-known/api-catalog"],
		["oauthProtectedResource", "/.well-known/oauth-protected-resource"],
		["mcpServerCard", "/.well-known/mcp/server-card.json"],
		["a2aAgentCard", "/.well-known/agent-card.json"],
		["agentSkills", "/.well-known/agent-skills/index.json"],
		["authMd", "/auth.md"],
	] as const;
	checks.push(
		...(await Promise.all(
			capabilityPaths.map(async ([key, path]) => {
				const evidence = await safeEvidenceFetch(
					`${origin}${path}`,
					{ Accept: "application/json,text/markdown" },
					fetchImpl,
				);
				const present =
					evidence.response.status >= 200 && evidence.response.status < 300;
				return check(
					key,
					"capabilities",
					profile === "content"
						? "neutral"
						: reachableStatus(evidence, present),
					profile === "content"
						? "Not scored for the content profile"
						: present
							? `${path} is reachable`
							: `${path} is not reachable`,
					evidence,
				);
			}),
		)),
	);

	const summary = {
		pass: checks.filter((item) => item.status === "pass").length,
		fail: checks.filter((item) => item.status === "fail").length,
		neutral: checks.filter((item) => item.status === "neutral").length,
	};
	const applicable = summary.pass + summary.fail;
	return {
		hostname: input.hostname,
		url: input.toString(),
		profile,
		level: applicable === 0 ? 0 : Math.round((summary.pass / applicable) * 5),
		summary,
		checks,
		scannedAt: new Date().toISOString(),
	};
}
