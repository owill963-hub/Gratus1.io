# CLAUDE.md

## Overview

Gratus1.io is the static marketing/portfolio website for Gratus1 — a veteran-owned
portfolio of consulting, technology, and lifestyle brands. It is a small set of
hand-authored, self-contained HTML pages (no framework, no build step, no JavaScript
app) served as static assets from the repository root. The live site is `gratus1.io`,
deployed via Cloudflare Workers static assets (see `wrangler.jsonc`).

## Tech stack

- Plain HTML5 + inline `<style>` CSS. No package.json, no Node dependencies, no bundler.
- No build, test, or lint tooling is configured in the repo.
- Hosting: Cloudflare Workers static assets (`assets.directory = "."`).
- Analytics: Google Analytics (gtag.js, `G-CWQ2X66B6L`) embedded in each page.
- SEO: per-page JSON-LD structured data, Open Graph / Twitter card meta tags,
  `sitemap.xml`, and `robots.txt`.

## Layout

- `index.html` — legacy landing page; the live root is served from `Gratus1 Nebula.dc.html`.
- **The live product pages are the `*.dc.html` files.** `worker.js` maps clean URLs to them
  (`PAGE_ROUTES`): `/` → `Gratus1 Nebula.dc.html`, `/home` → `Gratus1 Home.dc.html`,
  `/my-tech-buddy` → `My Tech Buddy.dc.html`, `/tactical-vibes` → `Tactical Vibes.dc.html`,
  `/status-board` → `Daily Dashboard.html`. Edit those, not the plain `.html` exports.
- `mytechbuddy.html`, `tacticalvibes.html` — legacy pages, kept only so the worker can 301
  them to the clean URLs. Editing them changes nothing a visitor sees.
- `My Tech Buddy.html`, `Tactical Vibes.html` — raw design-tool exports, excluded in
  `.assetsignore` and never published.
- `media/` — demo video and poster frames used by the product pages.
- `Gratus1.html` — older/alternate landing page draft; not linked from any page or
  the sitemap. Treat `index.html` as the canonical landing page.
- `favicon.svg`, `gratus1-social-share.png` — site icon and OG/social share image.
- `CNAME` — custom domain (`gratus1.io`).
- `robots.txt`, `sitemap.xml` — crawler directives and indexed URLs.
- `wrangler.jsonc` — Cloudflare Workers config (project name `gratus1`).
- `.assetsignore` — files excluded from the deployed asset bundle (repo internals
  like `.git`, `.github`, `wrangler.jsonc`, `README.md`, `node_modules`).
- `.gitignore` — ignores Wrangler local state and env files (`.wrangler`, `.dev.vars*`, `.env*`).

## Develop, preview, deploy

There is no build step — edit the HTML files directly and open them in a browser, or:

```bash
# Local preview with the Cloudflare Workers runtime (requires Node.js + npm)
npx wrangler dev

# Deploy to Cloudflare (requires a configured Cloudflare account / auth)
npx wrangler deploy
```

Wrangler is not pinned via a package.json, so it is run through `npx`. There are no
test or lint commands to run.

## Conventions & gotchas

- Each page is fully self-contained: all CSS lives in an inline `<style>` block in the
  `<head>`, and shared design tokens are defined as CSS custom properties on `:root`
  (e.g. `--teal: #1D9E75`, `--amber: #EF9F27`, serif/sans font stacks). Keep brand
  colors and fonts consistent across pages.
- There is no shared header/footer/component system — nav, footer, the GA snippet, and
  meta tags are duplicated per page. When changing site-wide elements (analytics ID,
  nav links, footer, OG image), update every HTML page.
- When adding a new page, also add its URL to `sitemap.xml` and link it from the
  relevant nav/footer where appropriate.
- Keep the JSON-LD structured data (`application/ld+json` scripts) accurate when page
  content or breadcrumbs change.
- Repo-only files must stay listed in `.assetsignore` so they are not published as
  public site assets.
- A Jekyll GitHub Pages workflow previously existed but was removed; deployment is now
  Cloudflare Workers. Do not reintroduce Jekyll assumptions.
