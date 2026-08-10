-- Task 14 stores only SHA-256 digests in the existing lease_token column. Any pre-upgrade row
-- contains an unhashed bearer capability and cannot be safely migrated without possessing the
-- caller's original token. Leases are bounded and re-claimable, so invalidate them atomically.
DELETE FROM base_child_recovery_leases;
