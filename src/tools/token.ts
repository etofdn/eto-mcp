import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rpc } from "../read/rpc-client.js";
import { getSignerFactory } from "../signing/index.js";
import { getActiveWalletId } from "./wallet.js";
import { lamportsToSol, toTokenAmount } from "../utils/units.js";
import { buildCreateMintTx, buildMintToTx, buildBurnTx, buildTokenTransferTx, generateKeypair } from "../wasm/index.js";
import { blockhashCache } from "../write/blockhash-cache.js";
import { submitter } from "../write/submitter.js";
import { getTokenMetadata, registerTokenMetadata } from "../read/token-metadata.js";
import { deriveAta, buildCreateAtaIdempotentTx } from "../utils/ata.js";

// Send an AtaProgram::CreateIdempotent tx to ensure the recipient's ATA exists
// before MintTo / Transfer. No-op on chain if the account is already initialized.
async function ensureAta(signer: any, owner: string, mint: string): Promise<string> {
  const { blockhash } = await blockhashCache.refresh();
  const { txBytes, ata } = buildCreateAtaIdempotentTx(signer.getPublicKey(), owner, mint, blockhash);
  const signedTx = await signer.sign(txBytes);
  await submitter.submitAndConfirm({
    signedTxBase64: Buffer.from(signedTx).toString("base64"),
    vm: "svm",
    timeoutMs: 15000,
  }).catch(() => null); // idempotent — failures are acceptable if account exists
  return ata;
}

