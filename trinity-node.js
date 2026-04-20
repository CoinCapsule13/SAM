/**
 * trinity-node.js — v4
 * ─────────────────────────────────────────────────────────────────────
 * Drop on any machine. Run with:
 *
 *   node trinity-node.js
 *
 * That's it. No config needed. The node auto-detects its public IP,
 * announces it to peers, and saves everyone it meets to peers.json.
 * Next boot it dials everyone it has ever known automatically.
 *
 * To bootstrap a brand-new node to a friend across the internet:
 *   TRINITY_PEERS=ws://theirpublicip:8080 node trinity-node.js
 *   — after that one run, peers.json handles it forever.
 *
 * Env vars (all optional):
 *   PORT=8080                         — listen port (default 8080)
 *   TRINITY_PEERS=ws://ip:port,...    — bootstrap peers
 *   TRINITY_SELF=ws://1.2.3.4:8080   — override public URL (rare)
 * ─────────────────────────────────────────────────────────────────────
 */

import { createServer }               from "http"
import { readFileSync, existsSync,
         writeFileSync }              from "fs"
import { randomUUID }                 from "node:crypto"
import { WebSocketServer, WebSocket } from "ws"
import { networkInterfaces }          from "os"
import path                           from "path"
import { fileURLToPath }              from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const PORT               = Number(process.env.PORT || 8080)
const PEER_ANNOUNCE_INTERVAL = 20_000
const PEERS_FILE         = path.join(__dirname, "peers.json")

const BOOTSTRAP_ENV = (process.env.TRINITY_PEERS || "")
  .split(",").map(s => s.trim()).filter(Boolean)

// ─── PUBLIC IP AUTO-DETECTION ────────────────────────────────────────────────
// We ask a lightweight public service for our WAN IP so federation
// announcements carry an address peers across the internet can reach.
// Falls back to LAN IP if the fetch fails (air-gapped / no internet).

let PUBLIC_IP = null   // resolved at boot before we start accepting conns

async function detectPublicIP() {
  // Try a few services in order — first success wins
  const services = [
    "https://api4.my-ip.io/ip",
    "https://api.ipify.org",
    "https://icanhazip.com",
    "https://checkip.amazonaws.com",
  ]
  for (const url of services) {
    try {
      // Node 18+ has built-in fetch
      const res  = await fetch(url, { signal: AbortSignal.timeout(3000) })
      const text = (await res.text()).trim()
      // Basic IPv4 sanity check
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
        return text
      }
    } catch {}
  }
  return null
}

// ─── PERSISTENT PEER MEMORY ───────────────────────────────────────────────────

function loadSavedPeers() {
  try {
    const raw  = readFileSync(PEERS_FILE, "utf8")
    const list = JSON.parse(raw)
    if (Array.isArray(list)) return list.filter(s => typeof s === "string")
  } catch {}
  return []
}

function savePeers(urlSet) {
  try { writeFileSync(PEERS_FILE, JSON.stringify([...urlSet], null, 2)) } catch {}
}

const knownPeerUrls = new Set([...loadSavedPeers(), ...BOOTSTRAP_ENV])

// ─── SIGNAL SERVER STATE ──────────────────────────────────────────────────────

const rooms          = new Map()   // roomId → Map<peerId, { ws, identity, nodeUrl }>
const federatedPeers = new Map()   // url    → { ws, status }
const peerNodeIndex  = new Map()   // peerId → nodeUrl (null = local)

// ─── HTTP + WEBSOCKET SERVER ──────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  // CORS — allow browser clients from any origin
  res.setHeader("Access-Control-Allow-Origin", "*")

  if (req.url === "/health") {
    return respondJson(res, 200, {
      ok: true,
      node: getSelfInfo(),
      rooms: Array.from(rooms.keys()),
      federatedPeers: Array.from(federatedPeers.keys()),
      knownPeers: [...knownPeerUrls],
    })
  }

  if (req.url === "/ice") {
    return respondJson(res, 200, {
      iceServers: [
        { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
      ]
    })
  }

  if (req.url === "/peers") {
    return respondJson(res, 200, {
      self: selfUrl(),
      peers: [...knownPeerUrls],
    })
  }

  const htmlPath = path.join(__dirname, "trinity-chat.html")
  if (existsSync(htmlPath)) {
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(readFileSync(htmlPath))
    return
  }

  res.writeHead(404)
  res.end("trinity-chat.html not found next to trinity-node.js")
})

const wss = new WebSocketServer({ server: httpServer })

