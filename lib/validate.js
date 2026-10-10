/**
 * Input validation for user-supplied media URLs.
 *
 * This is a local utility, but the URL is handed to a child process, so we
 * still refuse anything that is not a plain public http(s) URL: no credentials
 * in the URL, no loopback/link-local/private-range hosts, no option-like
 * strings that could be interpreted as yt-dlp flags.
 */

const MAX_URL_LENGTH = 2048;

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function isPrivateIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;

  const octets = match.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return true; // malformed -> treat as unsafe

  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/**
 * Expand an IPv6 literal into its eight 16-bit groups, or null if malformed.
 *
 * The WHATWG URL parser rewrites IPv4-mapped literals into compressed hex
 * (`http://[::ffff:127.0.0.1]/` becomes `::ffff:7f00:1`), so a regex looking for
 * a dotted quad would never fire. Expanding properly is the only reliable way to
 * classify these, and `::ffff:a.b.c.d` is a standard way to reach a private
 * IPv4 host.
 */
function expandIpv6(host) {
  let value = host.toLowerCase();

  // Rewrite a trailing dotted quad into two hex groups.
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (dotted) {
    const octets = [dotted[2], dotted[3], dotted[4], dotted[5]].map(Number);
    if (octets.some((n) => n > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    value = `${dotted[1]}${hi}:${lo}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  let groups;
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length;
    // `::` must stand for at least one group.
    if (missing < 1) return null;
    groups = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    groups = left;
  }

  if (groups.length !== 8) return null;

  const parsed = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  return parsed.some(Number.isNaN) ? null : parsed;
}

function isPrivateIpv6(host) {
  // Not an IPv6 literal at all.
  if (!host.includes(':')) return false;

  const groups = expandIpv6(host);
  // An IPv6 literal we cannot parse is treated as unsafe.
  if (!groups) return true;

  if (groups.every((g) => g === 0)) return true; // unspecified ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // loopback ::1

  const [g0, , , , , g5, g6, g7] = groups;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms: decide
  // using the IPv4 rules on the embedded address.
  if (groups.slice(0, 5).every((g) => g === 0) && (g5 === 0xffff || g5 === 0)) {
    return isPrivateIpv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }

  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local  fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link local    fe80::/10
  return false;
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, url: string, host: string } | { ok: false, error: string }}
 */
export function validateUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: 'Paste a video URL to begin.' };
  }

  const trimmed = raw.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    return { ok: false, error: 'That URL is too long to be useful.' };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "That doesn't look like a valid URL." };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// URLs are supported.' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URLs with embedded credentials are not allowed.' };
  }

  // WHATWG URL lowercases the host but *keeps* the brackets around IPv6
  // literals (`new URL('http://[::1]/').hostname === '[::1]'`), so strip them
  // before matching against the IPv6 ranges.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (!host) return { ok: false, error: "That URL doesn't include a host." };
  if (BLOCKED_HOSTS.has(host)) {
    return { ok: false, error: 'Requests to localhost are blocked.' };
  }
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, error: 'Requests to internal hosts are blocked.' };
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    return { ok: false, error: 'Requests to private IP ranges are blocked.' };
  }

  return { ok: true, url: parsed.toString(), host };
}
