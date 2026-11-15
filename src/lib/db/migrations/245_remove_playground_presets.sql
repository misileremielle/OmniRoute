-- The Playground studio was removed, and nothing reads saved presets any more.
-- Drop the table from migration 084 (its indexes go with it).
DROP TABLE IF EXISTS playground_presets;
