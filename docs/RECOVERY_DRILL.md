# Recovery Drill

## 2026-08-18: Sprint 14 Live Isolated Restore

Artifact: `recovery-1787031808168-e0efcd`

The production service created one AES-256-GCM authenticated recovery artifact from an independently verified encrypted state bundle and online SQLite backups. The artifact was 49,190,505 bytes and contained 32 manifest entries: one state bundle and 31 SQLite databases.

The recovery API verified every manifest entry by size and SHA-256, decrypted the artifact, rejected unsafe archive paths, and restored it under the isolated target `/data/itops-agents/backups/restore-drills/sprint14-live-drill`. It did not replace live state.

Post-restore checks:

- Recovery manifest verification: passed, 32 of 32 entries.
- SQLite `PRAGMA integrity_check`: passed, 31 of 31 databases.
- Encrypted state-bundle authentication and payload hashes: passed.
- Incident, workflow/runbook, agent, user/auth, and audit stores were present in the reconciled backup inventory and covered by the verified state or SQLite checks.
- Service health after the drill: healthy.
- Full Linux test suite: 1,188 passed, 0 failed.

## 2026-08-19: Sprint 23 Live Off-Host Verification

Artifact: `recovery-1787165297697-b6c740`

The production service created a 49,770,457-byte encrypted recovery artifact and uploaded it to the dedicated `itops-recovery` bucket on the off-host MinIO service. It then listed the object, downloaded the complete payload to an isolated temporary path, and compared its size and SHA-256 before recording success.

- Object key: `beacon-backups/recovery-1787165297697-b6c740.itops-recovery`
- SHA-256: `5f83b6d79750259d4f4fabb48eb9d5c365df9100c30bd3d3ba5445b9331f47a6`
- Recovery manifest verification: passed for all 33 entries, covering one encrypted state bundle and 32 online SQLite snapshots.
- Scheduler result: `lastOffsiteVerified=true`
- Object storage host: a private storage node separate from the ITOPS source host.
- Recovery-key source: external command custody on an independent private host; the source host no longer stores the encryption key directly.
- Credential scope: a dedicated MinIO identity restricted to the recovery bucket.

The first live attempt also validated failure reporting by surfacing a SigV4 signing-order defect as `SignatureDoesNotMatch`. The signing derivation was corrected, covered by a regression test, deployed, and the full drill then passed.

## Operator API

- `POST /api/system/backups/recovery/run` creates and verifies a full recovery set.
- `GET /api/system/backups/recovery` lists local recovery sets and scheduler/off-site status.
- `GET /api/system/backups/recovery/:recoveryId/verify` authenticates and verifies an artifact.
- `POST /api/system/backups/recovery/:recoveryId/restore` restores only beneath `RECOVERY_RESTORE_ROOT`; it requires `confirmRecoveryId` and `confirmPhrase=RESTORE ISOLATED`, and the target must be empty.
