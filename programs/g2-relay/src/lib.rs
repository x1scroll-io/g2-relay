use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("5aXXmvgFbT8rY1h2AzdG242w4EVStJYAz3nDKQ5bDGut"); // placeholder — replaced on deploy

// ─── Constants ───────────────────────────────────────────────────────────────
pub const TREASURY: &str = "A1TRS3i2g62Zf6K4vybsW4JLx8wifqSoThyTQqXNaLDK";

pub const FEE_HANDLE_REG:  u64 = 1_000;       // 0.001  XNT (lamports × 1000)
pub const FEE_MSG_RELAY:   u64 = 100;          // 0.0001 XNT
pub const FEE_CHANNEL_MSG: u64 = 300;          // 0.0003 XNT
pub const FEE_PUSH:        u64 = 500;          // 0.0005 XNT
pub const FEE_ENCRYPTED:   u64 = 1_000;        // 0.001  XNT
pub const FEE_CID_WRITE:   u64 = 500;          // 0.0005 XNT
pub const FREE_TIER_MSGS:  u8  = 10;           // 10 free messages on first reg
pub const MIN_BALANCE:     u64 = 10_000;       // 0.01 XNT minimum to activate

// XNT has 9 decimals like SOL — multiply by 1_000_000 for lamport equivalent
// e.g. 0.001 XNT = 1_000_000 lamports
// Keeping fees in micro-XNT units (×1000) for now — adjust on deploy

// ─── Program ─────────────────────────────────────────────────────────────────
#[program]
pub mod g2_relay {
    use super::*;

    /// Register a human-readable handle (e.g. "frankie5")
    /// Pays 0.001 XNT to treasury → mints HandleRecord PDA
    pub fn register_handle(
        ctx: Context<RegisterHandle>,
        name: String,
        endpoint: String,
    ) -> Result<()> {
        require!(name.len() >= 3 && name.len() <= 32, G2Error::InvalidHandle);
        require!(endpoint.len() <= 128, G2Error::EndpointTooLong);

        let handle = &mut ctx.accounts.handle_record;

        // First registration — check if free tier applies
        let fee = if handle.msg_count == 0 {
            FEE_HANDLE_REG
        } else {
            FEE_HANDLE_REG
        };

        // Transfer fee to treasury
        let cpi_ctx = CpiContext::new(
            system_program::ID,
            system_program::Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to:   ctx.accounts.treasury.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, fee)?;

        // Write handle record
        handle.owner    = ctx.accounts.payer.key();
        handle.name     = name;
        handle.endpoint = endpoint;
        handle.cid      = String::new();
        handle.msg_count = 0;
        handle.free_remaining = FREE_TIER_MSGS;
        handle.active   = true;
        handle.bump     = ctx.bumps.handle_record;
        handle.created_at = Clock::get()?.unix_timestamp;

        emit!(HandleRegistered {
            owner:    handle.owner,
            name:     handle.name.clone(),
            endpoint: handle.endpoint.clone(),
        });

        Ok(())
    }

    /// Write/update the agent's latest IPFS CID
    /// Pays 0.0005 XNT → updates CID on HandleRecord PDA
    pub fn write_cid(
        ctx: Context<WriteCid>,
        cid: String,
    ) -> Result<()> {
        require!(cid.len() >= 10 && cid.len() <= 64, G2Error::InvalidCid);
        require!(ctx.accounts.handle_record.active, G2Error::HandleInactive);

        // Transfer fee
        let cpi_ctx = CpiContext::new(
            system_program::ID,
            system_program::Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to:   ctx.accounts.treasury.to_account_info().clone(),
            },
        );
        system_program::transfer(cpi_ctx, FEE_CID_WRITE)?;

        ctx.accounts.handle_record.cid = cid.clone();

        emit!(CidUpdated {
            owner: ctx.accounts.payer.key(),
            cid,
        });

