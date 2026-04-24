import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createThirdwebClient, defineChain } from "thirdweb";
import { ThirdwebProvider, ConnectButton, useActiveAccount } from "thirdweb/react";
import { signLoginPayload } from "thirdweb/auth";
import { inAppWallet, createWallet } from "thirdweb/wallets";

const BASE = window.location.origin;
const CLIENT_ID = "42e44fb49ce221f80be2eac65642c044";

const client = createThirdwebClient({ clientId: CLIENT_ID });
const etoChain = defineChain({
  id: 17743,
  name: "ETO Testnet",
  nativeCurrency: { name: "ETO", symbol: "ETO", decimals: 9 },
  rpc: "https://rpc.entropytoorder.xyz",
});
const wallets = [
  inAppWallet({ auth: { options: ["email", "google", "apple", "phone", "passkey"] } }),
  createWallet("io.metamask"),
  createWallet("com.coinbase.wallet"),
  createWallet("io.rabby"),
  createWallet("walletConnect"),
];

// Read OAuth state from URL — present when /authorize redirected here
const oauthState = new URLSearchParams(window.location.search).get("oauth_state");
const isOAuthMode = !!oauthState;

async function doAuth(account: any) {
  const payload = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: account.address, chainId: 17743 }),
  }).then((r) => r.json());
  if (payload.code) throw new Error(payload.message);
  const { signature } = await signLoginPayload({ account, payload });
  return { payload, signature };
}

function Inner() {
  const account = useActiveAccount();
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<{ token: string; exp: number } | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!account || done) return;
    setDone(true);
    setStatus("Signing in…");

    doAuth(account)
      .then(async ({ payload, signature }) => {
        if (isOAuthMode) {
          // OAuth mode: POST to /oauth-callback. The server returns
          // { location: "..." } (JSON, not 302) so we can navigate to any
          // scheme — fetch() can't follow redirects to cursor:// or vscode://.
          setStatus("Redirecting back to your MCP client…");
          const res = await fetch(`${BASE}/oauth-callback`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ payload, signature, oauth_state: oauthState }),
          });
          const body = await res.json().catch(() => null);
          if (!res.ok || !body?.location) {
            setStatus(`Redirect failed: ${body?.error ?? res.statusText}`);
            return;
          }
          window.location.href = body.location;
        } else {
          // Standalone mode: verify and show bearer token
          const r = await fetch(`${BASE}/auth/verify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ payload, signature, strategy: "siwe" }),
          }).then(async (r) => {
            const b = await r.json();
            if (!r.ok) throw new Error(b.message);
            return b;
          });
          setResult(r);
          setStatus("");
        }
      })
      .catch((e) => {
        setStatus(e.message);
        setDone(false); // allow retry
      });
  }, [account]);

  if (result) {
    const sseUrl = `${BASE}/sse`;
    const claudeCode = `claude mcp add singularity --transport sse \\\n  --header "Authorization: Bearer ${result.token}" \\\n  ${sseUrl}`;
    const jsonCfg = JSON.stringify({
      mcpServers: { singularity: { url: sseUrl, headers: { Authorization: `Bearer ${result.token}` } } },
    }, null, 2);

    return (
      <div className="token-card">
        <div className="ok-badge">✓ Authenticated</div>
        <div className="box">
          <div className="label">Bearer Token</div>
          <div className="mono">{result.token}</div>
          <div className="meta">Expires {new Date(result.exp * 1000).toLocaleString()}</div>
          <CopyBtn text={result.token} label="Copy token" />
        </div>
        <div className="cfg">
          <div className="cfg-head">Claude Code <CopyBtn text={claudeCode} label="copy" small /></div>
          <pre className="cfg-body">{claudeCode}</pre>
        </div>
        <div className="cfg">
          <div className="cfg-head">Claude Desktop / Cursor / Windsurf <CopyBtn text={jsonCfg} label="copy" small /></div>
          <pre className="cfg-body">{jsonCfg}</pre>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
      <ConnectButton
        client={client}
        wallets={wallets}
        chain={etoChain}
        theme="dark"
        connectModal={{ size: "compact", title: "Sign in to Singularity", titleIcon: "" }}
        connectButton={{ label: isOAuthMode ? "Connect to authorise" : "Connect to get started" }}
      />
      {status && <div className="status">{status}</div>}
    </div>
  );
}

function CopyBtn({ text, label, small }: { text: string; label: string; small?: boolean }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className={`copy-btn${small ? " small" : ""}${ok ? " ok" : ""}`}
      onClick={() => { navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 2000); }}
    >
      {ok ? "✓ Copied" : label}
    </button>
  );
}

function App() {
  return (
    <ThirdwebProvider>
      <div className="wordmark">Singularity</div>
      <div className="sub">
        {isOAuthMode ? "Connect your wallet to authorise your MCP client" : "MCP Server · ETO Chain"}
      </div>
      <Inner />
    </ThirdwebProvider>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
