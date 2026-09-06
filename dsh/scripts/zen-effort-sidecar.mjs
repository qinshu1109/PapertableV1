/**
 * zen-effort-sidecar — align DSH's opencode-go traffic with DeepSeek's
 * OFFICIAL Anthropic-format thinking-intensity control.
 *
 * Why this exists: DeepSeek's official parameter is
 * `output_config: {effort: "low"|"high"|"max"}` (Anthropic format; the max
 * tier is a real, distinct tier — official mapping max→max). The pi-ai
 * adapter cannot emit it: its ThinkingLevel enum has no "max" (clamped to
 * high) and its budget path emits `thinking.budget_tokens`, which this
 * gateway demonstrably ignores (measured 2026-08-16: budget 1024/65536 gave
 * noise-level differences while output_config.effort=max gave 5.4× deeper
 * reasoning). The sidecar rewrites the outbound JSON body at the last hop:
 *
 *   - removes `thinking` (pi-ai's ineffective budget emulation)
 *   - injects `output_config: {effort: $ZEN_EFFORT}` (default "max")
 *   - forwards everything else byte-identically and pipes SSE responses
 *     through untouched (thinking blocks, signatures, usage all preserved)
 *
 * Zero dependencies (node stdlib only). Binds 127.0.0.1 only. Never logs
 * credentials: only timestamp, method, path, upstream status, and body size.
 *
 * Outbound goes through an HTTP CONNECT tunnel (local proxy, default
 * http://127.0.0.1:7897 — direct TLS to the gateway is reset by the local
 * TUN fake-IP routing) with a direct-TLS fallback when the proxy is down.
 */

import http from 'node:http'
import https from 'node:https'
import { connect as tlsConnect } from 'node:tls'

const PORT = Number(process.env.ZEN_PORT ?? 8790)
const UPSTREAM_HOST = 'opencode.ai'
const UPSTREAM_PATH_PREFIX = '/zen/go'
const EFFORT = process.env.ZEN_EFFORT ?? 'max'
const PROXY_URL = process.env.ZEN_PROXY ?? 'http://127.0.0.1:7897'

const HOP_BY_HOP = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding',
  'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'upgrade',
])

const proxy = new URL(PROXY_URL)
const proxyHost = proxy.hostname
const proxyPort = Number(proxy.port) || 80

const log = (...args) => console.log(new Date().toISOString(), ...args)

/** Open a TLS socket to the upstream, via CONNECT tunnel with direct fallback. */
function openUpstream() {
  return new Promise((resolve, reject) => {
    const direct = () => {
      const sock = tlsConnect({ host: UPSTREAM_HOST, port: 443, servername: UPSTREAM_HOST })
      sock.once('error', reject)
      sock.once('secureConnect', () => resolve(sock))
    }
    const req = http.request({
      host: proxyHost, port: proxyPort, method: 'CONNECT',
      path: `${UPSTREAM_HOST}:443`, headers: { host: `${UPSTREAM_HOST}:443` },
    })
    req.setTimeout(10_000, () => req.destroy(new Error('proxy CONNECT timeout')))
    req.once('error', () => direct()) // proxy down → try direct
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        direct()
        return
      }
      const tls = tlsConnect({ socket, servername: UPSTREAM_HOST })
      tls.once('error', reject)
      tls.once('secureConnect', () => resolve(tls))
    })
    req.end()
  })
}

/** Rewrite one JSON request body onto the official effort control. */
function rewriteBody(raw) {
  let body
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return { body: raw, changed: false }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { body: raw, changed: false }
  }
  delete body.thinking
  body.output_config = { effort: EFFORT }
  return { body: Buffer.from(JSON.stringify(body), 'utf8'), changed: true }
}

const server = http.createServer(async (req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    let outBody = Buffer.concat(chunks)
    let changed = false
    const isJson = (req.headers['content-type'] ?? '').includes('application/json')
    if (req.method === 'POST' && isJson && outBody.length > 0) {
      const r = rewriteBody(outBody)
      outBody = r.body
      changed = r.changed
    }

    let socket
    try {
      socket = await openUpstream()
    } catch (error) {
      log(`ERR upstream-connect ${req.method} ${req.url}: ${String(error?.message ?? error)}`)
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'sidecar_upstream_unavailable', message: 'zen-effort-sidecar cannot reach the upstream gateway' } }))
      return
    }

    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value
    }
    headers['host'] = UPSTREAM_HOST
    headers['content-length'] = String(outBody.length)

    // http.request over the already-established TLS socket: the CONNECT
    // tunnel above terminated the proxy layer and TLS; sending plaintext
    // HTTP through this socket is the correct single layer of TLS. Node 24
    // bypasses options.createConnection on http.request, so the socket is
    // injected through a per-request Agent's createConnection instead.
    const agent = new http.Agent({ keepAlive: false })
    agent.createConnection = () => socket
    const upReq = http.request({
      agent,
      method: req.method,
      path: UPSTREAM_PATH_PREFIX + req.url,
      headers,
    }, (upRes) => {
      log(`${req.method} ${req.url} -> ${upRes.statusCode}${changed ? ` effort=${EFFORT}` : ''} inBytes=${outBody.length}`)
      res.writeHead(upRes.statusCode, upRes.headers)
      upRes.pipe(res)
    })
    upReq.once('error', (error) => {
      log(`ERR upstream-request ${req.method} ${req.url}:`, JSON.stringify({ code: error?.code, name: error?.name, message: error?.message }))
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'sidecar_upstream_error', message: String(error?.message ?? error) } }))
      } else {
        res.end()
      }
    })
    upReq.end(outBody)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  log(`zen-effort-sidecar listening on 127.0.0.1:${PORT} effort=${EFFORT} upstream=https://${UPSTREAM_HOST}${UPSTREAM_PATH_PREFIX} proxy=${PROXY_URL}`)
})
