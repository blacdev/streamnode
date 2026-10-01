-- How listeners reach a streaming server:
--   proxied  through the main gateway's HAProxy (the gateway carries the traffic)
--   direct   the server has its own HAProxy and public address in the domain's
--            DNS records, so its listeners never touch the main gateway
ALTER TABLE engine_nodes
    ADD COLUMN mode VARCHAR(10) NOT NULL DEFAULT 'proxied' CHECK (mode IN ('proxied', 'direct'));
