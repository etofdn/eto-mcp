import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSignerFactory } from "../signing/index.js";
import { localSignerFactory } from "../signing/local-signer.js";
import { rpc } from "../read/rpc-client.js";
import { resolveAddresses } from "../utils/address.js";
import { lamportsToSol } from "../utils/units.js";

let activeWalletId: string | null = null;

export function getActiveWalletId(): string | null {
  return activeWalletId;
}

export function registerWalletTools(server: McpServer): void {
  server.tool(
    "create_wallet",
    "Creates a new wallet keypair on the ETO network. Generates a fresh Ed25519 keypair and returns both the SVM (base58) and EVM (0x-prefixed) addresses derived from the same key. The wallet is stored in memory for this session and can be used immediately for signing transactions. Optionally accepts a network parameter to tag the wallet with the intended network context.",
    {
      label: z.string().describe("Human-readable label for the wallet e.g. 'Treasury'"),
      network: z.enum(["mainnet", "testnet", "devnet"]).default("testnet").optional(),
    },
    async (args) => {
      try {
        const { label, network = "testnet" } = args;
        const result = await getSignerFactory().createWallet(label);
        const text = [
          "Wallet created successfully.",
          `Wallet ID: ${result.walletId}`,
          `Label:     ${label}`,
          `Network:   ${network}`,
          `SVM Address (base58): ${result.svmAddress}`,
          `EVM Address (0x):     ${result.evmAddress}`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error creating wallet: ${err?.message ?? String(err)}` }] };
      }
    }
  );

  server.tool(
    "import_wallet",
    "Imports an existing wallet into the ETO MCP server using a raw Ed25519 private key (hex-encoded) or a BIP-39 mnemonic phrase. For ed25519_secret key type, provide the 32-byte private key as a 64-character hex string (with or without 0x prefix). Mnemonic import is planned for a future iteration. Returns both SVM and EVM addresses on success.",
    {
      key_type: z.enum(["ed25519_secret", "mnemonic"]),
      key_material: z.string().describe("Private key as 64-char hex string, or mnemonic phrase"),
      label: z.string().describe("Human-readable label for this wallet"),
    },
    async (args) => {
      try {
        const { key_type, key_material, label } = args;

        if (key_type === "mnemonic") {
          return {
            content: [{ type: "text" as const, text: "Mnemonic import not yet supported. Please provide an ed25519_secret (hex-encoded 32-byte private key) instead." }],
          };
        }

        const result = localSignerFactory.importWallet(label, key_material);
        const text = [
          "Wallet imported successfully.",
          `Wallet ID: ${result.walletId}`,
          `Label:     ${label}`,
          `SVM Address (base58): ${result.svmAddress}`,
          `EVM Address (0x):     ${result.evmAddress}`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error importing wallet: ${err?.message ?? String(err)}` }] };
      }
    }
  );

  server.tool(
    "list_wallets",
    "Lists all wallets currently loaded in this MCP server session. For each wallet, shows its ID, label, SVM address, and EVM address. When include_balances is true (the default), also fetches the current native SOL balance for each wallet from the RPC node. Useful for an agent to discover which wallets are available before initiating transactions.",
    {
      include_balances: z.boolean().default(true).optional(),
    },
    async (args) => {
      try {
        const { include_balances = true } = args;
        const factory = getSignerFactory();
        const walletIds = await factory.listWallets();

        if (walletIds.length === 0) {
          return { content: [{ type: "text" as const, text: "No wallets found. Use create_wallet or import_wallet to add one." }] };
        }

        const lines: string[] = [`Found ${walletIds.length} wallet(s):\n`];

        for (const walletId of walletIds) {
          try {
            const signer = await factory.getSigner(walletId);
            const svmAddress = signer.getPublicKey();
            const evmAddress = signer.getEvmAddress();
            const isActive = walletId === activeWalletId;

            lines.push(`${isActive ? "[ACTIVE] " : ""}Wallet: ${walletId}`);
            lines.push(`  SVM: ${svmAddress}`);
            lines.push(`  EVM: ${evmAddress}`);

            if (include_balances) {
              try {
                const balanceResult = await rpc.getBalance(svmAddress);
                const sol = lamportsToSol(balanceResult.value);
                lines.push(`  Balance: ${sol} SOL (${balanceResult.value} lamports)`);
              } catch {
                lines.push(`  Balance: (unavailable)`);
              }
            }

            lines.push("");
          } catch {
            lines.push(`Wallet: ${walletId} (error loading signer)\n`);
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error listing wallets: ${err?.message ?? String(err)}` }] };
      }
    }
  );

  server.tool(
    "get_wallet",
    "Retrieves detailed information for a specific wallet by its ID. Returns the wallet ID, both SVM (base58) and EVM (0x-prefixed) addresses, and the current native balance fetched live from the RPC node. Use this to inspect a wallet's state before constructing a transaction or to verify an import was successful.",
    {
      wallet_id: z.string().describe("Wallet ID (UUID) or SVM address"),
    },
    async (args) => {
      try {
        const { wallet_id } = args;
        const factory = getSignerFactory();
        const signer = await factory.getSigner(wallet_id);
        const svmAddress = signer.getPublicKey();
        const evmAddress = signer.getEvmAddress();
        const isActive = wallet_id === activeWalletId;

        let balanceLine = "  Balance: (unavailable)";
        try {
          const balanceResult = await rpc.getBalance(svmAddress);
          const sol = lamportsToSol(balanceResult.value);
          balanceLine = `  Balance: ${sol} SOL (${balanceResult.value} lamports)`;
        } catch {
          // leave default
        }

        const text = [
          `Wallet ID: ${wallet_id}`,
          `Active:    ${isActive}`,
          `SVM Address (base58): ${svmAddress}`,
          `EVM Address (0x):     ${evmAddress}`,
          balanceLine,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error getting wallet: ${err?.message ?? String(err)}` }] };
      }
    }
  );

  server.tool(
    "set_active_wallet",
    "Sets the active wallet for this session. The active wallet is used as the default signer when other tools (transfer_native, token operations, etc.) are called without explicitly specifying a from_wallet parameter. Only one wallet can be active at a time; calling this tool replaces any previously active wallet. Returns a confirmation message with the newly active wallet's addresses.",
    {
      wallet_id: z.string().describe("Wallet ID to set as active"),
    },
    async (args) => {
      try {
        const { wallet_id } = args;
        const factory = getSignerFactory();
        const signer = await factory.getSigner(wallet_id);
        const svmAddress = signer.getPublicKey();
        const evmAddress = signer.getEvmAddress();

        activeWalletId = wallet_id;

        const text = [
          `Active wallet set to: ${wallet_id}`,
          `SVM Address: ${svmAddress}`,
          `EVM Address: ${evmAddress}`,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error setting active wallet: ${err?.message ?? String(err)}` }] };
      }
    }
  );

  server.tool(
    "derive_address",
    "Derives the SVM and EVM addresses for a given wallet without fetching on-chain state. Returns both the base58-encoded SVM address and the 0x-prefixed EVM address derived from the same Ed25519 public key. Optionally filter the output to a specific VM format. Useful for address book lookups, pre-flight checks, and cross-VM routing decisions.",
    {
      wallet_id: z.string().describe("Wallet ID to derive addresses for"),
      vm: z.enum(["svm", "evm"]).optional().describe("If specified, only return this VM's address"),
    },
    async (args) => {
      try {
        const { wallet_id, vm } = args;
        const factory = getSignerFactory();
        const signer = await factory.getSigner(wallet_id);
        const svmAddress = signer.getPublicKey();
        const addresses = resolveAddresses(svmAddress);

        const lines: string[] = [`Wallet ID: ${wallet_id}`];

        if (!vm || vm === "svm") {
          lines.push(`SVM Address (base58): ${addresses.svm}`);
        }
        if (!vm || vm === "evm") {
          lines.push(`EVM Address (0x):     ${addresses.evm}`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error deriving address: ${err?.message ?? String(err)}` }] };
      }
    }
  );
}
