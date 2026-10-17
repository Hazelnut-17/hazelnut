import { isIP } from "node:net";

/** A trusted host-resolver snapshot, never an application-selected DNS override. */
export function dnsResolverAuthorities(servers: readonly string[]): string[] {
  if (servers.length === 0) {
    throw new Error(
      "launch/dns-discovery: the system resolver reported no nameservers; configure DNS and re-run launch",
    );
  }
  const authorities: string[] = [];
  for (const server of servers) {
    let host = server, port = 53;
    if (isIP(host) === 0) {
      const pair = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(server);
      if (!pair) {
        throw new Error(
          "launch/dns-discovery: the system resolver reported an invalid numeric nameserver; check the host DNS configuration",
        );
      }
      host = pair[1] ?? pair[2]!;
      port = Number(pair[3]);
    }
    const family = isIP(host);
    if (
      !family || !Number.isInteger(port) || port < 1 || port > 65535 ||
      host.includes("%")
    ) {
      throw new Error(
        "launch/dns-discovery: the system resolver reported an invalid numeric nameserver; check the host DNS configuration",
      );
    }
    const authority = `${
      family === 6 ? `[${host.toLowerCase()}]` : host
    }:${port}`;
    if (!authorities.includes(authority)) authorities.push(authority);
  }
  return authorities;
}
