-- Each piece's number, the one its film's folder starts with (017-big-cookie): one more than the highest when it's
-- created. Pieces from before numbers get theirs from `node scripts/publisher/cli.mjs number-pieces`; until then they
-- have none, and the code deployed before numbers goes on writing pieces without one.
ALTER TABLE publisher_content ADD COLUMN number INTEGER CHECK (number > 0);
CREATE UNIQUE INDEX publisher_content_number ON publisher_content(number);
-- History finds each post's piece, and so its number, by the post.
CREATE INDEX publisher_content_job ON publisher_content(job_id);