// ─── WEBSOCKET DISPATCH ───────────────────────────────────────────────────────

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", "http://localhost")
  if (url.searchParams.get("federation") === "1") {
    handleFederationConnection(ws, req)
  } else {
    handleBrowserConnection(ws)
  }
})

// ─── BROWSER CLIENT ───────────────────────────────────────────────────────────

function handleBrowserConnection(ws) {
  let roomId       = null
  let peerIdentity = null
  const peerId     = randomUUID()

  send(ws, { type: "init", peerId, iceDiscoveryUrl: `http://${getLocalIP()}:${PORT}/ice` })

  ws.on("message", (raw) => {
    const data = safeJsonParse(raw)
    if (!data) return

    if (data.type === "join") {
      roomId = sanitize(data.room)
      if (!roomId) return
      peerIdentity = sanitizeIdentity(data.identity)

      if (!rooms.has(roomId)) rooms.set(roomId, new Map())
      const room = rooms.get(roomId)

      send(ws, { type: "peers", peers: Array.from(room.keys()) })
      room.forEach(peer => { if (peer.ws) send(peer.ws, { type: "peer-join", peerId }) })
      room.set(peerId, { ws, identity: peerIdentity, nodeUrl: null })
      peerNodeIndex.set(peerId, null)

      federateSend({ type: "_fed_peer_join", roomId, peerId, identity: peerIdentity, fromNode: selfUrl() })
      return
    }

    if (!roomId) return

    if (data.type === "signal") {
      const room   = rooms.get(roomId)
      if (!room) return
      const target = room.get(data.to)
      if (!target) return
      if (target.ws) {
        send(target.ws, { type: "signal", from: peerId, identity: peerIdentity, signal: data.signal })
      } else {
        const targetNode = peerNodeIndex.get(data.to)
        federateSendTo(targetNode, { type: "_fed_signal", roomId, from: peerId, to: data.to, identity: peerIdentity, signal: data.signal })
      }
      return
    }

    const room = rooms.get(roomId)
    if (!room) return
    room.forEach((peer, id) => {
      if (id !== peerId && peer.ws && peer.ws.readyState === 1) peer.ws.send(raw)
    })
    federateBroadcast(raw, roomId)
  })

  ws.on("close", () => {
    if (!roomId) return
    const room = rooms.get(roomId)
    if (!room) return
    room.delete(peerId)
    peerNodeIndex.delete(peerId)
    room.forEach(peer => { if (peer.ws) send(peer.ws, { type: "peer-leave", peerId }) })
    if (room.size === 0) rooms.delete(roomId)
    federateSend({ type: "_fed_peer_leave", roomId, peerId })
  })
}

// ─── FEDERATION MESSAGE HANDLER ───────────────────────────────────────────────

