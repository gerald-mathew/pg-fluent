-- Example: trigger to notify schema changes
CREATE OR REPLACE FUNCTION pgfluent_notify_schema() RETURNS event_trigger AS $$
BEGIN
  PERFORM pg_notify('pgfluent_schema', 'refresh');
END;
$$ LANGUAGE plpgsql;

CREATE EVENT TRIGGER pgfluent_schema_refresh ON ddl_command_end
  EXECUTE FUNCTION pgfluent_notify_schema();
