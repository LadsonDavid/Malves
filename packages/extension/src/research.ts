/** Research pages must remain public web pages before any DOM content is returned. */
export function researchAddress(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.href.length > 2000 ||
    !host.includes(".") ||
    /^[\d.]+$/.test(host) ||
    host.includes(":") ||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)
  )
    throw new Error("Research is limited to public http(s) pages without credentials.");
  if ([...url.searchParams.keys()].some((key) => /token|secret|password|api.?key|auth/i.test(key)))
    throw new Error("Research cannot read a URL containing credential parameters.");
  return url;
}