function handleFederationMessage(data, replyWs) {

  if (data.type === "_fed_announce") {
    const peerUrl = data.selfUrl
    if (peerUrl && peerUrl !== selfUrl()) {
      if (!federatedPeers.has(peerUrl)) {
        console.log(`[fed] discovered ${peerUrl}`)
        federatedPeers.set(peerUrl, { ws: null, status: "discovered" })
        dialPeer(peerUrl)
      }
      knownPeerUrls.add(peerUrl)
      savePeers(knownPeerUrls)

      if (replyWs?.readyState === 1) {
        replyWs.send(JSON.stringify({ type: "_fed_peers", peers: [...knownPeerUrls] }))
        const snapshot = {}
        rooms.forEach((room, rId) => {
          snapshot[rId] = Array.from(room.entries())
            .filter(([, p]) => p.nodeUrl === null)
            .map(([pid, p]) => ({ peerId: pid, identity: p.identity }))
        })
        replyWs.send(JSON.stringify({ type: "_fed_room_snapshot", snapshot, fromNode: selfUrl() }))
      }
    }
    return
  }

  if (data.type === "_fed_peers") {
    ;(data.peers || []).forEach(url => {
      if (url === selfUrl()) return
      knownPeerUrls.add(url)
      if (!federatedPeers.has(url)) {
        console.log(`[fed] learned ${url}`)
        federatedPeers.set(url, { ws: null, status: "discovered" })
        dialPeer(url)
      }
    })
    savePeers(knownPeerUrls)
    return
  }

  if (data.type === "_fed_room_snapshot") {
    const { fromNode, snapshot = {} } = data
    Object.entries(snapshot).forEach(([rId, peers]) => {
      if (!rooms.has(rId)) rooms.set(rId, new Map())
      const room = rooms.get(rId)
      peers.forEach(({ peerId, identity }) => {
        if (!room.has(peerId)) {
          room.set(peerId, { ws: null, identity, nodeUrl: fromNode })
          peerNodeIndex.set(peerId, fromNode)
        }
      })
    })
    return
  }

  if (data.type === "_fed_peer_join") {
    const { roomId, peerId, identity, fromNode } = data
    if (!rooms.has(roomId)) rooms.set(roomId, new Map())
    const room = rooms.get(roomId)
    if (!room.has(peerId)) {
      room.set(peerId, { ws: null, identity, nodeUrl: fromNode })
      peerNodeIndex.set(peerId, fromNode)
      room.forEach(peer => { if (peer.ws?.readyState === 1) send(peer.ws, { type: "peer-join", peerId }) })
    }
    return
  }

  if (data.type === "_fed_peer_leave") {
    const { roomId, peerId } = data
    const room = rooms.get(roomId)
    if (!room) return
    room.delete(peerId)
    peerNodeIndex.delete(peerId)
    room.forEach(peer => { if (peer.ws?.readyState === 1) send(peer.ws, { type: "peer-leave", peerId }) })
    if (room.size === 0) rooms.delete(roomId)
    return
  }

  if (data.type === "_fed_signal") {
    const { roomId, from, to, identity, signal } = data
    const room = rooms.get(roomId)
    if (!room) return
    const target = room.get(to)
    if (target?.ws?.readyState === 1) send(target.ws, { type: "signal", from, identity, signal })
    return
  }

  if (data.type === "_fed_event" && data.roomId) {
    const room = rooms.get(data.roomId)
    if (!room) return
    const payload = JSON.stringify(data.event)
    room.forEach(peer => { if (peer.ws?.readyState === 1) peer.ws.send(payload) })
  }
}

// ─── FEDERATION CONNECTIONS ───────────────────────────────────────────────────

function handleFederationConnection(ws, req) {
  console.log(`[fed] inbound from ${req.socket.remoteAddress}`)
  ws.on("message", raw => {
    const data = safeJsonParse(raw)
    if (data) handleFederationMessage(data, ws)
  })
}

function federateSend(msg) {
  const payload = JSON.stringify(msg)
  federatedPeers.forEach(({ ws }) => { if (ws?.readyState === 1) ws.send(payload) })
}

function federateSendTo(nodeUrl, msg) {
  if (!nodeUrl) return
  const peer = federatedPeers.get(nodeUrl)
  if (peer?.ws?.readyState === 1) peer.ws.send(JSON.stringify(msg))
}

function federateBroadcast(raw, roomId) {
  const event = safeJsonParse(raw)
  if (!event) return
  const payload = JSON.stringify({ type: "_fed_event", roomId, event })
  federatedPeers.forEach(({ ws }) => { if (ws?.readyState === 1) ws.send(payload) })
}

// ─── PEER DIALING ─────────────────────────────────────────────────────────────

function dialPeer(peerUrl) {
  if (federatedPeers.get(peerUrl)?.ws?.readyState === 1) return

  const wsUrl = peerUrl.replace(/\/$/, "") + "?federation=1"
  let ws
  try { ws = new WebSocket(wsUrl) } catch (e) {
    console.warn(`[fed] could not dial ${peerUrl}: ${e.message}`)
    return
  }

  federatedPeers.set(peerUrl, { ws, status: "connecting" })

  ws.on("open", () => {
    console.log(`[fed] connected to ${peerUrl}`)
    federatedPeers.set(peerUrl, { ws, status: "connected" })
    knownPeerUrls.add(peerUrl)
    savePeers(knownPeerUrls)
    ws.send(JSON.stringify({ type: "_fed_announce", selfUrl: selfUrl() }))
  })

  ws.on("message", raw => {
    const data = safeJsonParse(raw)
    if (data) handleFederationMessage(data, ws)
  })

  ws.on("close", () => {
    console.log(`[fed] lost ${peerUrl}, retry in 15s`)
    federatedPeers.set(peerUrl, { ws: null, status: "disconnected" })
    setTimeout(() => dialPeer(peerUrl), 15_000)
  })

  ws.on("error", () => {}) // handled by close
}

// ─── LAN DISCOVERY ───────────────────────────────────────────────────────────

