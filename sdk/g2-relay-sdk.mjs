/**
 * G2 Relay SDK — x1scroll.io
 * Agent communication network on X1 blockchain
 * 
 * Program:  5aXXmvgFbT8rY1h2AzdG242w4EVStJYAz3nDKQ5bDGut
 * Treasury: A1TRS3i2g62Zf6K4vybsW4JLx8wifqSoThyTQqXNaLDK
 * Chain:    X1 Mainnet
 */

import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram, sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { readFileSync } from 'fs';
import * as borsh from '@coral-xyz/anchor';

// ─── Config ──────────────────────────────────────────────────────────────────

export const PROGRAM_ID  = new PublicKey('5aXXmvgFbT8rY1h2AzdG242w4EVStJYAz3nDKQ5bDGut');
export const TREASURY    = new PublicKey('A1TRS3i2g62Zf6K4vybsW4JLx8wifqSoThyTQqXNaLDK');
export const DEFAULT_RPC = 'http://104.250.159.138:8899';

// Fees (in lamports — XNT has 9 decimals like SOL)
export const FEES = {
  HANDLE_REG:  1_000_000,    // 0.001 XNT
  CID_WRITE:     500_000,    // 0.0005 XNT
  MSG_RELAY:     100_000,    // 0.0001 XNT
  MSG_CHANNEL:   300_000,    // 0.0003 XNT
  MSG_PUSH:      500_000,    // 0.0005 XNT
  MSG_ENCRYPTED: 1_000_000,  // 0.001 XNT
  MIN_BALANCE:  10_000_000,  // 0.01 XNT
};

export const MSG_TYPE = {
  STANDARD:  0,
  CHANNEL:   1,
  PUSH:      2,
  ENCRYPTED: 3,
};

// ─── G2RelayClient ────────────────────────────────────────────────────────────

export class G2RelayClient {
  constructor(rpcUrl = DEFAULT_RPC) {
    this.conn = new Connection(rpcUrl, 'confirmed');
  }

