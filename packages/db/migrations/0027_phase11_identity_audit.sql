CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TABLE passkeys (
  id text PRIMARY KEY, name text, public_key text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE, counter bigint NOT NULL CHECK (counter >= 0),
  device_type text NOT NULL, backed_up boolean NOT NULL,
  transports text, created_at timestamptz NOT NULL DEFAULT now(), aaguid text
);
CREATE INDEX passkeys_user_idx ON passkeys(user_id);
CREATE TABLE workspace_memberships (
  workspace_id text NOT NULL REFERENCES installation(workspace_id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner' CHECK (role = 'owner'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id), UNIQUE(workspace_id)
);
INSERT INTO workspace_memberships (workspace_id, user_id)
  SELECT workspace_id, admin_id FROM installation WHERE admin_id IS NOT NULL;
CREATE FUNCTION sazuz_owner_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.admin_id IS NOT NULL THEN
    INSERT INTO workspace_memberships (workspace_id, user_id)
      VALUES (NEW.workspace_id, NEW.admin_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER installation_owner_membership AFTER INSERT OR UPDATE OF admin_id ON installation
  FOR EACH ROW EXECUTE FUNCTION sazuz_owner_membership();
--> statement-breakpoint
ALTER TABLE audit_log ADD COLUMN sequence bigint NOT NULL DEFAULT 0,
  ADD COLUMN canonical text NOT NULL DEFAULT '',
  ADD COLUMN previous_hash text NOT NULL DEFAULT '',
  ADD COLUMN hash text NOT NULL DEFAULT '';
CREATE TABLE audit_chain_state (
  id text PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
  sequence bigint NOT NULL DEFAULT 0,
  hash text NOT NULL DEFAULT repeat('0',64)
);
INSERT INTO audit_chain_state (id) VALUES ('singleton');
CREATE FUNCTION sazuz_audit_canonical(row_value audit_log) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_array(row_value.id, row_value.actor_id, row_value.action,
    row_value.target, to_char(row_value.created_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text
$$;
DO $$
DECLARE entry audit_log; prior text := repeat('0',64); ordinal bigint := 0; payload text; next_hash text;
BEGIN
  FOR entry IN SELECT * FROM audit_log ORDER BY created_at, id LOOP
    ordinal := ordinal + 1;
    payload := sazuz_audit_canonical(entry);
    next_hash := encode(digest('sazuz:audit:v1:' || prior || payload,'sha256'),'hex');
    UPDATE audit_log SET sequence=ordinal, canonical=payload, previous_hash=prior, hash=next_hash WHERE id=entry.id;
    prior := next_hash;
  END LOOP;
  UPDATE audit_chain_state SET sequence=ordinal, hash=prior WHERE id='singleton';
END $$;
CREATE UNIQUE INDEX audit_log_sequence_idx ON audit_log(sequence);
CREATE FUNCTION sazuz_seal_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tip audit_chain_state;
BEGIN
  INSERT INTO audit_chain_state (id) VALUES ('singleton') ON CONFLICT DO NOTHING;
  SELECT * INTO tip FROM audit_chain_state WHERE id='singleton' FOR UPDATE;
  IF EXISTS (SELECT 1 FROM audit_log WHERE id=NEW.id) THEN RETURN NULL; END IF;
  NEW.sequence := tip.sequence + 1;
  NEW.canonical := sazuz_audit_canonical(NEW);
  NEW.previous_hash := tip.hash;
  NEW.hash := encode(digest('sazuz:audit:v1:' || NEW.previous_hash || NEW.canonical,'sha256'),'hex');
  UPDATE audit_chain_state SET sequence=NEW.sequence, hash=NEW.hash WHERE id='singleton';
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_seal BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION sazuz_seal_audit();
CREATE FUNCTION sazuz_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit entries are append-only'; END $$;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION sazuz_audit_immutable();
--> statement-breakpoint
CREATE FUNCTION sazuz_audit_id() RETURNS text LANGUAGE plpgsql AS $$
DECLARE alphabet text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  millis numeric := floor(extract(epoch FROM clock_timestamp()) * 1000);
  entropy bytea := gen_random_bytes(10); random_value numeric := 0;
  time_part text := ''; random_part text := ''; i integer;
BEGIN
  FOR i IN 0..9 LOOP random_value := random_value * 256 + get_byte(entropy,i); END LOOP;
  FOR i IN 1..10 LOOP
    time_part := substr(alphabet,mod(millis,32)::integer+1,1) || time_part;
    millis := trunc(millis/32);
  END LOOP;
  FOR i IN 1..16 LOOP
    random_part := substr(alphabet,mod(random_value,32)::integer+1,1) || random_part;
    random_value := trunc(random_value/32);
  END LOOP;
  RETURN 'aud_' || time_part || random_part;
END $$;
CREATE FUNCTION sazuz_passkey_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log(id,actor_id,action,target)
      VALUES (sazuz_audit_id(),NEW.user_id,'passkey.registered',NEW.id);
    RETURN NEW;
  END IF;
  INSERT INTO audit_log(id,actor_id,action,target)
    VALUES (sazuz_audit_id(),OLD.user_id,'passkey.deleted',OLD.id);
  RETURN OLD;
END $$;
CREATE TRIGGER passkey_audit AFTER INSERT OR DELETE ON passkeys
  FOR EACH ROW EXECUTE FUNCTION sazuz_passkey_audit();
CREATE FUNCTION sazuz_passkey_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('sazuz-passkeys:' || NEW.user_id,0));
  IF (SELECT count(*) FROM passkeys WHERE user_id=NEW.user_id) >= 10 THEN
    RAISE EXCEPTION 'Passkey limit reached';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER passkey_limit BEFORE INSERT ON passkeys FOR EACH ROW EXECUTE FUNCTION sazuz_passkey_limit();
