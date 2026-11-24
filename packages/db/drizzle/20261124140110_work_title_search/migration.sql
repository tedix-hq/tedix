-- Additive title index: preserve work_items and its rowids.
CREATE VIRTUAL TABLE work_item_title_search USING fts5(title, content='', tokenize='trigram case_sensitive 1');
--> statement-breakpoint
CREATE TRIGGER work_item_title_search_insert AFTER INSERT ON work_items
BEGIN
  INSERT INTO work_item_title_search(rowid, title) VALUES (NEW.rowid, lower(NEW.title));
END;
--> statement-breakpoint
CREATE TRIGGER work_item_title_search_delete AFTER DELETE ON work_items
BEGIN
  INSERT INTO work_item_title_search(work_item_title_search, rowid, title) VALUES ('delete', OLD.rowid, lower(OLD.title));
END;
--> statement-breakpoint
CREATE TRIGGER work_item_title_search_update AFTER UPDATE ON work_items
WHEN OLD.title != NEW.title OR OLD.rowid != NEW.rowid
BEGIN
  INSERT INTO work_item_title_search(work_item_title_search, rowid, title) VALUES ('delete', OLD.rowid, lower(OLD.title));
  INSERT INTO work_item_title_search(rowid, title) VALUES (NEW.rowid, lower(NEW.title));
END;
--> statement-breakpoint
INSERT INTO work_item_title_search(rowid, title) SELECT rowid, lower(title) FROM work_items;
