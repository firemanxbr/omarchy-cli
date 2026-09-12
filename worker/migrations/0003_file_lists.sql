-- File lists are stored gzip-compressed, one blob per package, instead of
-- inside manifest_json: a single package (linux-docs) exceeds D1's 1 MB
-- value limit uncompressed, and every other query is lighter without them.
CREATE TABLE package_file_lists (
    package_id INTEGER PRIMARY KEY REFERENCES packages (id) ON DELETE CASCADE,
    count      INTEGER NOT NULL,
    gz         BLOB    NOT NULL
);
