-- IRIS messages attached to live stops: delay causes (type d, numeric code), quality notes (q),
-- HIM announcements (h) and disruptions (r). The dataset history has none, so this is collected
-- going forward, for display now and as model features once enough weeks have accumulated.
CREATE TABLE stop_messages (
  service_date date NOT NULL,
  trip_id      bigint NOT NULL,
  eva          text NOT NULL,
  msg_id       text NOT NULL,
  event        char(1) CHECK (event IN ('a', 'd')),  -- NULL: attached to the stop as a whole
  type         char(1) NOT NULL,
  code         smallint,
  category     text,
  valid_from   timestamptz,
  valid_to     timestamptz,
  ts           timestamptz,                           -- when DB issued the message
  first_seen   timestamptz NOT NULL,
  PRIMARY KEY (trip_id, eva, msg_id)
);
CREATE INDEX stop_messages_day ON stop_messages (service_date);
