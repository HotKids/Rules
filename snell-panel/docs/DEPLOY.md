# Deploy

Run `./deploy.sh` from the `snell-panel` directory. The script checks runtime tools, installs Bun dependencies, validates Cloudflare authentication with `wrangler whoami`, creates or reuses D1, writes `database_id`, applies remote migrations, builds and deploys the Worker, uploads secrets, deploys the final Worker version, runs a health check, and prints a masked deployment summary.

## Headless VPS login

For SSH-only servers, the recommended fully non-interactive path is to create a Cloudflare API token with Workers and D1 permissions, then run:

```bash
export CLOUDFLARE_API_TOKEN=<your-token>
./deploy.sh
```

If OAuth is used on a headless VPS, keep the SSH session open, copy Wrangler's authorization URL into your local browser, and follow Wrangler's callback prompt.

## Secrets

Generated or entered secrets are masked by default in the final summary. Use `./deploy.sh --show-secrets` only when you explicitly want the full values printed to the terminal.
