# Backend scaffold

This is a small, replaceable reference adapter for the first Creator slice. It uses
only Node's built-in modules so the current machine needs no package installation.
The application services depend on repository/authentication ports; this does not
select Node, a database, or a deployment model as the final product stack.

The server binds to `127.0.0.1` only. It refuses to start without an explicitly
configured bearer token and owner ID. Runtime media and state are stored under the
ignored local data directory. No external network client, LLM, SNS publisher, or
analytics integration is included.

The `.env.example` file is a template and is not loaded automatically. Set the values
in the shell or an approved local secret mechanism. Do not commit a populated `.env`.

For a local PowerShell session, create a temporary secret and start the server with:

```powershell
$env:HAEJUMI_BEARER_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:HAEJUMI_OWNER_ID = "local-owner"
npm start
```

The token is ephemeral for that shell session. This single-owner development bearer
mechanism is not the approved production authentication design.

See `backend/src/ports` and `backend/src/application` for replaceable boundaries.
