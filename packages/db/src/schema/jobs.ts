/**
 * Jobs Schema
 * Background job tracking for async operations like item extraction
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { apps } from "./apps";

/**
 * Job status enum
 */
export type JobStatus = "pending" | "running" | "completed" | "failed";

/**
 * Job type enum
 */
export type JobType =
	| "discover_items"
	| "scrape"
	| "ai_sync"
	| "blog_generation"
	| "mcp_eval";

/**
 * Jobs table for tracking async background tasks
 */
export const jobs = sqliteTable("jobs", {
	id: text("id").primaryKey(),

	/** Type of job (discover_items, scrape, ai_sync) */
	type: text("type", {
		enum: [
			"discover_items",
			"scrape",
			"ai_sync",
			"blog_generation",
			"mcp_eval",
		],
	}).notNull(),

	/** Job status */
	status: text("status", {
		enum: ["pending", "running", "completed", "failed"],
	})
		.notNull()
		.default("pending"),

	/** Associated app ID */
	appId: text("app_id")
		.notNull()
		.references(() => apps.id, { onDelete: "cascade" }),

	/** Input payload (JSON) */
	payload: text("payload", { mode: "json" }).$type<Record<string, JsonValue>>(),

	/** Result data (JSON) - populated on completion */
	result: text("result", { mode: "json" }).$type<Record<string, JsonValue>>(),

	/** Error message if failed */
	error: text("error"),

	/** Progress information (JSON) */
	progress: text("progress", { mode: "json" }).$type<
		Record<string, JsonValue>
	>(),

	/** Timestamps */
	createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
	startedAt: text("started_at"),
	completedAt: text("completed_at"),
	updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
});

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

/**
 * Job payload for discover_items job type
 */
export interface DiscoverItemsJobPayload {
	seedUrls?: string[];
	urlLimit?: number;
	itemsPerPage?: number;
	maxListingPages?: number;
	proxy?: "basic" | "stealth" | "auto";
	urlSearchFilter?: string;
	vertical?: string;
}

/**
 * Job result for discover_items job type
 */
export interface DiscoverItemsJobResult {
	config?: {
		vertical: string;
		confidence: number;
	};
	stats: {
		duration: string;
		urlsMapped: number;
		listingPages: number;
		productPages: number;
		pagesScraped: number;
		itemsExtracted: number;
		itemsInserted: number;
		itemsUpdated: number;
		errors: number;
	};
}

/**
 * Job progress for discover_items job type
 */
export interface DiscoverItemsJobProgress {
	step: "mapping" | "analyzing" | "extracting" | "saving";
	urlsMapped?: number;
	pagesScraped?: number;
	itemsExtracted?: number;
	message?: string;
}

/**
 * Job payload for blog_generation job type
 */
export interface BlogGenerationJobPayload {
	keyword: string;
	wordCount?: number;
	contentGenerationInstruction?: string;
	language?: string;
	market?: string;
	voicePersona?: {
		icpProfile?: string;
		voiceStyle?: string;
		doList?: string[];
		dontList?: string[];
		examplePhrases?: string[];
	};
	companyData?: {
		companyName?: string;
		companyUrl?: string;
		logoUrl?: string;
		authorName?: string;
		industry?: string;
		description?: string;
		products?: string;
		targetAudience?: string;
		tone?: string;
		painPoints?: string;
		valuePropositions?: string;
		useCases?: string;
	};
	competitors?: string[];
	categoryId?: string;
	tags?: string[];
}

/**
 * Job result for blog_generation job type
 */
export interface BlogGenerationJobResult {
	postId?: string;
	slug?: string;
	aeoScore?: number;
	readingTime?: number;
	qualityGrade?: {
		grade: "A" | "B" | "C" | "D" | "F";
		label: string;
		color: "green" | "blue" | "yellow" | "orange" | "red";
	};
	similarityScore?: number;
}

/**
 * Job progress for blog_generation job type
 */
export interface BlogGenerationJobProgress {
	stage: string;
	message: string;
	progress: number;
	workflowInstanceId?: string;
}

/**
 * Job payload for mcp_eval job type
 */
export interface McpEvalJobPayload {
	appSlug: string;
	model?: string;
	customTests?: Array<{
		title: string;
		prompt: string;
		expectedTools: string[];
	}>;
}

/**
 * Job result for mcp_eval job type
 */
export interface McpEvalJobResult {
	appSlug: string;
	model: string;
	totalTests: number;
	passed: number;
	failed: number;
	score: number;
	durationMs: number;
	tests: Array<{
		title: string;
		prompt: string;
		expectedTools: string[];
		calledTools: string[];
		passed: boolean;
		durationMs: number;
		error?: string;
	}>;
}

/**
 * Job progress for mcp_eval job type
 */
export interface McpEvalJobProgress {
	stage: string;
	message: string;
	progress: number;
	testsCompleted?: number;
	totalTests?: number;
}
