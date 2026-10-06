import { validateUrl } from "@tedix/ssrf-guard";
import type { SourceProvider } from "./types";

const SAFE_SEGMENT = /^[a-zA-Z0-9._/-]+$/;
const SAFE_BRANCH = /^[a-zA-Z0-9._/-]{1,200}$/;
const EXCLUDED_DOCS_BASENAMES = ["SKILL.md"] as const;

export function assertSlug(value: string): string {
	const slug = value.trim().toLowerCase();
	if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
		throw new Error(
			"Site slug must be a DNS label using lowercase letters, numbers, and hyphens",
		);
	}
	return slug;
}

export function assertBranch(value: string): string {
	const branch = value.trim();
	if (
		!SAFE_BRANCH.test(branch) ||
		branch.startsWith("/") ||
		branch.endsWith("/") ||
		branch.includes("..") ||
		branch.includes("@{")
	) {
		throw new Error("Invalid Git branch");
	}
	return branch;
}

export function assertContentRoot(value: string): string {
	const root =
		value
			.trim()
			.replace(/^\.\/+/, "")
			.replace(/\/+$/, "") || ".";
	if (
		root.startsWith("/") ||
		root.includes("..") ||
		(root !== "." && !SAFE_SEGMENT.test(root))
	) {
		throw new Error("Content root must be a safe repository-relative path");
	}
	return root;
}

export function assertRepositoryUrl(
	provider: Exclude<SourceProvider, "artifacts">,
	value: string,
): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Repository URL must be a valid HTTPS Git URL");
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new Error("Repository URL must use HTTPS and contain no credentials");
	}
	// Shared guard (https already enforced above): private/loopback/link-local
	// IPs in every textual form, localhost, *.local/*.internal, and Tedix-owned
	// hosts — a docs source is a customer-chosen repo and never a Tedix service.
	if (validateUrl(url.toString())) {
		throw new Error("Repository URL must use a public hostname");
	}
	if (provider === "github" && url.hostname !== "github.com") {
		throw new Error("GitHub sources must use github.com");
	}
	if (provider === "gitlab" && url.hostname !== "gitlab.com") {
		throw new Error("GitLab sources must use gitlab.com");
	}
	url.hash = "";
	return url.toString();
}

export function assertArtifactsRepository(value: string): string {
	const name = value.trim();
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(name)) {
		throw new Error("Invalid Cloudflare Artifacts repository name");
	}
	return name;
}

export function assertArtifactsRepositoryUrl(
	value: string,
	repository: string,
): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		!/^[a-f0-9]{32}\.artifacts\.cloudflare\.net$/.test(url.hostname) ||
		!new RegExp(
			`^/git/[a-zA-Z0-9._-]+/${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.git$`,
		).test(url.pathname)
	) {
		throw new Error(
			"Artifacts repository URL must match the selected Cloudflare Artifacts repository",
		);
	}
	url.hash = "";
	url.search = "";
	return url.toString();
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export function docsContentFindExclusions(): string {
	return EXCLUDED_DOCS_BASENAMES.map(
		(name) => `! -name ${shellQuote(name)}`,
	).join(" ");
}

export function gitProviderAuthorization(
	provider: SourceProvider,
	authorization: string,
): string {
	const match = /^Bearer ([^\r\n]+)$/.exec(authorization);
	if (!match) return authorization;
	const username =
		provider === "github"
			? "x-access-token"
			: provider === "gitlab"
				? "oauth2"
				: null;
	return username ? `Basic ${btoa(`${username}:${match[1]}`)}` : authorization;
}
