-- migration-custom-depreciation.sql
-- Adds custom_schedule JSON column to fixed_assets for custom depreciation scheduling

ALTER TABLE fixed_assets ADD COLUMN custom_schedule TEXT;
-- JSON format:
-- {
--   "period_type": "monthly" | "yearly",
--   "lines": [
--     { "period": 1, "rate": 20.0, "amount": null },
--     { "period": 2, "rate": 15.0, "amount": null },
--     { "period": 3, "rate": null, "amount": 5000.0 }
--   ]
-- }
