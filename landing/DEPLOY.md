# Deploying the CallGuard AI landing site

The site is pure static HTML / CSS / SVG. No build step, no server-side runtime needed. Drop the files in your web root and point the domain at it.

---

## What's in this folder

| File | Purpose |
|---|---|
| `index.html` | Marketing landing page (single long scroll) |
| `privacy.html` | Privacy policy |
| `terms.html` | Terms of service |
| `dpa.html` | Data Processing Agreement |
| `sub-processors.html` | Sub-processor list |
| `style.css` | Shared stylesheet |
| `favicon.svg` | Browser tab icon |
| `robots.txt` | Crawler rules |
| `sitemap.xml` | XML sitemap (5 URLs) |
| `.htaccess` | Apache config: HTTPS redirect, pretty URLs, security headers, GZIP, caching |

---

## Option 1 — Upload via cPanel File Manager (5 mins)

1. Log in to your hosting cPanel.
2. Open **File Manager**, navigate to **`public_html`** (or whatever your domain's web root is — for an addon domain it might be `public_html/callguardai.co.uk/`).
3. Select **all files in this folder** (10 files including the hidden `.htaccess`):
   - `index.html`, `privacy.html`, `terms.html`, `dpa.html`, `sub-processors.html`
   - `style.css`, `favicon.svg`
   - `robots.txt`, `sitemap.xml`
   - `.htaccess`
4. Drag-drop them into `public_html` (or click **Upload**).
5. **Important:** in cPanel File Manager, click **Settings** (top-right) and tick **"Show Hidden Files (dotfiles)"** so `.htaccess` is visible/uploadable.
6. Visit your domain. Done.

---

## Option 2 — Upload via SFTP (FileZilla, Cyberduck, Transmit)

1. Get SFTP credentials from your hosting panel (usually at the same place you'd find FTP).
2. Connect with your SFTP client.
3. Navigate to `public_html` (or your web root).
4. Drag the contents of the `landing/` folder into the remote folder.

```
# Example via the command line if you prefer
sftp youruser@yourhost.example.com
cd public_html
put -r landing/*
put landing/.htaccess
exit
```

---

## Option 3 — rsync over SSH (for power users)

```bash
# From your local repo root
rsync -avz --exclude='DEPLOY.md' \
  landing/ youruser@yourhost.example.com:/home/youruser/public_html/
```

---

## DNS + SSL setup

### DNS

Point your domain at the hosting server:

1. In your domain registrar (where you bought `callguardai.co.uk`):
   - Add an **A record**: `@` → your hosting server IP
   - Add an **A record**: `www` → same IP (or a CNAME to `@`)
2. If you also bought `getcallguardai.com`, set up a **301 redirect** to `callguardai.co.uk` in your registrar's redirect tool, *or* via cPanel's Redirects feature.

DNS propagation is usually 5–60 mins.

### SSL / HTTPS

Most cPanel hosts auto-provision a Let's Encrypt cert when DNS resolves. Check **AutoSSL** under SSL/TLS in cPanel — should turn green within 24 hours of DNS pointing at the server.

The `.htaccess` redirects HTTP → HTTPS once the cert is active. **Until SSL is up**, comment out the first three `RewriteRule` lines in `.htaccess`, or you'll redirect-loop.

---

## After deploying — sanity check

Visit:

- `https://callguardai.co.uk/` → landing
- `https://callguardai.co.uk/privacy` → privacy policy (pretty URL works thanks to .htaccess)
- `https://callguardai.co.uk/sub-processors` → sub-processor list
- `https://callguardai.co.uk/sitemap.xml` → sitemap
- `https://callguardai.co.uk/robots.txt` → robots

Verify:

- ✅ HTTPS is active (green padlock)
- ✅ Logo + ascending bars render
- ✅ Inter font loads (text looks modern, not Times New Roman)
- ✅ "Book a demo" button opens email to `hello@callguardai.co.uk`
- ✅ All 4 footer links to legal pages work

---

## Setting up `hello@callguardai.co.uk` (5 mins)

The "Book a demo" CTAs all `mailto:` `hello@callguardai.co.uk`. Set up the inbox:

1. In cPanel, open **Email Accounts** → **Create**
2. Email: `hello@callguardai.co.uk`
3. Either set a password and check via webmail, OR
4. Delete the mailbox and instead create a **Forwarder** (under Email → Forwarders) sending `hello@callguardai.co.uk` → your real inbox (e.g., `kofi@properleads.co.uk`)

Repeat for `privacy@callguardai.co.uk` and `procurement@callguardai.co.uk` (forwarders to the same place is fine).

---

## Updating the site later

1. Edit the HTML/CSS in this `landing/` folder
2. Re-upload the changed files (cPanel File Manager / SFTP)
3. Hard-refresh your browser to bypass cache (`Cmd+Shift+R` on Mac, `Ctrl+F5` on Windows)

The `.htaccess` sets HTML cache to 1 hour, CSS/SVG to 30 days. If you change CSS during a release and need it picked up immediately, append a query string in the HTML link tag: `style.css?v=2`.
