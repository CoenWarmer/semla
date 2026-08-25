/**
 * Workflow run state persistence for pause/resume support.
 */
import { join } from "node:path";
import { ensureDir as ensureDirFs, listJsonFilesSafe, readJsonWithBackupRecovery, resolvePersistenceFs, unlinkIfExistsSafe, writeJsonAtomicWithBackup, } from "./fs-persistence.js";
import { workflowProjectPaths } from "./workflow-paths.js";
/**
 * Retention policy for terminal (completed/failed/aborted) runs kept on
 * disk. Bounded so a long-lived project directory can't accumulate an
 * unbounded number of run files (each polled/listed on every list() call).
 * A run in "running" or "paused" status is NEVER counted against this cap
 * or evicted by it — only genuinely finished runs age out, oldest (by
 * updatedAt) first, once the terminal-run count exceeds the cap. 300 is
 * generous enough to cover weeks of typical usage while keeping list()'s
 * per-call directory scan bounded.
 */
export const DEFAULT_MAX_TERMINAL_RUNS_ON_DISK = 300;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "aborted"]);
/**
 * `list()` does a full readdirSync + per-file readFileSync + JSON.parse of the
 * entire lifetime run history. It is called on essentially every progress tick
 * (task-panel re-render → WorkflowManager.listRuns()/listAllRuns()), so an
 * unbounded number of ticks each re-walked and re-parsed every run file on
 * disk. Cache the computed list for a short TTL — long enough to absorb a
 * burst of same-tick reads, short enough that a read from a DIFFERENT process
 * (or a mutation this instance doesn't own) still shows up quickly. Mirrors
 * the ~1s settings-read TTL cache in task-panel.ts.
 */
