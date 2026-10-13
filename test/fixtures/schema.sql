DROP TABLE IF EXISTS pf_places, pf_todo_tags, pf_tags, pf_posts, pf_users, pf_todos CASCADE;
DROP FUNCTION IF EXISTS pf_add(int, int);
DROP FUNCTION IF EXISTS pf_get_todos(bigint);
DROP FUNCTION IF EXISTS pf_upper(text);
DROP FUNCTION IF EXISTS pf_echo_json(json);
DROP FUNCTION IF EXISTS pf_echo_jsonb(jsonb);
DROP FUNCTION IF EXISTS pf_tag_json(text, jsonb);
DROP FUNCTION IF EXISTS pf_numbers();
DROP FUNCTION IF EXISTS pf_sleep(int);

CREATE TABLE pf_todos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  priority int,
  tags text[],
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pf_users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE pf_posts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES pf_users (id),
  title text NOT NULL
);

CREATE TABLE pf_tags (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tag text NOT NULL
);

CREATE TABLE pf_todo_tags (
  todo_id bigint NOT NULL REFERENCES pf_todos (id),
  tag_id bigint NOT NULL REFERENCES pf_tags (id),
  PRIMARY KEY (todo_id, tag_id)
);

INSERT INTO pf_todos (task, done, priority, tags, meta) VALUES
  ('write spec', true, 1, '{docs,urgent}', '{"author":"gerald"}'),
  ('build parser', false, 2, '{code}', '{"author":"gerald","wip":true}'),
  ('ship v1', false, 3, NULL, NULL);

CREATE TABLE pf_places (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  geometry jsonb
);

INSERT INTO pf_places (name, geometry) VALUES
  ('origin', '{"type":"Point","coordinates":[0,0]}'),
  ('target', '{"type":"Point","coordinates":[1.5,2.5]}');

INSERT INTO pf_users (name) VALUES ('gerald'), ('alice');
INSERT INTO pf_posts (user_id, title) VALUES (1, 'first post'), (1, 'second post'), (2, 'hello');

INSERT INTO pf_tags (tag) VALUES ('urgent'), ('work');
INSERT INTO pf_todo_tags (todo_id, tag_id) VALUES (1, 1), (1, 2), (2, 2);

CREATE FUNCTION pf_add(a int, b int) RETURNS int LANGUAGE sql AS $$ SELECT a + b $$;
CREATE FUNCTION pf_get_todos(min_id bigint) RETURNS SETOF pf_todos LANGUAGE sql AS $$
  SELECT * FROM pf_todos WHERE id >= min_id
$$;

CREATE FUNCTION pf_upper(txt text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT upper(txt) $$;

CREATE FUNCTION pf_echo_json(payload json) RETURNS json LANGUAGE sql IMMUTABLE AS $$ SELECT payload $$;

CREATE FUNCTION pf_echo_jsonb(payload jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT payload $$;

CREATE FUNCTION pf_tag_json(label text, payload jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('label', label, 'payload', payload)
$$;

CREATE FUNCTION pf_numbers() RETURNS SETOF int LANGUAGE sql IMMUTABLE AS $$ SELECT generate_series(1, 3) $$;

CREATE FUNCTION pf_sleep(ms int) RETURNS int LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_sleep(ms::float / 1000);
  RETURN 1;
END $$;

DROP VIEW IF EXISTS pf_event_summary;
DROP TABLE IF EXISTS pf_audit, pf_events CASCADE;
DROP DOMAIN IF EXISTS pf_email CASCADE;
DROP TYPE IF EXISTS pf_mood CASCADE;
DROP TYPE IF EXISTS pf_point CASCADE;
DROP FUNCTION IF EXISTS pf_events_of(pf_mood);

CREATE TYPE pf_mood AS ENUM ('low', 'medium', 'high');
CREATE TYPE pf_point AS (x int, y int);
CREATE DOMAIN pf_email AS text CHECK (VALUE LIKE '%@%');

CREATE TABLE pf_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mood pf_mood NOT NULL,
  contact pf_email,
  scores int[],
  pos pf_point,
  note text DEFAULT 'n/a',
  note_len int GENERATED ALWAYS AS (length(note)) STORED
);

CREATE TABLE pf_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id bigint NOT NULL UNIQUE REFERENCES pf_events (id),
  message text
);

CREATE VIEW pf_event_summary AS
  SELECT id, mood, note FROM pf_events;

CREATE FUNCTION pf_events_of(m pf_mood) RETURNS SETOF pf_events LANGUAGE sql AS $$
  SELECT * FROM pf_events WHERE mood = m
$$;

