# Security Notes

JobMatch AI MVP is prepared for a public demo deployment by default.

## Public Demo Defaults

- Set `NODE_ENV=production` and `DEMO_MODE=true`.
- Do not commit runtime files such as `data/resumes.json`, `data/report-cache.json`, `data/admin-log.json`, or local logs.
- User-uploaded resumes are parsed into short-lived memory only in demo mode.
- Resume API responses redact `raw_text`, email, phone/contact, and original uploaded file name in demo mode.
- Admin-only routes require `ADMIN_TOKEN` when configured, and are hidden when the app runs as a public demo.

## GitHub Repository Settings

Before publishing publicly, keep the repository private and enable:

- Secret scanning
- Push protection
- Dependabot alerts and security updates
- Branch protection for `main`

## Deployment Checklist

- Use `npm ci` for builds and `npm start` for runtime.
- Set `CORS_ORIGIN` to the deployed origin once the public URL is known.
- Keep `DEMO_MODE=true` for public demos.
- Add `ADMIN_TOKEN` only if you need admin API access.
- Run `npm.cmd test` and `npm.cmd audit --audit-level=moderate --omit=dev` before release.
