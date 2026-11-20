-- Keep already-canonical owners unchanged, including ids that collide with a provider subject.
UPDATE tedis
SET owner_user_id = (
    SELECT m.user_id
    FROM organization_members AS m
    WHERE m.organization_id = tedis.organization_id
      AND m.descope_user_id = tedis.owner_user_id
      AND m.user_id IS NOT NULL
)
WHERE owner_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM organization_members AS canonical
    WHERE canonical.organization_id = tedis.organization_id
      AND canonical.user_id = tedis.owner_user_id
  )
  AND EXISTS (
    SELECT 1 FROM organization_members AS m
    WHERE m.organization_id = tedis.organization_id
      AND m.descope_user_id = tedis.owner_user_id
      AND m.user_id IS NOT NULL
  );
