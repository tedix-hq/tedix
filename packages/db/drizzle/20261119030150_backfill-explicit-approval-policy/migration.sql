-- Preserve the existing absent-key posture as an explicit boolean.
-- Unsupported definitions stay untouched for owner review; they must not
-- prevent release or acquire a guessed authorization policy.
UPDATE policy_packs
SET definition = json_set(
    definition,
    '$.governancePolicy',
    json_set(
        CASE WHEN json_type(definition, '$.governancePolicy') = 'object'
            THEN json_extract(definition, '$.governancePolicy')
            ELSE '{}' END,
        '$.requireExplicitThirdPartyApprovalPolicy',
        json('false')
    )
)
WHERE CASE
    WHEN NOT json_valid(definition) THEN 0
    WHEN json_type(definition) IS NOT 'object' THEN 0
    WHEN json_type(definition, '$.governancePolicy') IS NULL
        OR json_type(definition, '$.governancePolicy') IN ('null', 'object')
    THEN json_type(definition, '$.governancePolicy.requireExplicitThirdPartyApprovalPolicy') IS NULL
    ELSE 0
END;
