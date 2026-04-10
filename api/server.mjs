/**
 * G2 Relay REST API — x1scroll.io
 * HTTP wrapper around the G2 Relay on-chain program
 * 
 * Endpoints:
 *   GET  /g2/resolve/:handle         — resolve handle → pubkey + endpoint + CID
 *   POST /g2/register                — register a new handle
 *   POST /g2/send                    — relay a message
 *   POST /g2/cid                     — write CID to index
 *   GET  /g2/health                  — health check
 *   GET  /g2/fees                    — current fee schedule
 */

import http from 'http';
import { readFileSync } from 'fs';
import G2RelayClient, { FEES, MSG_TYPE } from '../sdk/g2-relay-sdk.mjs';

const PORT    = 3810;
const RPC_URL = 'http://104.250.159.138:8899';

// Relay keypair — signs server-side transactions
// In production: agents sign client-side, server just validates + routes
const RELAY_KEYPAIR_PATH = process.env.RELAY_KEYPAIR || '/root/.openclaw/workspace/memory/keys/stamp_agent.json';

const client = new G2RelayClient(RPC_URL);

// ─── Router ──────────────────────────────────────────────────────────────────

async function route(req, res) {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const path   = url.pathname;
  const method = req.method;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // GET /g2/health
    if (method === 'GET' && path === '/g2/health') {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok',
        program: '5aXXmvgFbT8rY1h2AzdG242w4EVStJYAz3nDKQ5bDGut',
        treasury: 'A1TRS3i2g62Zf6K4vybsW4JLx8wifqSoThyTQqXNaLDK',
        rpc: RPC_URL,
        ts: new Date().toISOString(),
      }));
      return;
    }

    // GET /g2/fees
    if (method === 'GET' && path === '/g2/fees') {
      res.writeHead(200);
      res.end(JSON.stringify({
        handle_registration: '0.001 XNT',
        message_relay:       '0.0001 XNT',
        channel_message:     '0.0003 XNT',
        push_delivery:       '0.0005 XNT',
        encrypted_channel:   '0.001 XNT',
        cid_write:           '0.0005 XNT',
        free_tier:           '10 messages on first registration',
        min_balance:         '0.01 XNT',
      }));
      return;
    }

    // GET /g2/resolve/:handle
    if (method === 'GET' && path.startsWith('/g2/resolve/')) {
      const handle = path.split('/g2/resolve/')[1];
      if (!handle) { res.writeHead(400); res.end(JSON.stringify({ error: 'Handle required' })); return; }

      const record = await client.resolveHandle(handle);
      if (!record) { res.writeHead(404); res.end(JSON.stringify({ error: 'Handle not found' })); return; }

      res.writeHead(200);
      res.end(JSON.stringify(record));
      return;
    }

    // POST /g2/register
    if (method === 'POST' && path === '/g2/register') {
      const body = await readBody(req);
      const { name, endpoint, keypair_path } = JSON.parse(body);
      if (!name || !endpoint) { res.writeHead(400); res.end(JSON.stringify({ error: 'name and endpoint required' })); return; }

      const kp = client.loadKeypair(keypair_path || RELAY_KEYPAIR_PATH);
      const result = await client.registerHandle(kp, name, endpoint);

      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        handle: name,
        pda: result.pda.toBase58(),
        tx: result.sig,
        fee: '0.001 XNT',
      }));
      return;
    }

    // POST /g2/cid
    if (method === 'POST' && path === '/g2/cid') {
      const body = await readBody(req);
      const { handle, cid, keypair_path } = JSON.parse(body);
      if (!handle || !cid) { res.writeHead(400); res.end(JSON.stringify({ error: 'handle and cid required' })); return; }

      const kp = client.loadKeypair(keypair_path || RELAY_KEYPAIR_PATH);
      const result = await client.writeCid(kp, handle, cid);

      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        handle,
        cid,
        tx: result.sig,
        fee: '0.0005 XNT',
      }));
      return;
    }

    // POST /g2/send
    if (method === 'POST' && path === '/g2/send') {
      const body = await readBody(req);
      const { from_handle, to_handle, payload_cid, msg_type = 0, keypair_path } = JSON.parse(body);
      if (!from_handle || !to_handle || !payload_cid) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'from_handle, to_handle, payload_cid required' }));
        return;
      }

      const kp = client.loadKeypair(keypair_path || RELAY_KEYPAIR_PATH);
      const result = await client.relayMessage(kp, from_handle, to_handle, payload_cid, msg_type);

      const feeMap = { 0: '0.0001', 1: '0.0003', 2: '0.0005', 3: '0.001' };
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        from: from_handle,
        to: to_handle,
        payload_cid,
        msg_type,
        tx: result.sig,
        fee: `${feeMap[msg_type]} XNT`,
      }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));

  } catch (err) {
    console.error('[G2 API]', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ─── Start ───────────────────────────────────────────────────────────────────

const server = http.createServer(route);
server.listen(PORT, () => {
  console.log(`[G2 Relay API] Running on port ${PORT}`);
  console.log(`[G2 Relay API] Program: 5aXXmvgFbT8rY1h2AzdG242w4EVStJYAz3nDKQ5bDGut`);
  console.log(`[G2 Relay API] RPC: ${RPC_URL}`);
  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /g2/health');
  console.log('  GET  /g2/fees');
  console.log('  GET  /g2/resolve/:handle');
  console.log('  POST /g2/register');
  console.log('  POST /g2/send');
  console.log('  POST /g2/cid');
});
