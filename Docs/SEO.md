# Product website SEO

The canonical product website is **https://telegram-drive.com/**. GitHub Pages
publishes `Docs/Telegram-Drive.html` as `/index.html` through
`.github/workflows/pages.yml`, along with `Docs/assets/`, `Docs/robots.txt`, and
`Docs/sitemap.xml`. Markdown documentation in `Docs/` is not published by this
workflow.

## Search configuration

- `robots.txt` allows crawlers to fetch the page and its assets and advertises the
  absolute sitemap URL. Do not block assets needed to render the page.
- The sitemap contains only the canonical homepage. Section anchors such as
  `#download` and `#faq` are not separate pages and must not be added as sitemap URLs.
  Add future pages only when they are published and independently indexable.
- The canonical link, Open Graph URL, and structured data all use the HTTPS custom
  domain. Keep the title and descriptions consistent with the visible product copy.
- `WebSite` structured data supplies the site name. `SoftwareApplication` describes
  the free application; the optional supporter license does not change the app's
  zero purchase price. Do not invent ratings or reviews to satisfy rich-result checks.
  Google's software-app rich result requires a qualifying rating or review, which
  this page does not currently provide.
- All main text, FAQ answers, and download fallback links are present in the static
  HTML. JavaScript is not required to discover them.
- The sitemap intentionally omits `lastmod`: a deployment time is not necessarily
  a substantive content update. Add it only when it can be maintained accurately.

## Verify after an authorized deployment

1. Confirm these URLs return HTTP 200 and the expected file contents:
   - https://telegram-drive.com/
   - https://telegram-drive.com/robots.txt
   - https://telegram-drive.com/sitemap.xml
2. Confirm `https://caamer20.github.io/Telegram-Drive/` still redirects permanently
   to `https://telegram-drive.com/`, and GitHub Pages still enforces HTTPS.
3. In the verified [Google Search Console](https://search.google.com/search-console)
   property for this domain, submit `https://telegram-drive.com/sitemap.xml` in
   **Sitemaps**. Use **URL inspection → Test live URL** for the homepage, then
   **Request indexing**. Domain verification requires the owner's Google account
   and DNS access if the property has not already been verified.
4. Inspect the page in Google's [Rich Results Test](https://search.google.com/test/rich-results)
   and [PageSpeed Insights](https://pagespeed.web.dev/). Monitor Search Console's
   indexing, selected canonical, and search performance after Google recrawls.
   Crawl permission and structured data do not guarantee indexing or rankings.

## Google references

- [Create a robots.txt file](https://developers.google.com/crawling/docs/robots-txt/create-robots-txt)
- [Build and submit a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [Canonical URLs](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
- [Site names](https://developers.google.com/search/docs/appearance/site-names)
- [Software application structured data](https://developers.google.com/search/docs/appearance/structured-data/software-app)
