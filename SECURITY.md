# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately by email to **mathewgerald.14@gmail.com**. Include:

- a description of the issue and its impact,
- steps to reproduce (ideally a minimal script),
- affected versions, and
- any suggested fix.

You will receive an acknowledgement within a few days. We will coordinate a fix and a disclosure
timeline with you and credit you in the release notes unless you prefer to remain anonymous.

## Supported versions

The latest published release line receives security fixes. Fixes are published as patch or minor
releases following [SemVer](https://semver.org/).

## Scope

pg-fluent is a **server-side** PostgreSQL client. It executes SQL using the credentials of the
connecting role. In particular:

- **Row Level Security (RLS) is not emulated.** Policies written for Supabase's `anon` /
  `authenticated` roles do not apply to a direct connection. Connect with a least-privilege role
  and never expose database credentials to browsers or untrusted clients. See the RLS warning in
  the README.
- SQL injection is treated as a first-class concern: all values are bound parameters and all
  user-controlled structure is validated against strict allowlists and quoted. The single escape
  hatch for caller-supplied SQL text is `db.unsafe()`, which is named accordingly.

## Dependency and supply-chain practices

- Minimal runtime dependencies; the lockfile is committed.
- Releases are published from CI with `npm publish --provenance`.
- `SECURITY.md` provides the private disclosure address above.
