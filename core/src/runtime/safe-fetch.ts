// The outbound SSRF floor, as a first-class primitive: `safeFetch` = https-only (loud opt-out) + DNS
// pre-flight against forbidden ranges (loud opt-in for private receivers) + `redirect: "error"`.
// `defineWebhook` delivery rides this same floor — one implementation, two doors.

/** The 16 address bytes of an IPv6 literal (surrounding brackets and a `%zone` suffix tolerated), or
 *  null when `text` is not one. The forbidden-range rules read BYTES, never spelling: the WHATWG host
 *  parser serializes `::ffff:127.0.0.1` as `::ffff:7f00:1`, so a textual rule over the dotted form
 *  never sees what `safeFetch` actually passes. */
function ipv6Bytes(text: string): Uint8Array | null {
  const s = text.replace(/^\[/, "").replace(/\]$/, "").replace(/%.*$/, "")
    .toLowerCase();
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (p: string): number[] | null => {
    if (p === "") return [];
    const groups = p.split(":");
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      if (i === groups.length - 1 && g.includes(".")) {
        const v4 = g.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (!v4) return null;
        for (const n of [v4[1]!, v4[2]!, v4[3]!, v4[4]!].map(Number)) {
          if (n > 255) return null;
          out.push(n);
        }
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      const n = parseInt(g, 16);
      out.push(n >> 8, n & 0xff);
    }
    return out;
  };
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  if (head === null || tail === null) return null;
  const gap = 16 - head.length - tail.length;
  if (halves.length === 2 ? gap < 2 : gap !== 0) return null; // `::` covers ≥1 zero group
  return new Uint8Array([...head, ...Array(gap).fill(0), ...tail]);
}

/** true when an IPv4/IPv6 literal is in a range an outbound call must never reach by default:
 *  loopback, RFC1918 private, link-local (incl. the 169.254.169.254 cloud metadata endpoint), CGNAT,
 *  IPv6 loopback/ULA/link-local, and every v6 form that carries an IPv4 destination inside it. */
export function isForbiddenIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true; // loopback, RFC1918 10/8, "this network"
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
    if (a === 192 && b === 168) return true; // RFC1918 192.168/16
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    const c = Number(v4[3]);
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a >= 240) return true; // 240.0.0.0/4 reserved + 255.255.255.255 broadcast
    return false;
  }
  const b = ipv6Bytes(ip);
  if (b === null) return false; // not an IP literal at all
  const zeros = (from: number, to: number) =>
    b.subarray(from, to).every((x) => x === 0);
  // ::/64 is wholly reserved, so every v4-embedding spelling lands in it — v4-mapped
  // (`::ffff:a.b.c.d`), v4-compatible (`::a.b.c.d`), SIIT-translated (`::ffff:0:a.b.c.d`) — as does
  // `::`/`::1`; the trailing 4 bytes are the only destination they can name. The NAT64 well-known
  // prefix is the same shape and a gateway really does forward it.
  const nat64 = b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff &&
    b[3] === 0x9b && zeros(4, 12);
  if (zeros(0, 8) || nat64) {
    return isForbiddenIp(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0]! & 0xfe) === 0xfc) return true; // ULA fc00::/7
  return false;
}

/** Resolve + validate a hostname's addresses; a literal-IP host validates directly. Throwing here rides the
 *  consumer retry path (a transient resolver failure retries; a forbidden range keeps refusing → DLQ).
 *
 *  `door` names the caller in the message. The floor is generic — `safeFetch` is a barrel primitive any
 *  hand-written outbound call rides — so a diagnosis must never point at a `defineWebhook` the reader did
 *  not declare; `defineWebhook` passes its own name and keeps the message it always had. */
export async function assertAddressAllowed(
  host: string,
  allowPrivate: boolean,
  resolve: (host: string, kind: "A" | "AAAA") => Promise<string[]> = (h, k) =>
    Deno.resolveDns(h, k).catch(() => []),
  door: string = "egress",
): Promise<void> {
  if (allowPrivate) return;
  const literal = /^[\d.]+$/.test(host) || host.includes(":");
  const addrs = literal
    ? [host.replace(/^\[|\]$/g, "")]
    : [...await resolve(host, "A"), ...await resolve(host, "AAAA")];
  if (!literal && addrs.length === 0) {
    throw new Error(`${door}: DNS resolved no addresses for '${host}'`);
  }
  const bad = addrs.find(isForbiddenIp);
  if (bad) {
    throw new Error(
      `${door}/private-address-refused: '${host}' resolves to ${bad} — a private/loopback/link-local/metadata range an outbound call must not reach. If this receiver is deliberately internal, opt in with allowPrivateNetwork: true.`,
    );
  }
}

export interface SafeFetchOpts {
  readonly allowInsecureHttp?: true; // dev-only loud opt-out of the https floor
  readonly allowPrivateNetwork?: true; // explicit opt-in: receiver on a private/internal range
  readonly resolve?: (host: string, kind: "A" | "AAAA") => Promise<string[]>; // injectable resolver (tests)
  readonly fetchFn?: typeof fetch; // injectable transport (tests)
  readonly door?: string; // the caller's name in a refusal message; absent ⇒ the generic `egress`
}

/** `fetch` behind the floor. The DNS pre-flight leaves a rebind residue (resolve-then-connect races a
 *  TTL-0 attacker) — the same honest bound `defineWebhook` documents; pin the IP upstream to close it. */
export async function safeFetch(
  url: string | URL,
  init: RequestInit = {},
  opts: SafeFetchOpts = {},
): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== "https:" && opts.allowInsecureHttp !== true) {
    throw new Error(
      `safe-fetch/https-required: '${u.origin}' is not https — an outbound call travels the open network; pass allowInsecureHttp: true only for a dev receiver you own.`,
    );
  }
  await assertAddressAllowed(
    u.hostname,
    opts.allowPrivateNetwork === true,
    opts.resolve,
    opts.door,
  );
  return await (opts.fetchFn ?? fetch)(u, { ...init, redirect: "error" });
}
