CREATE INDEX idx_learning_event_shared_occurred
ON learning_interaction_events (organization_id, occurred_at)
WHERE scope_kind <> 'personal';

CREATE INDEX idx_learning_event_decision_choice
ON learning_interaction_events (surface, (metadata #>> '{decisionChoice}'), scope_kind, occurred_at);

CREATE INDEX idx_learning_event_filing_owner_occurred
ON learning_interaction_events (organization_id, (metadata #>> '{ledgerOwnerId}'), surface, occurred_at, id);

CREATE INDEX idx_learning_event_corrections
ON learning_interaction_events (organization_id, scope_kind, scope_id, actor_id)
WHERE event_kind = 'undone';

CREATE INDEX idx_learning_event_pending_filing
ON learning_interaction_events (organization_id, issue_key, occurred_at)
WHERE metadata #> '{pending}' = 'true'::jsonb;

CREATE INDEX idx_learning_event_decision_history_personal
ON learning_interaction_events (organization_id, scope_id, occurred_at)
WHERE scope_kind = 'personal'
AND surface IN ('decision_capture', 'agent_session_import', 'activity_feed', 'focus_feed', 'decision_deck', 'decision_deck_action', 'work_outcome', 'outbound_outcome', 'work_fix', 'decision_learning', 'decision_edit_preference', 'card_context')
AND (surface <> 'focus_feed' OR event_kind <> 'delivered');

CREATE INDEX idx_learning_event_decision_history_shared
ON learning_interaction_events (organization_id, occurred_at)
WHERE scope_kind <> 'personal'
AND surface IN ('decision_capture', 'agent_session_import', 'activity_feed', 'focus_feed', 'decision_deck', 'decision_deck_action', 'work_outcome', 'outbound_outcome', 'work_fix', 'decision_learning', 'decision_edit_preference', 'card_context')
AND (surface <> 'focus_feed' OR event_kind <> 'delivered');
