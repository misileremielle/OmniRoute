-- The Batch API (files + batches routes, dashboard page, CLI commands,
-- batch processor) was removed, and nothing reads these tables any more.
-- Drop the tables from migrations 028 (files, batches) and 112
-- (batch_item_checkpoints), child tables first. Their indexes go with them.
DROP TABLE IF EXISTS batch_item_checkpoints;
DROP TABLE IF EXISTS batches;
DROP TABLE IF EXISTS files;
