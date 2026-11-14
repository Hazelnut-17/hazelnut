import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/** Send over one of the prevalidated addresses while retaining the URL as TLS and HTTP authority. */
export async function pinnedFetch(
  url: URL,
  init: RequestInit,
  addresses: readonly string[],
  ca?: string,
): Promise<Response> {
  if (url.username || url.password) {
    throw new TypeError(
      "safe-fetch/credentials: URL credentials are not supported",
    );
  }
  if ((init as RequestInit & { client?: unknown }).client !== undefined) {
    throw new TypeError(
      "safe-fetch/client: a custom native HTTP client requires a trusted fetchFn",
    );
  }
  const request = new Request(url, { ...init, redirect: "error" });
  const host = request.headers.get("host");
  if (host !== null && host.toLowerCase() !== url.host.toLowerCase()) {
    throw new TypeError("safe-fetch/host: Host must match the URL authority");
  }
  if (request.integrity) {
    throw new TypeError(
      "safe-fetch/integrity: integrity is not supported by the pinned transport",
    );
  }
  for (
    const header of [
      "connection",
      "content-length",
      "expect",
      "proxy-authorization",
      "proxy-connection",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]
  ) {
    if (request.headers.has(header)) {
      throw new TypeError(
        `safe-fetch/header: '${header}' is managed by the pinned transport`,
      );
    }
  }
  const headers = Object.fromEntries(request.headers.entries());
  if (!("accept-encoding" in headers)) {
    headers["accept-encoding"] = "gzip, deflate, br";
  }
  const choices = addresses.map((address) => ({
    address,
    family: isIP(address),
  }));
  if (choices.length === 0 || choices.some(({ family }) => family === 0)) {
    throw new Error(
      "safe-fetch/invalid-address: resolver returned an invalid address",
    );
  }
  const transport = url.protocol === "https:" ? https : http;
  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    let body: Readable | undefined;
    const req = transport.request(url, {
      method: request.method,
      headers,
      signal: request.signal,
      // An environment-level Node TLS opt-out must not weaken this transport.
      rejectUnauthorized: true,
      ...(ca === undefined ? {} : { ca }),
      // Never reuse a socket selected by another client or an earlier DNS verdict.
      agent: false,
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          callback(null, choices as { address: string; family: number }[]);
        } else callback(null, choices[0]!.address, choices[0]!.family);
      },
    }, (incoming) => {
      try {
        const status = incoming.statusCode ?? 0;
        if (
          [301, 302, 303, 307, 308].includes(status) &&
          incoming.headers.location
        ) {
          incoming.destroy();
          settled = true;
          reject(
            new TypeError(
              "Encountered redirect while redirect mode is set to 'error'",
            ),
          );
          return;
        }
        const responseHeaders = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          responseHeaders.append(
            incoming.rawHeaders[i]!,
            incoming.rawHeaders[i + 1]!,
          );
        }
        const empty = request.method === "HEAD" ||
          [204, 205, 304].includes(status);
        let stream: Readable = incoming;
        const encoding = responseHeaders.get("content-encoding")?.toLowerCase();
        if (!empty && encoding === "gzip") {
          stream = incoming.pipe(createGunzip());
        } else if (!empty && encoding === "deflate") {
          stream = incoming.pipe(createInflate());
        } else if (!empty && encoding === "br") {
          stream = incoming.pipe(createBrotliDecompress());
        }
        if (stream !== incoming) {
          incoming.on("error", (error) => stream.destroy(error));
        }
        if (empty) incoming.resume();
        try {
          const response = new Response(
            empty ? null : Readable.toWeb(stream) as ReadableStream<Uint8Array>,
            {
              status,
              statusText: incoming.statusMessage,
              headers: responseHeaders,
            },
          );
          Object.defineProperty(response, "url", { value: url.href });
          settled = true;
          resolve(response);
        } catch (error) {
          incoming.destroy();
          settled = true;
          reject(error);
        }
      } catch (error) {
        incoming.destroy();
        settled = true;
        reject(error);
      }
    });
    req.on("error", (error) => {
      body?.destroy();
      if (!settled) reject(error);
    });
    if (request.body) {
      body = Readable.fromWeb(request.body as never);
      body.on("error", (error) => req.destroy(error));
      body.pipe(req);
    } else req.end();
  });
}
