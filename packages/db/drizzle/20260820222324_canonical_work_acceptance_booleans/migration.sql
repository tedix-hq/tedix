WITH RECURSIVE normalized_contracts(
	work_item_id,
	contract,
	claim_index,
	claim_count
) AS (
	SELECT
		id,
		acceptance_contract,
		0,
		json_array_length(acceptance_contract, '$.claims')
	FROM work_items
	WHERE acceptance_contract IS NOT NULL
		AND json_valid(acceptance_contract)
		AND json_type(acceptance_contract, '$.claims') = 'array'
	UNION ALL
	SELECT
		work_item_id,
		json_set(
			contract,
			'$.claims[' || claim_index || '].requiresIndependentReview',
			json(
				CASE
					WHEN json_type(
						contract,
						'$.claims[' || claim_index || '].requiresIndependentReview'
					) = 'false'
						OR json_extract(
							contract,
							'$.claims[' || claim_index || '].requiresIndependentReview'
						) IN (0, '0', 'false')
					THEN 'false'
					ELSE 'true'
				END
			)
		),
		claim_index + 1,
		claim_count
	FROM normalized_contracts
	WHERE claim_index < claim_count
),
final_contracts AS (
	SELECT work_item_id, contract
	FROM normalized_contracts
	WHERE claim_index = claim_count
)
UPDATE work_items
SET acceptance_contract = (
	SELECT contract
	FROM final_contracts
	WHERE final_contracts.work_item_id = work_items.id
)
WHERE id IN (SELECT work_item_id FROM final_contracts);
