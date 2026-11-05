
-- Migration test only.
-- Target DB: haejumi_migration_test

CREATE TABLE haejumi_dev.migration_probe (
    id INTEGER PRIMARY KEY,
    note TEXT NOT NULL
);
