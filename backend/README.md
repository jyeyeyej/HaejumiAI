# Backend scaffold

This is a small, replaceable reference adapter for the first Creator slice. It uses
only Node's built-in modules so the current machine needs no package installation.
The application services depend on repository/authentication ports; this does not
select Node, a database, or a deployment model as the final product stack.

The server binds to `127.0.0.1` only. It refuses to start without an explicitly
configured bearer token and owner ID. Runtime media and state are stored under the
ignored local data directory. No external network client, LLM, SNS publisher, or
analytics integration is included.

The server reads the repository-root `.env` at startup using a small allowlisted
parser. It does not evaluate shell expressions, does not print values, and existing
process environment variables take precedence. Do not commit a populated `.env`.

Copy `.env.example` to `.env`, set a random bearer token and owner ID, then run:

```powershell
npm start
```

The parser permits only the declared `HAEJUMI_*` settings used by this backend. The server
still binds to `127.0.0.1`; this single-owner development bearer mechanism is not the
approved production authentication design. LLM settings default to disabled and configure
daily/monthly budget plus per-task call/revision caps. No OpenAI provider or API key is
configured; tests inject a local fake provider only.

See `backend/src/ports`, `backend/src/security`, and `backend/src/adapters` for replaceable boundaries.

## Creator local render adapter

`POST /api/v1/tasks/{task_id}/render` creates a private, idempotent render job only
after the current plan and draft `continue` checkpoints are approved. Poll
`GET /api/v1/jobs/{job_id}`, cancel with `POST /api/v1/jobs/{job_id}/cancel`, and fetch
the authenticated current-version preview from `GET /api/v1/tasks/{task_id}/preview`.
The job uses only media already attached to the owner's project. Real previews are
served only after ffprobe verifies the confirmed 9:16 1080×1920, 30fps H.264/AAC MP4
profile and 3–59 second duration. The test renderer returns `simulated` and a marker
body that is not a video. The current render draft explicitly has no captions and a
silent AAC track; caption burn-in and original audio/BGM mixing remain future work.

## Supervisor and Creator planning

The Capability Registry lists Creator, Schedule, Wellness and Diary. Only Creator planning
is implemented; the other three are registered but planned, while Blog/Music placeholders
are disabled. `/assistant/messages` uses a deterministic rule router. Creator planning
reads only selected media attached to an owned task and stores a storyboard plus caption
draft on a new content version. The caption draft is readable only after plan approval.
Revision invalidates prior approvals. External LLM processing remains blocked by default;
OpenAI is not wired, and all tests use an injected fake LLM.

For a real local render, install FFmpeg separately on the supported development PC
and place both `ffmpeg` and `ffprobe` on PATH; this repository does not install them.
