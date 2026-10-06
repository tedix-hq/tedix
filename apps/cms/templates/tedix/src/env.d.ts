/// <reference types="astro/client" />

interface OrgContext {
	slug: string;
	siteTitle: string;
}

declare namespace App {
	interface Locals {
		org: OrgContext;
	}
}