const LIST_CACHE_TTL_MS = 300;
export function createRunPersistence(cwd, fsOverride, options) {
    const fs = resolvePersistenceFs(fsOverride);
    const _existsSync = fs.existsSync;
    const _readFileSync = fs.readFileSync;
    const _statSync = fs.statSync;
    const _unlinkSync = fs.unlinkSync;
    const _writeFileSync = fs.writeFileSync;
    const maxTerminalRunsOnDisk = options?.maxTerminalRunsOnDisk ?? DEFAULT_MAX_TERMINAL_RUNS_ON_DISK;
    const paths = workflowProjectPaths(cwd);
    const runsDir = paths.runsDir;
    const legacyRunsDir = paths.legacyRunsDir;
    const ensureDir = () => ensureDirFs(fs, runsDir);
    const runPath = (dir, runId) => join(dir, `${runId}.json`);
    const primaryRunPath = (runId) => runPath(runsDir, runId);
    const legacyRunPath = (runId) => runPath(legacyRunsDir, runId);
    const lockPath = (dir, runId) => join(dir, `${runId}.lock`);
    const primaryLockPath = (runId) => lockPath(runsDir, runId);
    const legacyLockPath = (runId) => lockPath(legacyRunsDir, runId);
    const candidateRunPaths = (runId) => [primaryRunPath(runId), legacyRunPath(runId)];
    const pidIsAlive = (pid) => {
        if (!Number.isInteger(pid) || pid <= 0)
            return false;
        try {
            process.kill(pid, 0);
            return true;
        }
        catch (err) {
            if (err.code === "EPERM")
                return true;
            return false;
        }
    };
    const readLockAt = (path) => {
        try {
            return JSON.parse(_readFileSync(path, "utf-8"));
        }
        catch {
            return null;
        }
    };
    const readLock = (runId) => readLockAt(primaryLockPath(runId));
    // list() cache: recomputed lazily, invalidated synchronously by every
    // mutation this instance performs (save()/delete()) so a stale read can
    // never outlive a mutation this process made. A read from another process
    // (or a direct fs write bypassing this instance) is picked up once the TTL
    // elapses, same as before this cache existed on the next un-cached call.
    let listCache;
    let listCacheAt = 0;
    const invalidateListCache = () => {
        listCache = undefined;
    };
    // Per-file mtime+size+ino cache, keyed by absolute path: even once the
    // TTL-level listCache above expires (the active panel polls roughly every
    // 300ms, i.e. faster than or comparable to the TTL), most run files on
    // disk haven't changed since the last recompute. Re-stat is cheap; re-read
    // + re-JSON.parse is not, and scales with total lifetime run history, not
    // with what actually changed. A file whose (mtimeMs, size, ino) all match
    // what we last parsed is reused as-is instead of being re-read; entries
    // for files that vanished between recomputes are pruned so this cache
    // can't grow unbounded independent of what's actually on disk.
    //
    // ino is load-bearing, not redundant with mtime+size: save() writes via
    // tmp-write + rename (writeJsonAtomicWithBackup), and a rename onto an
    // existing path allocates a NEW inode for the replacement file. Two
    // consecutive saves landing in the same mtime tick (400ms-throttled
    // progress persists vs. 1-2s mtime granularity on HFS+/many network
    // mounts/some Docker volume drivers is entirely realistic) with
    // coincidentally equal byte length (e.g. "paused" and "failed" are the
    // same length) would otherwise be indistinguishable from "unchanged" by
    // (mtimeMs, size) alone — serving stale, previously-cached content
    // forever until something ELSE about the file changes. The inode always
    // changes on such a rename, so adding it closes that hole for free.
    const fileStateCache = new Map();
    const removeStaleLegacyLock = (runId) => {
        const lock = legacyLockPath(runId);
        const existing = readLockAt(lock);
        if (existing?.runId === runId && pidIsAlive(existing.pid))
            return false;
        try {
            if (_existsSync(lock))
                _unlinkSync(lock);
        }
        catch {
            return false;
        }
        return true;
    };
    const computeList = () => {
        const byRunId = new Map();
        const seenPaths = new Set();
        for (const dir of [runsDir, legacyRunsDir]) {
            for (const file of listJsonFilesSafe(fs, dir)) {
                const path = join(dir, file);
                seenPaths.add(path);
                try {
                    const stat = _statSync(path);
                    const cached = fileStateCache.get(path);
                    // Reuse the last parse when the file is byte-identical (same
                    // mtime + size + inode) to what produced it — the dominant case
                    // on every poll tick once a run goes terminal and stops changing.
                    // ino is what actually rules out a false "unchanged" match on a
                    // coarse-mtime filesystem (see the field doc comment above).
                    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.ino === stat.ino) {
                        if (!byRunId.has(cached.state.runId))
                            byRunId.set(cached.state.runId, cached.state);
                        continue;
                    }
                    const state = JSON.parse(_readFileSync(path, "utf-8"));
                    fileStateCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, state });
                    if (!byRunId.has(state.runId))
                        byRunId.set(state.runId, state);
                }
                catch {
                    // Skip corrupted/unreadable files; don't let a stale cache entry
                    // for a file that's now failing to read linger either.
                    fileStateCache.delete(path);
                }
            }
        }
        // Prune cache entries for files that no longer exist (deleted runs) so
        // this map's size tracks what's actually on disk, not lifetime history.
        for (const path of fileStateCache.keys()) {
            if (!seenPaths.has(path))
                fileStateCache.delete(path);
        }
        return [...byRunId.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    };
    // Bound the number of terminal (completed/failed/aborted) runs kept on
    // disk (see DEFAULT_MAX_TERMINAL_RUNS_ON_DISK) — called after every save()
    // whose state is terminal, since that's the only time the terminal count
    // can grow. Running/paused runs are never candidates: they're filtered out
    // before the cap is even considered.
    const enforceRetention = () => {
        const terminal = computeList()
            .filter((r) => TERMINAL_RUN_STATUSES.has(r.status))
            .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
        const excess = terminal.length - maxTerminalRunsOnDisk;
        if (excess <= 0)
            return;
        for (const run of terminal.slice(0, excess)) {
            deleteRunFiles(run.runId);
        }
        invalidateListCache();
    };
    const deleteRunFiles = (runId) => {
        let deleted = false;
        for (const path of candidateRunPaths(runId)) {
            const dir = path === primaryRunPath(runId) ? runsDir : legacyRunsDir;
            // Best-effort cleanup of the sidecar files alongside the primary.
            for (const sidecar of [`${path}.bak`, `${path}.tmp`, lockPath(dir, runId)]) {
                unlinkIfExistsSafe(fs, sidecar);
                fileStateCache.delete(sidecar);
            }
            if (unlinkIfExistsSafe(fs, path))
                deleted = true;
            fileStateCache.delete(path);
        }
        return deleted;
    };
    return {
        save(state) {
            ensureDir();
            state.updatedAt = new Date().toISOString();
            const path = primaryRunPath(state.runId);
            // Atomic write: a crash mid-write can't corrupt the live file (tmp+rename is
            // atomic on the same filesystem). A .bak from the previous good save is the
            // recovery fallback if the primary is somehow truncated.
            writeJsonAtomicWithBackup(fs, path, state);
            invalidateListCache();
            // Only a terminal write can grow the terminal-run count, so only check
            // the cap then — a "running"/"paused" save is on the hot path (every
            // progress tick) and must not pay for a retention scan.
            if (TERMINAL_RUN_STATUSES.has(state.status))
                enforceRetention();
        },
        load(runId) {
            // Try the primary, then the .bak — so a corrupt primary doesn't lose the run.
            for (const path of candidateRunPaths(runId)) {
                const state = readJsonWithBackupRecovery(fs, path);
                if (state)
                    return state;
            }
            return null;
        },
        list() {
            const now = Date.now();
            // Return a fresh array on every call (a cheap ref-copy) so a caller that
            // sorts/reverses/mutates the result in place can't corrupt the cache — the
            // pre-cache code re-parsed into a new array each call, preserve that.
            if (listCache && now - listCacheAt < LIST_CACHE_TTL_MS) {
                return [...listCache];
            }
            const result = computeList();
            listCache = result;
            listCacheAt = now;
            return [...result];
        },
        delete(runId) {
            try {
                return deleteRunFiles(runId);
            }
            finally {
                invalidateListCache();
            }
        },
        acquireRunLease(runId) {
            ensureDir();
            const path = primaryRunPath(runId);
            const lock = primaryLockPath(runId);
            if (!removeStaleLegacyLock(runId))
                return null;
            for (let attempt = 0; attempt < 2; attempt++) {
                const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
                const payload = {
                    runId,
                    runPath: path,
                    pid: process.pid,
                    startedAt: new Date().toISOString(),
                    token,
                };
                try {
                    _writeFileSync(lock, JSON.stringify(payload, null, 2), { flag: "wx" });
                    return { runId, token };
                }
                catch (err) {
                    const code = err.code;
                    if (code !== "EEXIST")
                        throw err;
                    const existing = readLock(runId);
                    if (existing && existing.runPath === path && pidIsAlive(existing.pid)) {
                        return null;
                    }
                    try {
                        _unlinkSync(lock);
                    }
                    catch {
                        return null;
                    }
                }
            }
            return null;
        },
        releaseRunLease(lease) {
            try {
                const existing = readLock(lease.runId);
                if (existing?.token === lease.token)
                    _unlinkSync(primaryLockPath(lease.runId));
            }
            catch {
                // Best-effort cleanup only.
            }
        },
        getRunsDir() {
            return runsDir;
        },
    };
}
/**
 * Generate a unique run ID.
 */
export function generateRunId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 8);
    return `${timestamp}-${random}`;
}
