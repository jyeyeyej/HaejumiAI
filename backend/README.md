# Backend scaffold

This is a small, replaceable reference adapter for the first Creator slice. It uses
only Node's built-in modules so the current machine needs no package installation.
The application services depend on repository/authentication ports; this does not
select Node, a database, or a deployment model as the final product stack.

The server binds to `127.0.0.1` only. It refuses to start without an explicitly
configured bearer token and owner ID. Runtime media and state are stored under the
ignored local data directory. No external network client, LLM, SNS publisher, or
analytics integration is included.

See `backend/src/ports` and `backend/src/application` for replaceable boundaries.
