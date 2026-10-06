/// <reference path="../.astro/types.d.ts" />

interface Env {
	ENVIRONMENT: string;
	API_URL: string;
	MCP_URL: string;
	MCP_UI_URL: string;
	PUBLIC_API_URL?: string;
}

declare module "cloudflare:workers" {
	interface CloudflareEnv extends Env {}
}

declare namespace App {
	interface Locals {
		cfContext: ExecutionContext;
	}
}

interface ImportMetaEnv {
	readonly API_URL?: string;
	readonly PUBLIC_API_URL?: string;
}

/// <reference types="astro/client" />
