# Database Rehearsal Disk Exhaustion

## Status

The production MySQL service is restored. With explicit user approval, three named old audit copies were removed, recovering about 12 GiB while preserving production and existing backups. The final combined topic/scene rehearsal passed under the new capacity and binary-log guards. The protected production release completed at 2026-10-31 14:03:44 UTC; public desktop/mobile checks subsequently passed. Long-term capacity monitoring remains necessary.

## Impact

The isolated migration rehearsal used the production server's filesystem. Copying benchmark results filled that filesystem, and MySQL aborted after a binary-log commit failed. Database-dependent website requests could fail while MySQL was unavailable. The number of affected requests/users is unknown; no error-rate estimate has been inferred.

The system journal records the first MySQL exit at 2026-10-31 12:39:41 UTC and automatic recovery at 12:40:22 UTC. A subsequent manual restart ran from 12:40:44 to 12:40:45 UTC. The public homepage and topic API returned success after recovery. Production topic/schema migration had not started; this does not constitute a full database corruption audit.

## Cause

The rehearsal isolated database names but shared storage and MySQL binary logs. Its release preflight verified source hashes and schema invariants without reserving enough disk capacity for the cloned data and logs. Repeated copies generated additional retained binary logs. Older audit databases and existing logs had already consumed substantial space.

## Recovery

- Stopped the failing rehearsal query.
- Removed only two verified obsolete candidate directories created by this task.
- Restored MySQL and checked the application, score-sync timer, homepage, and topic API.
- Dropped this task's failed rehearsal database with session binary logging disabled.
- Requested permission before deleting unrelated older audit databases; they were not silently removed.

## Prevention

- Added a rehearsal free-space gate: twice the production table/index size plus 2 GiB reserve.
- Disabled session binary logging for isolated rehearsal connections, including pooled connections.
- Added a second capacity gate before stopping application writes and creating backup copies.
- Retain full backup/hash checks and the prohibition against old-code-only rollback after schema changes.

The retried real rehearsal completed successfully on 2026-10-31, including base and taxonomy migrations, repeat application, reference recalculation, private access, and concurrent cycle rejection. It left the source database fingerprint unchanged and removed its own clone.
