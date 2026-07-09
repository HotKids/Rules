# Security

`ACCESS_TOKEN` is for panel login and management APIs. `API_TOKEN` remains server-side only. Provisioning uses short-lived, hashed, single-use node-scoped tokens. Manual secret input is hidden; pressing Enter in deploy flows can generate strong random tokens.
