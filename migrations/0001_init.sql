-- QRx dataverse deltas. One row per written file; the baseline dataverse
-- ships as static assets and never touches this table.
CREATE TABLE IF NOT EXISTS files (
  ns TEXT NOT NULL,
  k TEXT NOT NULL,
  v TEXT NOT NULL,
  PRIMARY KEY (ns, k)
);
