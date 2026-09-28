# Migrate one legacy memory directory

This standalone helper is for a memory still stored under `~/.stone_memory/runtimes/<runtime>/<purpose>/<legacy-id>`. It does not modify the normal `stmem` CLI or services.
It accepts only a direct legacy ID; entries whose `memoryId` points to another ID need a separate migration plan.

1. Run `node scripts/migrate-legacy-memory-layout.js --memory <legacy-id>` to preview the file count, size, and watcher-lock status. Preview makes no changes.
2. Stop Stone Memory Web and all watchers. Check they have stopped; `--services-stopped` is **your confirmation**, not an automatic service check.
3. Run `node scripts/migrate-legacy-memory-layout.js --memory <legacy-id> --apply --services-stopped`.
4. Check the new memory and explicitly bind its thread with the normal Binding flow **before** restarting Web and watchers. This helper does not infer or transfer thread bindings.

On apply, the helper copies files with SHA-256 verification, creates canonical metadata under `~/.stone_memory/memories/<legacy-id>`, and atomically updates `stmem.json`. A copy of the original config is kept under `~/.stone_memory/backups/layout-migration/<legacy-id>/<timestamp>/`. The legacy directory and global SQLite database are left untouched. If the canonical destination or registry entry already exists, it stops rather than overwriting. Keep the backup until the new layout and binding are checked.

Use a recent Node.js version supported by this repository (22 or newer). Do not run this against live or irreplaceable data without a separate recoverable backup. This helper does not install anything, restart services, rebuild threads, or remove old files.
