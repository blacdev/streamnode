-- Idents and fallback audio given by address by a system that keeps the
-- station's files itself. The downloaded file is in media_files as usual and
-- is the station's ident_file_id / fallback_file_id; these say where it came
-- from and what it must be, so that the same address is not fetched twice.
ALTER TABLE stations ADD COLUMN ident_url TEXT;
ALTER TABLE stations ADD COLUMN ident_sha256 TEXT;
ALTER TABLE stations ADD COLUMN fallback_url TEXT;
ALTER TABLE stations ADD COLUMN fallback_sha256 TEXT;
