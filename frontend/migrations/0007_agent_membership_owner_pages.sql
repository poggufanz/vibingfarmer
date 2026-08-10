-- Serve owner membership pages in their stable creation order without a temporary sort.
CREATE INDEX IF NOT EXISTS idx_agent_memberships_owner_creation
  ON agent_memberships (network_id, owner_address, creation_ledger, agent_address);

-- Membership discovery evidence is immutable once an agent address has been indexed. This
-- database-level guard covers direct upserts and commitSourcePage() transaction batches alike.
CREATE TRIGGER IF NOT EXISTS trg_agent_memberships_immutable_identity
BEFORE UPDATE ON agent_memberships
WHEN OLD.owner_address IS NOT NEW.owner_address
  OR OLD.creator_address IS NOT NEW.creator_address
  OR OLD.creation_ledger IS NOT NEW.creation_ledger
  OR OLD.creation_tx IS NOT NEW.creation_tx
  OR OLD.grant_tx_hash IS NOT NEW.grant_tx_hash
  OR OLD.run_id IS NOT NEW.run_id
  OR OLD.run_ordinal IS NOT NEW.run_ordinal
BEGIN
  SELECT RAISE(ABORT, 'immutable agent membership identity conflict');
END;
