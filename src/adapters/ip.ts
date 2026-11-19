/**
 * Turns a client address into a rate limit bucket.
 *
 * - IPv4-mapped IPv6 (`::ffff:1.2.3.4`) becomes plain IPv4, so the same client
 *   does not get two buckets depending on the socket family.
 * - IPv6 is reduced to its /56 (configurable) prefix: a single customer
 *   usually controls at least a /64, often a /56 or /48, and could otherwise
 *   rotate addresses to dodge limits.
 * - Anything unparsable is returned lowercased, unchanged.
 */
export function normalizeIp(raw: string, ipv6Subnet = 56): string {
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);

  if (isIPv4(ip)) return ip;
  if (!ip.includes(':')) return ip;

  const hextets = expandIPv6(ip);
  if (!hextets) return ip;

  // ::ffff:a.b.c.d
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    const [hi, lo] = [hextets[6]!, hextets[7]!];
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }

  const bits = Math.min(128, Math.max(0, Math.floor(ipv6Subnet)));
  const masked = hextets.map((h, i) => {
    const keep = Math.min(16, Math.max(0, bits - i * 16));
    return keep === 0 ? 0 : h & (0xffff << (16 - keep)) & 0xffff;
  });
  return `${masked.map((h) => h.toString(16)).join(':')}/${bits}`;
}

function isIPv4(ip: string): boolean {
  const parts = ip.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Parses IPv6 text into 8 numbers, or undefined if it is not valid. */
function expandIPv6(ip: string): number[] | undefined {
  const halves = ip.split('::');
  if (halves.length > 2) return undefined;

  const parse = (part: string): number[] | undefined => {
    if (part === '') return [];
    const out: number[] = [];
    const groups = part.split(':');
    for (const [i, group] of groups.entries()) {
      if (i === groups.length - 1 && group.includes('.')) {
        if (!isIPv4(group)) return undefined;
        const [a, b, c, d] = group.split('.').map(Number) as [number, number, number, number];
        out.push((a << 8) | b, (c << 8) | d);
      } else if (/^[0-9a-f]{1,4}$/.test(group)) {
        out.push(parseInt(group, 16));
      } else {
        return undefined;
      }
    }
    return out;
  };

  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !tail) return undefined;

  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

interface RequestWithIp {
  ip?: string;
  socket?: { remoteAddress?: string | undefined } | null;
}

/**
 * Default client address for Express and Fastify: `req.ip`, which respects
 * the framework's trust-proxy setting, then the socket address. Never reads
 * `X-Forwarded-For` directly: any client can set it.
 */
export function defaultGetIp(req: unknown): string | undefined {
  const r = req as RequestWithIp;
  return r.ip ?? r.socket?.remoteAddress ?? undefined;
}
