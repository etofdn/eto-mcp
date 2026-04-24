# Fly staging and production deploys

This repo uses GitHub Actions to mirror the Vercel-style flow:

1. Every PR runs CI.
2. Internal PRs deploy `eto-mcp-staging`, then run remote QA against staging.
3. Pushes to `master` or `main` deploy staging first, run staging QA, then deploy production and run production QA.
4. The `production` GitHub Environment can be protected in repo settings if manual approval is needed before production deploys.

## Fly apps

Production uses `fly.toml`:

```bash
fly apps create eto-mcp
fly volumes create eto_wallets --app eto-mcp --region sjc --size 1
```

Staging uses `fly.staging.toml`:

```bash
fly apps create eto-mcp-staging
fly volumes create eto_wallets_staging --app eto-mcp-staging --region sjc --size 1
```

Set app secrets separately for each app. At minimum both apps need:

```bash
fly secrets set --app eto-mcp-staging \
  THIRDWEB_CLIENT_ID=... \
  THIRDWEB_SECRET_KEY=... \
  SESSION_SIGNING_KEY=... \
  ETO_WALLET_PASSPHRASE=... \
  ETO_RPC_URL=... \
  ETO_WS_URL=...

fly secrets set --app eto-mcp \
  THIRDWEB_CLIENT_ID=... \
  THIRDWEB_SECRET_KEY=... \
  SESSION_SIGNING_KEY=... \
  ETO_WALLET_PASSPHRASE=... \
  ETO_RPC_URL=... \
  ETO_WS_URL=...
```

Production `ISSUER_URL` is supplied by CI from `ETO_MCP_PROD_URL`, defaulting to `https://eto-mcp.fly.dev`. If production uses the custom domain, set this GitHub Actions repository variable:

```text
ETO_MCP_PROD_URL=https://mcp.entropytoorder.xyz
```

## GitHub setup

Add repository secret:

```text
FLY_API_TOKEN=<Fly deploy token>
```

Recommended GitHub Environments:

```text
staging
production
```

For Vercel-like production safety, configure the `production` environment with required reviewers and required status checks in GitHub settings. The workflow already prevents production from running until staging deploy and remote QA pass.

## Remote QA

The workflow calls:

```bash
bash scripts/qa-remote.sh https://eto-mcp-staging.fly.dev
bash scripts/qa-remote.sh https://eto-mcp.fly.dev
```

The QA script checks `/health`, OAuth metadata, `/login`, unauthenticated `/sse` OAuth challenge, and unauthenticated `/message` OAuth challenge.
