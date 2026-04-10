/**
 * G2 Relay — Test: Register Frankie5 handle
 * Run: node test-register.mjs
 */

import G2RelayClient, { MSG_TYPE } from './g2-relay-sdk.mjs';

const client = new G2RelayClient('http://104.250.159.138:8899');
const kp = client.loadKeypair('/root/.openclaw/workspace/memory/keys/stamp_agent.json');

console.log('=== G2 Relay SDK Test ===');
console.log(`Wallet: ${kp.publicKey.toBase58()}`);
console.log(`Balance: ${await client.getBalance(kp)} XNT`);
console.log('');

// 1. Check if handle already exists
console.log('--- Checking existing handle ---');
const existing = await client.resolveHandle('frankie5');
if (existing) {
  console.log('Handle frankie5 already registered:');
  console.log(existing);
} else {
  console.log('Handle not found — registering...');
  
  // 2. Register handle
  const { sig, pda } = await client.registerHandle(
    kp,
    'frankie5',
    'https://x1scroll.io/g2/frankie5'
  );
  
  console.log('');
  console.log('--- Verifying registration ---');
  const record = await client.resolveHandle('frankie5');
  console.log(record);
}

console.log('');
console.log('=== DONE ===');
