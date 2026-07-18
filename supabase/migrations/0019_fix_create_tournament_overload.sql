-- ============================================================================
-- Bugfix: 0014 replaced create_tournament() with an 8th-parameter-added
-- version (p_description) using `create or replace function`, but that only
-- works in place when the parameter *list* is identical up to added
-- trailing defaults matching the exact same signature Postgres already has
-- catalogued -- here it created a genuinely new overload instead, because
-- `create or replace` only reuses an existing function when the argument
-- types match exactly. The result: both the 0009 six-argument
-- create_tournament(text,text,date,integer,text,integer) and the 0014
-- seven-argument create_tournament(text,text,date,integer,text,integer,text)
-- exist simultaneously. Since the seventh parameter has a default, a
-- six-argument call matches both overloads and Postgres raises "function is
-- not unique". Discovered by actually running the pgTAP suite (previously
-- never executed) against a live database.
-- ============================================================================

drop function if exists public.create_tournament(text, text, date, integer, text, integer);
