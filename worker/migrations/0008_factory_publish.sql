-- A build task can be a dry run: built, measured, reported — never signed,
-- published or rendered. Used to size a package before committing to it.
ALTER TABLE build_tasks ADD COLUMN publish INTEGER NOT NULL DEFAULT 1;
