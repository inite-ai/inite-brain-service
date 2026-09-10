import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/**
 * The name this process answers to everywhere it has to be told apart from
 * its siblings: the `instance` label on Prometheus series, the `instance`
 * field on JSON request lines, `service.instance.id` on OTel spans, and
 * the holder id on a leader lease.
 *
 * One constant so those cannot disagree — correlating a metric spike with
 * the log lines and traces from the same replica only works if all of them
 * name it the same way. Shape: `<hostname>#<pid>#<uuid>`. The hostname is
 * the container id under Docker, the pid separates roles inside one
 * container, and the uuid makes a RESTART a distinct identity — a lease
 * holder that died and came back is not the process that took the lease.
 */
export const PROCESS_IDENTITY = `${hostname()}#${process.pid}#${randomUUID()}`;
