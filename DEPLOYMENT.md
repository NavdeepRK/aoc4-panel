# mca-filing-service — deployment guide

## Architecture summary

```
┌──────────────────┐   HTTPS    ┌────────────────────┐   HTTPS    ┌──────────────────────────┐
│  erpAdmin (Next) │ ─────────▶ │ customer-portal-   │ ─────────▶ │ mca-filing-service       │
│  /compliance/... │            │ backend-1 (Node)   │            │ (Playwright + Chromium)  │
└──────────────────┘            └────────────────────┘            └──────────────────────────┘
                                          │                                    │
                                          ▼                                    ▼
                                      MongoDB                          MCA portal (www.mca.gov.in)
```

- **Each SPOC's filing = a separate Chromium browser context** with their own MCA login session.
- **Concurrent jobs**: capped by `MAX_CONCURRENT_JOBS` (default 5). Surplus jobs queue.
- **Credentials**: SPOC's MCA password + OTP transit via HTTPS only — never logged, never persisted to MongoDB.

## VPS sizing

| Concurrent SPOC filings | RAM | vCPU | Disk |
|---|---|---|---|
| 5 | 8 GB | 4 | 50 GB SSD |
| 10 | 16 GB | 6 | 100 GB SSD |
| 20 | 32 GB | 8 | 200 GB SSD + artifact prune cron |

Per-job overhead: ~350 MB RAM, ~5–10% of one vCPU.

## One-time setup

### 1. Provision

Pick any VPS provider (DigitalOcean, Hetzner, AWS Lightsail, etc.) running Ubuntu 22.04 LTS or similar. Open ports 80, 443 (public) and keep 8090 closed to the internet (we'll bind it to localhost and reverse-proxy).

### 2. Install Docker + docker compose

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
exec sg docker -                       # re-login the shell
docker compose version                 # sanity
```

### 3. Clone + configure

```bash
git clone <your-fork-of-mca-filing-service>.git
cd mca-filing-service

cp .env.example .env || true
# Edit .env to set:
#   ADMIN_TOKEN=<long random string>           # gates /admin dashboard
#   ANTHROPIC_API_KEY=<optional, for captchas>
#   MAX_CONCURRENT_JOBS=5
```

### 4. Build + start

```bash
docker compose up -d --build
docker compose logs -f                 # confirm "listening on :8090"
```

### 5. Reverse proxy with TLS

Use nginx or Caddy. Example nginx (`/etc/nginx/sites-available/mca-filing.conf`):

```nginx
server {
  listen 443 ssl http2;
  server_name mca-filing.your-domain.com;

  ssl_certificate     /etc/letsencrypt/live/mca-filing.your-domain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/mca-filing.your-domain.com/privkey.pem;

  # Only allow the customer-portal-backend's static IP / VPN range.
  # The /admin dashboard is gated by ADMIN_TOKEN but defense-in-depth.
  allow 1.2.3.4;
  deny  all;

  location / {
    proxy_pass http://127.0.0.1:8090;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 600s;     # form fills can take ~5 min
    proxy_send_timeout 600s;
  }
}
```

Then on the customer-portal-backend's `.env`:

```
MCA_FILING_SERVICE_URL=https://mca-filing.your-domain.com
```

### 6. Verify

```bash
curl https://mca-filing.your-domain.com/health
# {"ok":true,"service":"mca-filing-service","time":"..."}

# Visit the admin dashboard (browser):
#   https://mca-filing.your-domain.com/admin?token=<ADMIN_TOKEN>
```

## Operations

### Tail logs

```bash
docker compose logs -f mca-filing-service
```

### Restart (preserves artifacts)

```bash
docker compose restart
```

### Update to latest code

```bash
git pull
docker compose up -d --build --force-recreate
```

### Artifact retention

Job state + per-panel JSON + draft PDFs accumulate in `./artifacts/`. Add a cron to prune older than 14 days:

```bash
# /etc/cron.daily/mca-filing-prune
find /path/to/mca-filing-service/artifacts -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
```

### Headless vs. headed

Production: `HEADLESS=true` (default in Dockerfile). For debugging on the VPS, exec into the container and run a headed Chromium isn't easy — better to reproduce locally with `HEADLESS=false`.

## Per-SPOC login flow (verifying it works)

1. SPOC visits `/compliance/:id` in erpAdmin and clicks the ⚡ button.
2. Backend triggers worker → worker creates a job in `LOGIN_NEEDED` phase, opens browser, navigates to MCA login.
3. Frontend's status panel auto-polls (4 s cadence), sees `LOGIN_NEEDED`, renders the credentials form.
4. SPOC submits username + password. POST `/api/compliance/services/:id/aoc4-creds` → worker fills the login form, submits, transitions to `OTP_PENDING`.
5. Frontend sees `OTP_PENDING`, renders OTP input.
6. SPOC enters OTP. POST `/api/compliance/services/:id/aoc4-otp` → worker fills OTP, transitions to `AUTHENTICATED`.
7. Worker proceeds with normal AOC-4 form fill flow.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `MCA session not found` on trigger | Job not using per-job-login | Backend should default `_perJobLogin: true`; check `triggerAoc4Filing` controller |
| `credentials timeout (15 min)` | SPOC didn't submit creds in time | Re-trigger; SPOC must complete login within 15 minutes |
| `OTP timeout (5 min)` | OTP expired before SPOC entered it | Re-trigger; some MCA OTPs expire in 3 minutes |
| `Execution context was destroyed` | AEM re-rendered the iframe mid-operation | Worker retries automatically; if persistent, check MCA changed their form |
| Browser memory leaks | Stale jobs not cleaned up | Check `MAX_CONCURRENT_JOBS` not too high; add `JOB_IDLE_TIMEOUT_MS` cleanup (TODO) |
| `INVALID_CREDS` on every job | MCA changed login flow | Re-run the live introspector + update `src/selectors.ts` |

## Security checklist

- [ ] Bind worker port to `127.0.0.1` (not 0.0.0.0)
- [ ] Reverse proxy with HTTPS + IP allowlist
- [ ] Set `ADMIN_TOKEN` to a long random string
- [ ] `customer-portal-backend` validates `verifyServiceAccess` on creds/otp endpoints (already done)
- [ ] MCA passwords NEVER logged (verify via `grep -i password /var/log/...` after a run)
- [ ] Artifacts directory has restricted permissions (`chmod 700`)
- [ ] Backups of MongoDB include `service.metadata.aoc4Automation` but NOT credentials (none stored there)
