# Agent extension boundary

The MVP keeps the four specialist identities Creator, Schedule, Wellness, and Diary.
Creator is the first capability. Agent implementations are not coupled to the HTTP
adapter; new capabilities must be registered with an input schema, owner/data scopes,
tool allowlist, privacy policy, approval checkpoints, rights policy, and tests before
the supervisor can route to them. Blog and Music remain future extensions.
