# dsgvo-check — from the last 80 audits

Examples are real findings from audits

**P0** — no release without it · **P1** — in the MVP if time permits · **P2** — after release

---

## P0

| ID | What we detect | Module | Frequency | Example from audits | crmCode |
|---|---|---|---|---|---|
| PRIV-01 | A service operates on the site but is not mentioned in the Datenschutzerklärung | browser + http | 48 | Trustindex reviews load on the home page, but the policy says nothing about them | T3_LEGAL_DOCS_MISMATCH |
| PRIV-02 | The policy claims the opposite of what happens | browser + http | rare | “Google Fonts lokal installiert” — but every page pulls `fonts.googleapis.com`, even after “Nur essenzielle” | T1_MISLEADING_CLAIM |
| CONSENT-01 | Third-party requests before any click on the banner | browser | 39–44 | GTM, GA and Google Ads set `_ga` while the banner is still displayed | T1_TRACKER_BEFORE_CONSENT |
| CONSENT-02 | Non-essential cookies before consent | browser | together with CONSENT-01 | Tracking cookie `wpvp1` and a request to AWS in the US on the first visit | T1_TRACKER_BEFORE_CONSENT |
| CONSENT-03 | Third-party services are present, but there is no banner | browser | 7 | Maps and Fonts load, and nobody asks for consent | T1_CONSENT_BANNER_BROKEN |
| CONSENT-04 | No equivalent rejection at the first level | browser | 10 | Only “Zustimmen” and “Cookie-Einstellungen”; in another case, “Verbergen” instead of rejection | T1_CONSENT_BANNER_BROKEN |
| TRACK-01 | Analytics and advertising pixels | browser | 35 | GA4 22 · GTM 15 · Meta Pixel 13 · Google Ads 10 · Hotjar 4 | T1_TRACKER_BEFORE_CONSENT |
| EMBED-01 | Fonts from external servers | browser | 27 | `fonts.gstatic.com`; three times — Adobe Fonts from `use.typekit.net` | T1_FONTS_EXTERNAL |
| EMBED-02 | Maps before consent | browser | 26 | Google Maps on the “Kontakt” page, including static tiles | T1_MAPS_BEFORE_CONSENT |
| MAIL-01 | DMARC missing or `p=none` | dns | 54 | No record — 28, `p=none` — 26 | T3_MAIL_UNPROTECTED |
| MAIL-02 | SPF missing or soft | dns | 40 | `~all` — 32, no record — 8 | T3_MAIL_UNPROTECTED |
| HDR-01 | Missing security headers | http | 64 | Usually the entire set is missing at once: HSTS, CSP, nosniff, Referrer-Policy, Permissions-Policy, frame-ancestors | T3_NO_SECURITY_HEADERS |
| TLS-01 | http does not redirect to https | http | 15 | `http://` returns 200, no HSTS, “Startseite” in the menu leads to an http subdomain | T1_UNENCRYPTED |
| TLS-02 | Certificate belongs to someone else, is invalid or is expiring | http | together with TLS-01 | On https, the hosting provider's certificate `*.alfahosting-server.de`; the browser blocks the site | T1_UNENCRYPTED |
| LEGAL-01 | No Impressum or Datenschutzerklärung | browser | 19 | Footer links lead to `#` | T1_OTHER |

**Banners for CONSENT-04, in implementation order:**

| Order | CMP | Appeared in findings |
|---|---|---|
| 1 | Borlabs | 12 |
| 2 | Cookiebot | 4 |
| 3 | Complianz | 4 |
| 4 | Usercentrics | 1 |
| 5 | CCM19 | 2 |
| 6 | Real Cookie Banner | 1 |
| 7 | CookieHub | 1 |

---

## P1

| ID | What we detect | Module | Frequency | Example from audits | crmCode |
|---|---|---|---|---|---|
| EMBED-03 | Video before consent | browser | 12 | A YouTube preview loads from `i.ytimg.com` on the company history page | T1_MAPS_BEFORE_CONSENT |
| EMBED-04 | reCAPTCHA before consent | browser | 11 | Google CAPTCHA on every page, not just by the form | T1_OTHER |
| EMBED-05 | Widgets before consent | browser | 4–10 | Elfsight `platform.js` on the home page; Instagram feed | T1_OTHER |
| CONSENT-05 | Requests do not stop after rejection | browser | 3 | GA4 and Ads send `page_view` even after “Nur technisch notwendige” | T1_CONSENT_BANNER_BROKEN |
| CONSENT-06 | Consent Mode defaults to `granted` | browser | 5 | CMP reports `analytics=false`, while Google receives `granted` | T1_TRACKER_BEFORE_CONSENT |
| VULN-01 | Outdated CMS core with a CVE | http + browser | 15 | WordPress version visible in the home page source | T1_EXPLOITABLE_CVE / T3_OUTDATED_CVE |
| VULN-02 | Outdated plugins, themes, libraries with CVEs | http + browser | 34 | jQuery 3.4.1 (CVE in CISA KEV); Next.js 15.2.8 with middleware authorization bypass | T1_EXPLOITABLE_CVE / T3_OUTDATED_CVE |
| MAIL-03 | DKIM not found | dns | 14 | Not on any of the common selectors | T3_MAIL_UNPROTECTED |
| TLS-03 | Mixed content | browser | 18 | Images and scripts over `http://` on an https page | T3_OTHER |
| TLS-04 | Old TLS versions | http | 7 | Server still accepts TLS 1.0 | T3_NO_SECURITY_HEADERS |

**What becomes outdated most often (VULN-02):**

| Component | Findings |
|---|---|
| Elementor | 9 |
| jQuery | 6 |
| Contact Form 7 | 5 |
| Borlabs | 5 |
| Divi | 4 |
| Slider Revolution | 4 |
| TYPO3 | 4 |
| WPBakery | 2 |

**Level for VULN:**

| Level | When |
|---|---|
| critical | Exploitation without login: RCE, file upload, SQL injection, authorization bypass — or an entry in CISA KEV |
| warning | Everything else: an account is required, read-only, XSS for authors |

---

## P2

| ID | What we detect | Module | Frequency | Example from audits |
|---|---|---|---|---|
| DNS-01 | No CAA and DNSSEC | dns | 54 | — |
| HDR-02 | Cookies without Secure / HttpOnly / SameSite, versions in headers | http | 22 | `X-Powered-By: PHP/7.4` |
| ADMIN-01 | WP logins are public and login is unprotected | http | rare | `/wp-json/wp/v2/users` + exposed `xmlrpc.php` |
| FILE-01 | Exposed service files | http | 0 | `.git/`, `.env`, backups — never found, but if found, it is T0 |
| SEC-01 | No `security.txt` | http | almost everywhere | info only |
| LEGAL-02 | Impressum links to old laws | http | rare | TMG and RStV instead of DDG and MStV |
| BFSG-01 | Basic accessibility (axe-core) | browser | 42 | separate plugin |
| PERF-01 | Speed, Core Web Vitals (Lighthouse) | browser | 64 | 34.5 MB video on the home page |

---
