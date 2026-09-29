-- Reverts 009_conformance to 008's schema: both tables go. The runners roll-up columns keep what
-- they hold; the values 009 cleared are not restored.
DROP TABLE conformance_probes;
DROP TABLE runner_certifications;
