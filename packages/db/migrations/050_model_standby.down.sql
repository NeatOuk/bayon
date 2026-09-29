-- 050_model_standby down: 049's models table, byte for byte. A standby row stays as a plain inactive
-- adapter row; the boot of the code before 050 retires it if its registration no longer lists it.
ALTER TABLE models DROP COLUMN standby;