function startLANDiscovery() {
  import("dgram").then(({ createSocket }) => {
    const DPORT = 45678
    const MSG   = Buffer.from(JSON.stringify({ type: "trinity-hello", port: PORT, ip: getLocalIP() }))
    const sock  = createSocket({ type: "udp4", reuseAddr: true })

    sock.bind(DPORT, () => {
      sock.setBroadcast(true)
      try { sock.addMembership("224.0.0.251") } catch {}
    })

    sock.on("message", (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString())
        if (data.type !== "trinity-hello") return
        const url = `ws://${data.ip || rinfo.address}:${data.port}`
        if (url === selfUrl()) return
        knownPeerUrls.add(url)
        if (!federatedPeers.has(url)) {
          console.log(`[lan] found ${url}`)
          federatedPeers.set(url, { ws: null, status: "discovered" })
          dialPeer(url)
        }
      } catch {}
    })

    const announce = () => sock.send(MSG, 0, MSG.length, DPORT, "224.0.0.251")
    announce()
    setInterval(announce, PEER_ANNOUNCE_INTERVAL)
    console.log(`[lan] UDP discovery active on 224.0.0.251:${DPORT}`)
  }).catch(() => console.log("[lan] UDP unavailable"))
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getLocalIP() {
  const nets = networkInterfaces()
  for (const ifaces of Object.values(nets))
    for (const net of ifaces)
      if (net.family === "IPv4" && !net.internal) return net.address
  return "127.0.0.1"
}

// Public URL: env override → detected public IP → LAN IP
function selfUrl() {
  if (process.env.TRINITY_SELF) return process.env.TRINITY_SELF
  if (PUBLIC_IP) return `ws://${PUBLIC_IP}:${PORT}`
  return `ws://${getLocalIP()}:${PORT}`
}

function getSelfInfo() {
  const pub  = PUBLIC_IP || getLocalIP()
  return {
    ip:        pub,
    localIp:   getLocalIP(),
    port:      PORT,
    signalUrl: selfUrl(),
    chatUrl:   `http://${pub}:${PORT}`,
  }
}

function send(ws, data) { if (ws.readyState === 1) ws.send(JSON.stringify(data)) }

function respondJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(payload))
}

function sanitize(value) {
  if (typeof value !== "string") return null
  const v = value.trim()
  return v && v.length <= 128 ? v : null
}

function sanitizeIdentity(identity) {
  if (!identity || typeof identity !== "object") return null
  return {
    id:   typeof identity.id   === "string" ? identity.id.slice(0, 128)   : null,
    name: typeof identity.name === "string" ? identity.name.slice(0, 128) : null,
  }
}

function safeJsonParse(raw) {
  try { return JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) } catch { return null }
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────

// Detect public IP first, then start accepting connections
console.log("[boot] detecting public IP…")
detectPublicIP().then(ip => {
  if (ip) {
    PUBLIC_IP = ip
    console.log(`[boot] public IP: ${ip}`)
  } else {
    console.log(`[boot] public IP detection failed — using LAN IP ${getLocalIP()}`)
    console.log(`[boot] if peering across the internet, set TRINITY_SELF=ws://YOUR_PUBLIC_IP:${PORT}`)
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    const info = getSelfInfo()
    console.log("")
    console.log("┌──────────────────────────────────────────────────┐")
    console.log("│  Trinity Node v4 — sovereign mesh                │")
    console.log("├──────────────────────────────────────────────────┤")
    console.log(`│  Chat    : http://${info.ip}:${PORT}`.padEnd(51) + "│")
    console.log(`│  Signal  : ${info.signalUrl}`.padEnd(51) + "│")
    console.log(`│  Health  : http://${info.ip}:${PORT}/health`.padEnd(51) + "│")
    console.log(`│  Peers   : ${String(knownPeerUrls.size + " known")}`.padEnd(51) + "│")
    console.log("└──────────────────────────────────────────────────┘")
    console.log("")

    if (knownPeerUrls.size > 0) {
      console.log(`[boot] dialing ${knownPeerUrls.size} known peer(s)…`)
      knownPeerUrls.forEach(url => {
        if (url !== selfUrl()) {
          federatedPeers.set(url, { ws: null, status: "pending" })
          dialPeer(url)
        }
      })
    } else {
      console.log("[boot] no known peers — waiting for LAN discovery or TRINITY_PEERS")
    }

    startLANDiscovery()

    setInterval(() => {
      knownPeerUrls.forEach(url => { if (url !== selfUrl()) dialPeer(url) })
    }, PEER_ANNOUNCE_INTERVAL)
  })
})
