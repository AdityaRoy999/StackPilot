# StackPilot website

Public website, current documentation and guided installation choices. The application dashboard lives separately in `frontend/`.

```bash
npm ci
npm run dev
```

Development listens on http://localhost:3005. Run `npm test` and `npm run build` before publishing. Deployment uses the Vite `dist/` directory and the serverless functions in `api/`.

Automatic Vercel deployments are disabled in `vercel.json`. GitHub CI still checks the website build and navigation. To publish manually on Vercel, use Root Directory `stackpilot web`, build command `npm run build`, and output directory `dist`. Current styles target modern browsers (Safari 16.4+, Chrome 111+, Firefox 128+), following the [Tailwind migration guide](https://tailwindcss.com/docs/upgrade-guide).

Installation choices generate a command for the supported operating system, service profile and optional HTTPS hostname. Users enter provider keys on their own installation. Never put provider credentials in public `VITE_*` variables.

Docs import the canonical root Markdown files; update those guides instead of maintaining a separate generated documentation blob. Build and development scripts copy the root installers into `public/`; the copies are generated and ignored.

Routes change immediately. Documentation and contact pages are split into separate chunks. Below-fold video and gallery engines mount only near the viewport, preserve their layout space and release their graphics resources when hidden. The home route uses a static background and does not block navigation behind a preload video.
