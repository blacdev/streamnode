-- What a station shows when nothing better is known: a title and artist of
-- its own, and an uploaded image. They are used while the fallback file
-- plays, when the stream and the metadata URL name nothing, and when the
-- artwork address does not work.

-- Images live in the same library as audio and count toward the same quota.
-- For an image, codec is its type (jpeg, png, webp, gif) and the audio
-- columns are zero.
ALTER TABLE media_files
    ADD COLUMN kind   VARCHAR(8) NOT NULL DEFAULT 'audio' CHECK (kind IN ('audio', 'image')),
    ADD COLUMN width  INT,
    ADD COLUMN height INT;

ALTER TABLE stations
    ADD COLUMN default_title   VARCHAR(200),
    ADD COLUMN default_artist  VARCHAR(200),
    ADD COLUMN artwork_file_id INT REFERENCES media_files(id) ON DELETE SET NULL;
