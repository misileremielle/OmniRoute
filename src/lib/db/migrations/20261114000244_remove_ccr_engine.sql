-- The CCR (content-compression-retrieve) engine was removed: its markers could only
-- be resolved through the MCP tool `omniroute_ccr_retrieve`, and the MCP server is
-- gone. Drop its durable block store (migration 139) and its detail settings row.
-- Stored pipelines that still list a `ccr` step are dropped by the readers, which
-- skip unknown engine ids.
DROP TABLE IF EXISTS ccr_blocks;
DELETE FROM key_value WHERE namespace = 'compression' AND key = 'ccr';
