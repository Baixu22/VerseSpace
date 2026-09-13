// WatchLock 是预留导出（契约面）：当前无生产引用，保留为公共 API（issue #4，2026-09-13）。
export { acquireWatchLock, type PidLock as WatchLock } from "../fs/lockfile";
