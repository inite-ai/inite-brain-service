import { safeFetch } from './safe-fetch';

const UA_TOKEN = 'inite-brain-source';

/** Per-host robots.txt: `Disallow` prefixes for `*` and for our agent. */
export class RobotsCache {
  private readonly rules = new Map<string, string[]>();
  constructor(
    private readonly opts: {
      allowPrivate: boolean | undefined;
      signal: AbortSignal;
      headers: Record<string, string>;
    },
    private readonly ignore: boolean,
  ) {}

  async allows(url: string): Promise<boolean> {
    if (this.ignore) return true;
    const u = new URL(url);
    let disallow = this.rules.get(u.host);
    if (!disallow) {
      disallow = await this.load(u);
      this.rules.set(u.host, disallow);
    }
    const path = u.pathname + u.search;
    return !disallow.some((prefix) => prefix.length > 0 && path.startsWith(prefix));
  }

  private async load(u: URL): Promise<string[]> {
    try {
      const res = await safeFetch(`${u.protocol}//${u.host}/robots.txt`, {
        ...this.opts,
        headers: {},
        maxBytes: 256 * 1024,
      });
      if (res.status !== 200) return [];
      return parseRobots(res.body.toString('utf8'));
    } catch {
      return [];
    }
  }
}

export function parseRobots(text: string): string[] {
  const out: string[] = [];
  let applies = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line.length === 0) continue;
    const [keyRaw, ...rest] = line.split(':');
    const key = (keyRaw ?? '').trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      applies = value === '*' || value.toLowerCase().includes(UA_TOKEN);
      continue;
    }
    if (applies && key === 'disallow') out.push(value);
  }
  return out;
}
