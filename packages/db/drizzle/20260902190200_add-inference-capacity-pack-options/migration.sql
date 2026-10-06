INSERT INTO `billing_inference_capacity_pack_versions` (
	`id`, `pack_key`, `version`, `status`, `name`, `currency`,
	`price_micros`, `token_amount`, `spend_amount_micros`,
	`stripe_environment`, `stripe_price_id`, `stripe_lookup_key`,
	`metadata`, `effective_at`, `created_at`
) VALUES
	('inference-capacity-daily-1m-test-v1', 'daily_1m', 1, 'active', '1M daily boost', 'usd', 5000000, 1000000, 5000000, 'test', NULL, 'tedix_inference_capacity_daily_1m_v1', '{}', '2026-09-02T19:02:00.000Z', '2026-09-02T19:02:00.000Z'),
	('inference-capacity-daily-10m-test-v1', 'daily_10m', 1, 'active', '10M daily boost', 'usd', 50000000, 10000000, 50000000, 'test', NULL, 'tedix_inference_capacity_daily_10m_v1', '{}', '2026-09-02T19:02:00.000Z', '2026-09-02T19:02:00.000Z'),
	('inference-capacity-daily-25m-test-v1', 'daily_25m', 1, 'active', '25M daily boost', 'usd', 125000000, 25000000, 125000000, 'test', NULL, 'tedix_inference_capacity_daily_25m_v1', '{}', '2026-09-02T19:02:00.000Z', '2026-09-02T19:02:00.000Z'),
	('inference-capacity-daily-50m-test-v1', 'daily_50m', 1, 'active', '50M daily boost', 'usd', 250000000, 50000000, 250000000, 'test', NULL, 'tedix_inference_capacity_daily_50m_v1', '{}', '2026-09-02T19:02:00.000Z', '2026-09-02T19:02:00.000Z'),
	('inference-capacity-daily-1m-live-v1', 'daily_1m', 1, 'active', '1M daily boost', 'usd', 5000000, 1000000, 5000000, 'live', NULL, 'tedix_inference_capacity_daily_1m_v1', '{}', '2026-09-02T19:02:00.000Z', '2026-09-02T19:02:00.000Z'),
	('inference-capacity-daily-10m-live-v1', 'daily_10m', 1, 'active', '10M daily boost', 'usd', 50000000, 10000000, 50000000, 'live', NULL, 'tedix_inference_capacity_daily_10m_v1', '{}', '2026-09-02T19:02:00.000Z', '2026-09-02T19:02:00.000Z'),
	('inference-capacity-daily-25m-live-v1', 'daily_25m', 1, 'active', '25M daily boost', 'usd', 125000000, 25000000, 125000000, 'live', NULL, 'tedix_inference_capacity_daily_25m_v1', '{}', '2026-09-02T19:02:00.000Z', '2026-09-02T19:02:00.000Z'),
	('inference-capacity-daily-50m-live-v1', 'daily_50m', 1, 'active', '50M daily boost', 'usd', 250000000, 50000000, 250000000, 'live', NULL, 'tedix_inference_capacity_daily_50m_v1', '{}', '2026-09-02T19:02:00.000Z', '2026-09-02T19:02:00.000Z');
