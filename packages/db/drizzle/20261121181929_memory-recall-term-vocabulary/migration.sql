-- Per-term document counts over the recall index. Long recall queries keep
-- their least common terms, so one common word no longer makes the search
-- score most of the index. fts5vocab reads the index; it stores nothing.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fact_fts_recall_vocab USING fts5vocab(memory_fact_fts_recall, row);
