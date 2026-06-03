/**
 * Visit Stats 前后端契约常量（改周期或 hour 格式时须同步另一端）。
 * 后端：backend/platform/visit_stats.py — `_STATS_PERIOD_HOURS`、`_STATS_UTC_HOUR_FMT`
 */
export const STATS_PERIOD_HOURS = 1;

export const STATS_PERIOD_MS = STATS_PERIOD_HOURS * 60 * 60 * 1000;
export const STATS_PERIOD_SEC = STATS_PERIOD_HOURS * 3600;

/** `get_active_visits_timeline` bins[].hour；后端 `_utc_hour_key` */
export const STATS_UTC_HOUR_FMT = '%Y-%m-%dT%H:%M:%SZ';

/**
 * 本地「按 clock hour 叠加」槽数（STATS_PERIOD_HOURS 为 1 时等于 24）。
 * 改 STATS_PERIOD_HOURS 时须整除 24，否则槽数非整数，日/周 overlay 会错位。
 */
export const STATS_SLOTS_PER_LOCAL_DAY = 24 / STATS_PERIOD_HOURS;

export const STATS_SLOTS_PER_LOCAL_WEEK = 7 * STATS_SLOTS_PER_LOCAL_DAY;