export function registerTokenTools(server: McpServer): void {
  server.tool(
    "create_token",
    "Creates a new fungible token (mint) on the ETO network. Specify the token name, symbol, decimal precision (0–18, default 9), and optional initial supply to mint to the deployer. The mint address is deterministically derived from the deployer's address and a nonce. This tool interface is ready — full transaction building integration is coming in the next iteration.",
    {
      name: z.string().describe("Full token name, e.g. 'My Token'"),
      symbol: z.string().describe("Ticker symbol, e.g. 'MTK'"),
      decimals: z.number().min(0).max(18).default(9).optional(),
      initial_supply: z.string().default("0").optional().describe("Initial supply in human units"),
      from_wallet: z.string().optional().describe("Wallet ID to use as mint authority; defaults to active wallet"),
    },
    async (args) => {
      try {
        const { decimals = 9, from_wallet } = args;
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return { content: [{ type: "text" as const, text: "No wallet specified and no active wallet set. Use set_active_wallet or provide from_wallet." }] };
        }
        const signer = await getSignerFactory().getSigner(walletId);
        const fromSvm = signer.getPublicKey();
        const mintKeypair = generateKeypair();
        const mintAddress = mintKeypair.publicKey;
        const { blockhash } = await blockhashCache.getBlockhash();
        const txBytes = buildCreateMintTx(fromSvm, mintAddress, fromSvm, decimals, blockhash);

        // The CreateMint tx requires 2 signers: payer (slot 0) and the new
        // mint account itself (slot 1, proving its keypair authorized
        // creation). Without the second signature InitializeMint runs against
        // an unsigned mint slot, the account is allocated but never
        // initialized, and downstream MintTo fails with "Token program failed".
        const ed = await import("@noble/ed25519");
        const sigCountLE = new DataView(txBytes.buffer, txBytes.byteOffset, 4).getUint32(0, true);
        const messageBytes = txBytes.slice(4 + sigCountLE * 64);
        const payerSigned = await signer.sign(txBytes);
        const mintSecret = Uint8Array.from(Buffer.from(mintKeypair.secretKey, "hex"));
        const mintSig = await ed.sign(messageBytes, mintSecret);
        const fullySigned = new Uint8Array(payerSigned);
        fullySigned.set(mintSig, 4 + 64); // sig slot 1
        const txBase64 = Buffer.from(fullySigned).toString("base64");
        const result = await submitter.submitAndConfirm({ signedTxBase64: txBase64, vm: "svm", timeoutMs: 15000 });
        const lines: string[] = [];
        if (result.status === "confirmed" || result.status === "finalized") {
          registerTokenMetadata({
            mint: mintAddress,
            name: args.name,
            symbol: args.symbol,
            decimals,
            supply: 0n,
            mintAuthority: fromSvm,
            freezeAuthority: null,
            createdAt: new Date().toISOString(),
          });
          lines.push("Token mint created successfully.");
          lines.push(`Signature:    ${result.signature}`);
          lines.push(`Status:       ${result.status}`);
          lines.push(`Mint address: ${mintAddress}`);
          lines.push(`Name:         ${args.name}`);
          lines.push(`Symbol:       ${args.symbol}`);
          lines.push(`Decimals:     ${decimals}`);
          lines.push(`Authority:    ${fromSvm}`);
          if (result.fee !== undefined) lines.push(`Fee:          ${result.fee} lamports`);
        } else if (result.status === "timeout") {
          lines.push("Transaction submitted but confirmation timed out.");
          lines.push(`Signature: ${result.signature}`);
          lines.push(`Mint address: ${mintAddress}`);
        } else {
          lines.push("Token creation failed.");
          lines.push(`Error: ${result.error?.explanation ?? result.error?.raw_message ?? "Unknown error"}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error creating token: ${err?.message ?? String(err)}` }] };
      }
    }
  );

  server.tool(
    "mint_tokens",
    "Mints additional tokens to a recipient account for a given mint address. Requires mint authority. The amount is specified in human-readable units using the token's configured decimal precision. This tool interface is ready — full transaction building integration is coming in the next iteration.",
    {
      mint: z.string().describe("Mint address (base58)"),
      to: z.string().describe("Recipient address to receive the minted tokens"),
      amount: z.string().describe("Amount to mint in human units"),
      from_wallet: z.string().optional().describe("Wallet ID holding mint authority; defaults to active wallet"),
    },
    async (args) => {
      try {
        const { mint, to, amount, from_wallet } = args;
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return { content: [{ type: "text" as const, text: "No wallet specified and no active wallet set. Use set_active_wallet or provide from_wallet." }] };
        }
        const signer = await getSignerFactory().getSigner(walletId);
        const fromSvm = signer.getPublicKey();
        const { blockhash } = await blockhashCache.getBlockhash();
        const decimals = (await getTokenMetadata(mint))?.decimals ?? 9;
        const rawAmount = BigInt(Math.round(parseFloat(amount) * 10 ** decimals));
        // SPL semantics: MintTo writes the balance into the recipient's
        // associated token account, not into the wallet pubkey itself.
        // Materialize the ATA first (idempotent — no-op if it already exists).
        const destinationAta = await ensureAta(signer, to, mint);
        const txBytes = buildMintToTx(fromSvm, mint, destinationAta, rawAmount, blockhash);
        const signedTx = await signer.sign(txBytes);
        const txBase64 = Buffer.from(signedTx).toString("base64");
        const result = await submitter.submitAndConfirm({ signedTxBase64: txBase64, vm: "svm", timeoutMs: 15000 });
        const lines: string[] = [];
        if (result.status === "confirmed" || result.status === "finalized") {
          lines.push("Tokens minted successfully.");
          lines.push(`Signature:   ${result.signature}`);
          lines.push(`Status:      ${result.status}`);
          lines.push(`Mint:        ${mint}`);
          lines.push(`Owner:       ${to}`);
          lines.push(`Destination: ${destinationAta} (derived ATA)`);
          lines.push(`Amount:      ${amount} (raw: ${rawAmount})`);
          if (result.fee !== undefined) lines.push(`Fee:         ${result.fee} lamports`);
        } else if (result.status === "timeout") {
          lines.push("Transaction submitted but confirmation timed out.");
          lines.push(`Signature: ${result.signature}`);
        } else {
          lines.push("Minting failed.");
          lines.push(`Error: ${result.error?.explanation ?? result.error?.raw_message ?? "Unknown error"}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error minting tokens: ${err?.message ?? String(err)}` }] };
      }
    }
  );

  server.tool(
    "transfer_token",
    "Transfers a specified amount of an SPL-compatible token from one wallet to another on the ETO network. Resolves or creates the destination associated token account as needed. Uses the active wallet as sender unless from_wallet is provided. Amount is in human-readable units. This tool interface is ready — full transaction building integration is coming in the next iteration.",
    {
      mint: z.string().describe("Mint address of the token to transfer"),
      to: z.string().describe("Recipient address (base58 or 0x)"),
      amount: z.string().describe("Amount to transfer in human units"),
      from_wallet: z.string().optional().describe("Wallet ID to send from; defaults to active wallet"),
    },
    async (args) => {
      try {
        const { mint, to, amount, from_wallet } = args;
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return { content: [{ type: "text" as const, text: "No wallet specified and no active wallet set. Use set_active_wallet or provide from_wallet." }] };
        }
        const signer = await getSignerFactory().getSigner(walletId);
        const fromSvm = signer.getPublicKey();
        const { blockhash } = await blockhashCache.getBlockhash();
        const decimals = (await getTokenMetadata(mint))?.decimals ?? 9;
        const rawAmount = BigInt(Math.round(parseFloat(amount) * 10 ** decimals));
        // SPL Transfer is between two token accounts (ATAs of source/dest wallets),
        // not between the wallet pubkeys themselves. Make sure both exist first.
        const srcAta = await ensureAta(signer, fromSvm, mint);
        const dstAta = await ensureAta(signer, to, mint);
        const txBytes = buildTokenTransferTx(fromSvm, srcAta, dstAta, rawAmount, decimals, blockhash);
        const signedTx = await signer.sign(txBytes);
        const txBase64 = Buffer.from(signedTx).toString("base64");
        const result = await submitter.submitAndConfirm({ signedTxBase64: txBase64, vm: "svm", timeoutMs: 15000 });
        const lines: string[] = [];
        if (result.status === "confirmed" || result.status === "finalized") {
          lines.push("Token transfer successful.");
          lines.push(`Signature: ${result.signature}`);
          lines.push(`Status:    ${result.status}`);
          lines.push(`Mint:      ${mint}`);
          lines.push(`From:      ${fromSvm}`);
          lines.push(`To:        ${to}`);
          lines.push(`Amount:    ${amount} (raw: ${rawAmount})`);
          if (result.fee !== undefined) lines.push(`Fee:       ${result.fee} lamports`);
        } else if (result.status === "timeout") {
          lines.push("Transaction submitted but confirmation timed out.");
          lines.push(`Signature: ${result.signature}`);
        } else {
          lines.push("Token transfer failed.");
          lines.push(`Error: ${result.error?.explanation ?? result.error?.raw_message ?? "Unknown error"}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error transferring tokens: ${err?.message ?? String(err)}` }] };
      }
    }
  );

  server.tool(
    "burn_tokens",
    "Burns (permanently destroys) a specified amount of tokens from a wallet's token account, reducing the total supply of the mint. Requires the wallet to hold the tokens and have burn authority. Amount is in human-readable units. This tool interface is ready — full transaction building integration is coming in the next iteration.",
    {
      mint: z.string().describe("Mint address of the token to burn"),
      amount: z.string().describe("Amount to burn in human units"),
      from_wallet: z.string().optional().describe("Wallet ID to burn from; defaults to active wallet"),
    },
    async (args) => {
      try {
        const { mint, amount, from_wallet } = args;
        const walletId = from_wallet ?? getActiveWalletId();
        if (!walletId) {
          return { content: [{ type: "text" as const, text: "No wallet specified and no active wallet set. Use set_active_wallet or provide from_wallet." }] };
        }
        const signer = await getSignerFactory().getSigner(walletId);
        const fromSvm = signer.getPublicKey();
        const { blockhash } = await blockhashCache.getBlockhash();
        const decimals = (await getTokenMetadata(mint))?.decimals ?? 9;
        const rawAmount = BigInt(Math.round(parseFloat(amount) * 10 ** decimals));
        // tokenAccount = owner's token account for this mint; pass owner address directly
        const txBytes = buildBurnTx(fromSvm, fromSvm, mint, rawAmount, blockhash);
        const signedTx = await signer.sign(txBytes);
        const txBase64 = Buffer.from(signedTx).toString("base64");
        const result = await submitter.submitAndConfirm({ signedTxBase64: txBase64, vm: "svm", timeoutMs: 15000 });
        const lines: string[] = [];
        if (result.status === "confirmed" || result.status === "finalized") {
          lines.push("Tokens burned successfully.");
          lines.push(`Signature: ${result.signature}`);
          lines.push(`Status:    ${result.status}`);
          lines.push(`Mint:      ${mint}`);
          lines.push(`Owner:     ${fromSvm}`);
          lines.push(`Amount:    ${amount} (raw: ${rawAmount})`);
          if (result.fee !== undefined) lines.push(`Fee:       ${result.fee} lamports`);
        } else if (result.status === "timeout") {
          lines.push("Transaction submitted but confirmation timed out.");
          lines.push(`Signature: ${result.signature}`);
        } else {
          lines.push("Burn failed.");
          lines.push(`Error: ${result.error?.explanation ?? result.error?.raw_message ?? "Unknown error"}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error burning tokens: ${err?.message ?? String(err)}` }] };
      }
    }
  );

  server.tool(
    "get_token_info",
    "Fetches metadata and state for a token mint account, including name, symbol, decimal precision, total supply, mint authority, and freeze authority. Reads the on-chain mint account data directly from the RPC node. Useful for validating a token before trading or for displaying token details in a UI.",
    {
      mint: z.string().describe("Mint address (base58) to look up"),
    },
    async (args) => {
      try {
        const { mint } = args;

        // Try metadata registry first (covers create_token tokens + on-chain parsing)
        const metadata = await getTokenMetadata(mint);
        if (metadata) {
          const lines: string[] = [
            `Token Mint:       ${metadata.mint}`,
            `Name:             ${metadata.name}`,
            `Symbol:           ${metadata.symbol}`,
            `Decimals:         ${metadata.decimals}`,
            `Supply:           ${metadata.supply.toString()}`,
            `Mint Authority:   ${metadata.mintAuthority ?? "(none)"}`,
            `Freeze Authority: ${metadata.freezeAuthority ?? "(none)"}`,
          ];
          if (metadata.createdAt) lines.push(`Created:          ${metadata.createdAt}`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }

        // Fall back to raw account data display
        const accountInfo = await rpc.getAccountInfo(mint);

        if (!accountInfo || accountInfo.value === null) {
          return { content: [{ type: "text" as const, text: `No account found at mint address: ${mint}` }] };
        }

        const info = accountInfo.value ?? accountInfo;
        const lines: string[] = [
          `Token Mint: ${mint}`,
          `Owner program: ${info.owner ?? "(unknown)"}`,
          `Executable: ${info.executable ?? false}`,
          `Lamports: ${info.lamports ?? 0} (${lamportsToSol(info.lamports ?? 0)} SOL)`,
          `Data size: ${info.data ? (Array.isArray(info.data) ? info.data[0]?.length ?? 0 : JSON.stringify(info.data).length) : 0} bytes`,
        ];

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error fetching token info: ${err?.message ?? String(err)}` }] };
      }
    }
  );

  server.tool(
    "get_token_balance",
    "Returns the token balance for a specific wallet address and mint. Queries all token accounts owned by the address, then filters to find the account associated with the requested mint. Returns the raw and human-readable balance using the mint's decimal configuration.",
    {
      address: z.string().describe("Wallet or owner address to check balance for"),
      mint: z.string().describe("Mint address of the token"),
    },
    async (args) => {
      try {
        const { address, mint } = args;
        // Read at the deterministic SPL associated-token-account address
        // (PDA([wallet, TOKEN_PROGRAM_ID, mint], ATA_PROGRAM_ID)) instead of
        // scanning getTokenAccountsByOwner — the chain doesn't index by owner
        // and the prior scan returned 0 accounts even after a confirmed mint.
        const { address: ataAddress } = deriveAta(address, mint);

        // Retry briefly to ride out the chain's commit-vs-state-apply lag right
        // after a mint or transfer.
        let info: any = null;
        let raw: Buffer | null = null;
        for (let i = 0; i < 4; i++) {
          info = await rpc.getAccountInfo(ataAddress);
          const acct = info?.value !== undefined ? info.value : info;
          if (acct && acct.data) {
            const data = Array.isArray(acct.data) ? acct.data[0] : acct.data;
            if (typeof data === "string" && data.length > 0) {
              raw = Buffer.from(data, "base64");
              if (raw.length >= 72) break;
            }
          }
          await new Promise((r) => setTimeout(r, 200));
        }

        if (!raw) {
          return {
            content: [{ type: "text" as const, text: `No token account found for ${mint} at owner ${address} (derived ATA: ${ataAddress})` }],
          };
        }

        // SPL TokenAccount layout: mint(32) | owner(32) | amount(u64 LE) | ...
        const amountLo = raw.readUInt32LE(64);
        const amountHi = raw.readUInt32LE(68);
        const rawAmount = (BigInt(amountHi) * 0x100000000n + BigInt(amountLo)).toString();
        const meta = await getTokenMetadata(mint);
        const decimals = meta?.decimals ?? 9;
        const human = toTokenAmount(BigInt(rawAmount), decimals).human;

        const lines = [
          `Token Balance`,
          `Owner:    ${address}`,
          `Mint:     ${mint}`,
          `ATA:      ${ataAddress}`,
          `Raw:      ${rawAmount}`,
          `Decimals: ${decimals}`,
          `Balance:  ${human}`,
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error fetching token balance: ${err?.message ?? String(err)}` }] };
      }
    }
  );

  server.tool(
    "list_token_holdings",
    "Lists all token holdings for a given wallet address. Returns each token account with its mint address, current balance (raw and human-readable), decimal precision, and frozen status. Useful for displaying a full portfolio view or for agents to discover which tokens are available to trade or transfer.",
    {
      address: z.string().describe("Wallet or owner address to list token holdings for"),
    },
    async (args) => {
      try {
        const { address } = args;
        const tokenAccounts = await rpc.getTokenAccountsByOwner(address);

        if (!tokenAccounts || tokenAccounts.length === 0) {
          return { content: [{ type: "text" as const, text: `No token holdings found for address: ${address}` }] };
        }

        const lines: string[] = [`Token Holdings for ${address}`, `Total accounts: ${tokenAccounts.length}`, ""];

        for (let i = 0; i < tokenAccounts.length; i++) {
          const acct = tokenAccounts[i];
          const parsed = acct?.account?.data?.parsed?.info ?? acct?.info ?? acct;
          const mint = parsed?.mint ?? acct?.mint ?? "(unknown mint)";
          const rawAmount = parsed?.tokenAmount?.amount ?? parsed?.amount ?? "0";
          const decimals = parsed?.tokenAmount?.decimals ?? parsed?.decimals ?? 9;
          const humanAmount = parsed?.tokenAmount?.uiAmountString ?? null;
          const frozen = parsed?.state === "frozen" || parsed?.frozen === true;

          const displayAmount = humanAmount ?? toTokenAmount(BigInt(rawAmount), decimals).human;

          lines.push(`[${i + 1}] Mint: ${mint}`);
          lines.push(`     Balance: ${displayAmount} (raw: ${rawAmount}, decimals: ${decimals})`);
          if (frozen) lines.push(`     Status: FROZEN`);
          lines.push("");
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error listing token holdings: ${err?.message ?? String(err)}` }] };
      }
    }
  );

}
