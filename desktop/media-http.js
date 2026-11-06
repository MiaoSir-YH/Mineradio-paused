'use strict';

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const ipaddr = require('ipaddr.js');

function isPublicAddress(address) {
  // process() classifies IPv4-mapped IPv6 addresses using their IPv4 range.
  return ipaddr.isValid(address) && ipaddr.process(address).range() === 'unicast';
}

function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, family: options.family, hints: options.hints }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      return callback(new Error('MEDIA_ADDRESS_NOT_PUBLIC'));
    }
    // Connect using the checked addresses from this lookup, without a second DNS resolution.
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function validatedMediaUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('MEDIA_URL_NOT_ALLOWED');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname) && !isPublicAddress(hostname)) throw new Error('MEDIA_ADDRESS_NOT_PUBLIC');
  return url;
}

async function openPublicMedia(value, options = {}) {
  let url = validatedMediaUrl(value);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.get(url, {
        method: options.method || 'GET',
        agent: false,
        headers: { ...options.headers, 'Accept-Encoding': 'identity' },
        lookup: publicLookup,
        signal: options.signal,
      }, (incoming) => {
        clearTimeout(deadline);
        resolve(incoming);
      });
      const deadline = setTimeout(() => req.destroy(new Error('MEDIA_HEADERS_TIMEOUT')), 9000);
      req.once('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
    });
    if (![301, 302, 303, 307, 308].includes(response.statusCode)) return response;
    const location = response.headers.location;
    response.destroy();
    if (!location) throw new Error('MEDIA_REDIRECT_MISSING');
    const next = validatedMediaUrl(new URL(location, url));
    if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('MEDIA_REDIRECT_DOWNGRADE');
    url = next;
  }
  throw new Error('MEDIA_REDIRECT_LIMIT');
}

function enforceMediaLimit(response, maxBytes) {
  const declaredSize = Number(response.headers['content-length']);
  if (declaredSize > maxBytes || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
    response.destroy();
    throw new Error('MEDIA_RESPONSE_NOT_ALLOWED');
  }
  response.setTimeout(12000, () => response.destroy(new Error('MEDIA_BODY_TIMEOUT')));
}

async function pipeMedia(response, destination, maxBytes, headers) {
  enforceMediaLimit(response, maxBytes);
  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) return callback(new Error('MEDIA_BODY_TOO_LARGE'));
      callback(null, chunk);
    },
  });
  destination.writeHead(response.statusCode, headers);
  await pipeline(response, meter, destination);
}

async function collectMedia(response, maxBytes) {
  enforceMediaLimit(response, maxBytes);
  const chunks = [];
  let received = 0;
  for await (const chunk of response) {
    received += chunk.length;
    if (received > maxBytes) throw new Error('MEDIA_BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, received);
}

// The offline podcast decoder consumes Web Streams. Keep it on the same checked
// transport as playback, including HEAD probes and every redirected URL.
async function fetchPublicMedia(value, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  timer.unref();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let upstream;
  try {
    upstream = await openPublicMedia(value, { ...options, signal });
    const headers = new Headers();
    for (const [name, header] of Object.entries(upstream.headers)) {
      if (header != null) headers.set(name, Array.isArray(header) ? header.join(', ') : header);
    }
    const type = (headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (upstream.statusCode < 200 || upstream.statusCode >= 300 ||
        (type && !/^audio\//.test(type) && !['application/octet-stream', 'binary/octet-stream', 'application/ogg', 'video/mp4'].includes(type))) {
      throw new Error('MEDIA_RESPONSE_NOT_ALLOWED');
    }
    if (options.method === 'HEAD') {
      upstream.destroy(); clearTimeout(timer);
      return new Response(null, { status: upstream.statusCode, headers });
    }
    const maxBytes = 2 * 1024 * 1024 * 1024;
    enforceMediaLimit(upstream, maxBytes);
    let received = 0;
    const bounded = new Transform({ transform(chunk, _encoding, done) {
      received += chunk.length;
      done(received > maxBytes ? new Error('MEDIA_BODY_TOO_LARGE') : null, chunk);
    } });
    pipeline(upstream, bounded).catch(() => {}).finally(() => clearTimeout(timer));
    return new Response(Readable.toWeb(bounded), { status: upstream.statusCode, headers });
  } catch (error) {
    clearTimeout(timer);
    if (upstream) upstream.destroy();
    throw error;
  }
}

module.exports = { openPublicMedia, pipeMedia, collectMedia, fetchPublicMedia };
