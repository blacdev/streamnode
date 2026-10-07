-- Whether a station's backup stream carries the same programme as its
-- primary. If it does, the title address describes the backup too; if it does
-- not, the backup's titles are the ones in its own stream.
ALTER TABLE stations ADD COLUMN backup_titles_from_primary BOOLEAN NOT NULL DEFAULT false;

-- Until now the title address was used whichever stream was playing, so
-- stations that have both keep that behaviour.
UPDATE stations SET backup_titles_from_primary = true WHERE metadata_url IS NOT NULL AND backup_url IS NOT NULL;