        Ok(())
    }

    /// Send a relay message — pays fee based on msg_type
    /// 0=standard, 1=channel, 2=push, 3=encrypted
    pub fn relay_message(
        ctx: Context<RelayMessage>,
        msg_type: u8,
        payload_cid: String,   // IPFS CID of message content
        recipient_handle: String,
    ) -> Result<()> {
        require!(payload_cid.len() >= 10 && payload_cid.len() <= 64, G2Error::InvalidCid);
        require!(recipient_handle.len() >= 3 && recipient_handle.len() <= 32, G2Error::InvalidHandle);

        let sender_record = &mut ctx.accounts.sender_record;

        // Check minimum balance
        require!(
            ctx.accounts.payer.lamports() >= MIN_BALANCE,
            G2Error::InsufficientBalance
        );

        // Determine fee — free tier check
        let fee = if sender_record.free_remaining > 0 {
            sender_record.free_remaining -= 1;
            0u64 // free
        } else {
            match msg_type {
                0 => FEE_MSG_RELAY,
                1 => FEE_CHANNEL_MSG,
                2 => FEE_PUSH,
                3 => FEE_ENCRYPTED,
                _ => return Err(G2Error::InvalidMsgType.into()),
            }
        };

        // Transfer fee if not free
        if fee > 0 {
            let cpi_ctx = CpiContext::new(
                system_program::ID,
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to:   ctx.accounts.treasury.to_account_info(),
                },
            );
            system_program::transfer(cpi_ctx, fee)?;
        }

        sender_record.msg_count += 1;

        emit!(MessageRelayed {
            sender:    ctx.accounts.payer.key(),
            recipient: recipient_handle,
            msg_type,
            payload_cid,
            fee,
            slot: Clock::get()?.slot,
        });

        Ok(())
    }
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(name: String)]
pub struct RegisterHandle<'info> {
    #[account(
        init,
        payer  = payer,
        space  = HandleRecord::SIZE,
        seeds  = [b"handle", name.as_bytes()],
        bump,
    )]
    pub handle_record: Account<'info, HandleRecord>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: treasury — verified by address
    #[account(mut, address = TREASURY.parse::<Pubkey>().unwrap())]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WriteCid<'info> {
    #[account(
        mut,
        has_one = owner,
    )]
    pub handle_record: Account<'info, HandleRecord>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub owner: Signer<'info>,

    /// CHECK: treasury
    #[account(mut, address = TREASURY.parse::<Pubkey>().unwrap())]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RelayMessage<'info> {
    #[account(mut, has_one = owner)]
    pub sender_record: Account<'info, HandleRecord>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub owner: Signer<'info>,

    /// CHECK: treasury
    #[account(mut, address = TREASURY.parse::<Pubkey>().unwrap())]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// ─── State ───────────────────────────────────────────────────────────────────

#[account]
pub struct HandleRecord {
    pub owner:          Pubkey,   // 32
    pub name:           String,   // 4 + 32
    pub endpoint:       String,   // 4 + 128
    pub cid:            String,   // 4 + 64
    pub msg_count:      u64,      // 8
    pub free_remaining: u8,       // 1
    pub active:         bool,     // 1
    pub bump:           u8,       // 1
    pub created_at:     i64,      // 8
}

impl HandleRecord {
    pub const SIZE: usize = 8    // discriminator
        + 32                     // owner
        + 4 + 32                 // name
        + 4 + 128                // endpoint
        + 4 + 64                 // cid
        + 8                      // msg_count
        + 1                      // free_remaining
        + 1                      // active
        + 1                      // bump
        + 8;                     // created_at
}

// ─── Events ──────────────────────────────────────────────────────────────────

#[event]
pub struct HandleRegistered {
    pub owner:    Pubkey,
    pub name:     String,
    pub endpoint: String,
}

#[event]
pub struct CidUpdated {
    pub owner: Pubkey,
    pub cid:   String,
}

#[event]
pub struct MessageRelayed {
    pub sender:      Pubkey,
    pub recipient:   String,
    pub msg_type:    u8,
    pub payload_cid: String,
    pub fee:         u64,
    pub slot:        u64,
}

// ─── Errors ──────────────────────────────────────────────────────────────────

#[error_code]
pub enum G2Error {
    #[msg("Handle must be 3-32 characters")]
    InvalidHandle,
    #[msg("Endpoint URL too long (max 128 chars)")]
    EndpointTooLong,
    #[msg("Invalid CID format")]
    InvalidCid,
    #[msg("Invalid message type (0-3)")]
    InvalidMsgType,
    #[msg("Handle is inactive")]
    HandleInactive,
    #[msg("Insufficient balance — minimum 0.01 XNT required")]
    InsufficientBalance,
}
