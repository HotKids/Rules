# Deploy

Run `./deploy.sh` from `Rules/snell-panel`. The script checks runtime tools, installs Bun dependencies, ensures Wrangler login, creates or reuses D1, writes `database_id`, applies remote migrations, configures secrets, builds the web app, deploys the Worker, and prints the Worker URL plus configuration status.