  // Load keypair from file
  loadKeypair(path) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(path)))
    );
  }

  // Derive handle PDA
  deriveHandlePda(name) {
    const [pda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('handle'), Buffer.from(name)],
      PROGRAM_ID
    );
    return { pda, bump };
  }

  // ── register_handle ────────────────────────────────────────────────────────
  async registerHandle(keypair, name, endpoint) {
    console.log(`[G2] Registering handle: ${name}`);
    console.log(`[G2] Endpoint: ${endpoint}`);
    console.log(`[G2] Fee: 0.001 XNT`);

    const { pda } = this.deriveHandlePda(name);

    // Encode instruction: discriminator + name + endpoint
    const nameBytes    = Buffer.from(name);
    const endpointBytes = Buffer.from(endpoint);
    
    const data = Buffer.concat([
      Buffer.from([15, 173, 21, 158, 125, 204, 221, 29]), // register_handle discriminator
      Buffer.from([nameBytes.length, 0, 0, 0]),
      nameBytes,
      Buffer.from([endpointBytes.length, 0, 0, 0]),
      endpointBytes,
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: pda,                   isSigner: false, isWritable: true  },
        { pubkey: keypair.publicKey,     isSigner: true,  isWritable: true  },
        { pubkey: TREASURY,              isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(this.conn, tx, [keypair]);
    console.log(`[G2] ✅ Handle registered — TX: ${sig}`);
    console.log(`[G2] PDA: ${pda.toBase58()}`);
    return { sig, pda };
  }

  // ── write_cid ──────────────────────────────────────────────────────────────
  async writeCid(keypair, handleName, cid) {
    console.log(`[G2] Writing CID for handle: ${handleName}`);
    console.log(`[G2] CID: ${cid}`);
    console.log(`[G2] Fee: 0.0005 XNT`);

    const { pda } = this.deriveHandlePda(handleName);
    const cidBytes = Buffer.from(cid);

    const data = Buffer.concat([
      Buffer.from([238, 86, 51, 237, 25, 19, 26, 225]), // write_cid discriminator
      Buffer.from([cidBytes.length, 0, 0, 0]),
      cidBytes,
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: pda,               isSigner: false, isWritable: true  },
        { pubkey: keypair.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: keypair.publicKey, isSigner: true,  isWritable: false }, // owner
        { pubkey: TREASURY,          isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(this.conn, tx, [keypair]);
    console.log(`[G2] ✅ CID written — TX: ${sig}`);
    return { sig, pda };
  }

  // ── relay_message ──────────────────────────────────────────────────────────
  async relayMessage(keypair, handleName, recipientHandle, payloadCid, msgType = MSG_TYPE.STANDARD) {
    const typeLabel = Object.keys(MSG_TYPE).find(k => MSG_TYPE[k] === msgType);
    const fee = Object.values(FEES)[msgType + 2] / LAMPORTS_PER_SOL;
    console.log(`[G2] Relaying ${typeLabel} message → ${recipientHandle}`);
    console.log(`[G2] Payload CID: ${payloadCid}`);
    console.log(`[G2] Fee: ${fee} XNT`);

    // Check balance
    const balance = await this.conn.getBalance(keypair.publicKey);
    if (balance < FEES.MIN_BALANCE) {
      throw new Error(`Insufficient balance. Min 0.01 XNT required. Current: ${balance / LAMPORTS_PER_SOL} XNT`);
    }

    const { pda } = this.deriveHandlePda(handleName);
    const cidBytes       = Buffer.from(payloadCid);
    const recipientBytes = Buffer.from(recipientHandle);

    const data = Buffer.concat([
      Buffer.from([187, 90, 182, 138, 51, 248, 175, 98]), // relay_message discriminator
      Buffer.from([msgType]),
      Buffer.from([cidBytes.length, 0, 0, 0]),
      cidBytes,
      Buffer.from([recipientBytes.length, 0, 0, 0]),
      recipientBytes,
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: pda,               isSigner: false, isWritable: true  },
        { pubkey: keypair.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: keypair.publicKey, isSigner: true,  isWritable: false },
        { pubkey: TREASURY,          isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(this.conn, tx, [keypair]);
    console.log(`[G2] ✅ Message relayed — TX: ${sig}`);
    return { sig };
  }

  // ── resolve_handle (read-only) ─────────────────────────────────────────────
  async resolveHandle(name) {
    const { pda } = this.deriveHandlePda(name);
    const account = await this.conn.getAccountInfo(pda);
    if (!account) return null;

    // Parse HandleRecord — skip 8 byte discriminator
    const data = account.data.slice(8);
    let offset = 0;

    const owner = new PublicKey(data.slice(offset, offset + 32));
    offset += 32;

    const nameLen = data.readUInt32LE(offset); offset += 4;
    const handleName = data.slice(offset, offset + nameLen).toString(); offset += nameLen;

    const endpointLen = data.readUInt32LE(offset); offset += 4;
    const endpoint = data.slice(offset, offset + endpointLen).toString(); offset += endpointLen;

    const cidLen = data.readUInt32LE(offset); offset += 4;
    const cid = data.slice(offset, offset + cidLen).toString(); offset += cidLen;

    const msgCount = data.readBigUInt64LE(offset); offset += 8;
    const freeRemaining = data[offset]; offset += 1;
    const active = data[offset] === 1;

    return { owner: owner.toBase58(), name: handleName, endpoint, cid, msgCount: Number(msgCount), freeRemaining, active, pda: pda.toBase58() };
  }

  // ── balance check ──────────────────────────────────────────────────────────
  async getBalance(pubkeyOrKeypair) {
    const pk = pubkeyOrKeypair instanceof Keypair ? pubkeyOrKeypair.publicKey : pubkeyOrKeypair;
    const lamports = await this.conn.getBalance(pk);
    return lamports / LAMPORTS_PER_SOL;
  }
}

export default G2RelayClient;
