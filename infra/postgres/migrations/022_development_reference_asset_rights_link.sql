BEGIN;

-- A reference image may be moderated for content and still lack the separate
-- right to be used as a character likeness.  The link is nullable for legacy
-- and non-reference media; application code requires it for new generation.
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS rights_review_id uuid REFERENCES content_rights_reviews(review_id);
CREATE INDEX IF NOT EXISTS media_assets_rights_review_idx ON media_assets (rights_review_id) WHERE rights_review_id IS NOT NULL;

INSERT INTO schema_migrations (migration_id) VALUES ('022_development_reference_asset_rights_link.sql');
COMMIT;
