import { isIP } from 'node:net';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A single browser origin, explicitly opted in by the person configuring Tailscale Serve. */
export function parseTailscaleOrigin(value) {
  if (value === undefined || value === '') return null;
  let url;
  try {
    if (typeof value !== 'string' || !/^https:\/\/[^\s\\/?#]+$/i.test(value)) throw new Error();
    url = new URL(value);
    const labels = url.hostname.split('.');
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.endsWith('.ts.net')
      || url.hostname.length > 253 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || url.port === '0') throw new Error();
  } catch {
    throw new Error('STRATA_TAILSCALE_ORIGIN must be one HTTPS .ts.net origin, without a path, credentials or wildcard.');
  }
  return url.origin;
}

function loopback(address) {
  if (typeof address !== 'string') return false;
  address = address.toLowerCase();
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true;
  if (address.startsWith('::ffff:')) address = address.slice(7);
  return isIP(address) === 4 && address.startsWith('127.');
}

/** This is a proxy-origin exception, not authentication: Tailscale Serve controls who can reach the loopback host. */
export function createTailscaleAccess({ origin, port } = {}) {
  const approved = parseTailscaleOrigin(origin);
  if (approved && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) throw new Error('The Tailscale backend port is invalid.');
  const allowsProxy = req => {
    if (!approved || req.headers?.origin !== approved || !loopback(req.socket?.remoteAddress)) return false;
    const host = req.headers?.host;
    if (typeof host !== 'string' || !host || /[\s/?#@\\]/.test(host)) return false;
    try {
      // Serve can preserve the public Host or replace it with its loopback HTTP target.
      if (new URL('https://' + host).origin === approved) return true;
      const backend = new URL('http://' + host);
      return LOCAL_HOSTS.has(backend.hostname) && Number(backend.port || 80) === port;
    } catch { return false; }
  };
  const allowsLocal = req => {
    const value = req.headers?.origin, host = req.headers?.host;
    if (typeof value !== 'string' || typeof host !== 'string' || !loopback(req.socket?.remoteAddress)) return false;
    try {
      const local = new URL(value);
      return value === local.origin && local.protocol === 'http:' && LOCAL_HOSTS.has(local.hostname)
        && local.host === host && Number(local.port || 80) === port;
    } catch { return false; }
  };
  return Object.freeze({
    origin: approved,
    allows: allowsProxy,
    allowsBrowser(req) {
      return !!approved && (allowsProxy(req) || allowsLocal(req));
    },
  });
}
