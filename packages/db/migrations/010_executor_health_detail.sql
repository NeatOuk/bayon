-- 010_executor_health_detail (M3): what an executor's last health check measured, as
-- JSON (§6.1, §13.2): for a container executor the ssh round trip, clock skew, disk against its
-- quota, the image, the tunnel and /mcp through the gateway, and the failures. The supervisor
-- writes it with `health`; a certification report reads the round trip from it.
ALTER TABLE executors ADD COLUMN health_detail TEXT;
