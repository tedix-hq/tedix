-- Match the old default name and the serving built-in app, never a user's title.
-- A workspace may already have the new name; preserve both apps in that case.
UPDATE os_gadgets
SET name = CASE name WHEN 'Feed' THEN 'Activity' WHEN 'Deck' THEN 'Decisions' END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE name IN ('Feed', 'Deck')
  AND EXISTS (
    SELECT 1 FROM os_gadget_revisions AS revision
    WHERE revision.id = os_gadgets.current_revision_id
      AND revision.gadget_id = os_gadgets.id
      AND revision.organization_id = os_gadgets.organization_id
      AND (
        (os_gadgets.name = 'Feed'
          AND json_extract(revision.manifest, '$.entry') = 'tedix:app/activity-feed'
          AND json_extract(revision.manifest, '$.navigation.work') = 'feed')
        OR (os_gadgets.name = 'Deck'
          AND json_extract(revision.manifest, '$.entry') = 'tedix:app/decision-deck'
          AND json_extract(revision.manifest, '$.navigation.work') = 'deck')
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM os_gadgets AS occupied
    WHERE occupied.workspace_id = os_gadgets.workspace_id
      AND occupied.name = CASE os_gadgets.name
        WHEN 'Feed' THEN 'Activity' WHEN 'Deck' THEN 'Decisions' END
  );
