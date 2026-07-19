This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
# GraveLens

## Security notes

- **Token-gate enforcement (required in prod):** the per-route token gate
  (`src/lib/tokenGate.ts`) runs in observe-only mode unless
  `GRAVELENS_ENFORCE_TOKEN_GATE="true"` is set. Set it in Vercel prod so
  over-budget users are actually blocked (402). The sliding-window rate limiter
  (`src/lib/rateLimit.ts`) is the abuse backstop and is always on.
- **Rate limiter requires the service-role key:** writes go through
  `SUPABASE_SERVICE_ROLE_KEY` (never the user session), and the
  `gravelens_rate_limits` table is locked down from the authenticated role so a
  user cannot reset their own counter. See `db/migrations/gravelens_security_hardening.sql`.
- **Private photos:** the `grave-photos` bucket is private. Photos are served
  through `GET /api/photo/[id]`, which enforces owner / public / friend access
  server-side. Apply the hardening migration to flip the bucket and drop the
  public-read policy.
- **DB schema:** the authoritative `gravelens_*` schema + RLS reference lives in
  `db/schema/gravelens_reference_schema.sql`. The old `supabase-schema.sql` is
  stale and must not be applied.
- **CSP:** `next.config.ts` ships a `Content-Security-Policy-Report-Only` header.
  It pins a sha256 hash of the inline theme bootstrap script in
  `src/app/layout.tsx` — if that script changes, recompute the hash:
  `node -e 'const fs=require("fs"),c=require("crypto");const m=fs.readFileSync("src/app/layout.tsx","utf8").match(/__html:\s*\`([\s\S]*?)\`,/);console.log("sha256-"+c.createHash("sha256").update(m[1]).digest("base64"))'`
  Promote to the enforcing `Content-Security-Policy` header once violations are clean.
