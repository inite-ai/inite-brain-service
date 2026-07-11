# inite-monitoring — self-hosted observability stack

Runs on the inite-temporal droplet next to the brain, deployed by
[`deploy-monitoring.yml`](../.github/workflows/deploy-monitoring.yml)
(self-hosted runner; rsync to `/opt/projects/inite-monitoring` +
`docker-compose up -d`). Total memory ceiling ≈ 1 GB across five
containers.

| signal | store | retention | collector |
|---|---|---|---|
| metrics (brain `/metrics` + host) | VictoriaMetrics | 30d | Alloy scrape, 15s/30s |
| logs (allowlisted containers) | Loki | 14d | Alloy ← docker socket |
| traces (OTel) | Tempo | 7d | Alloy OTLP/HTTP :4318 → gRPC |

## Access

Grafana: **https://brain.inite.ai/grafana** — user `admin`, password in
the `GRAFANA_ADMIN_PASSWORD` repo secret. The "Brain Overview" dashboard
and all datasources (VictoriaMetrics / Loki / Tempo) are provisioned
from this directory; edits made in the UI are not persisted — change the
files here instead.

VictoriaMetrics, Loki, Tempo and Alloy are **not** exposed publicly and
never should be (Alloy holds the docker socket — root-equivalent).

## Alerts

Rules live in `grafana/provisioning/alerting/rules.yaml` and always
evaluate (visible under Alerting in the UI). Notifications are wired to
Telegram **only when** the `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
repo secrets are set — the workflow then copies
`grafana/alerting-optional/telegram.yaml` into the provisioning dir.

To enable Telegram: create a bot via @BotFather, get your chat id (e.g.
message the bot, then `curl https://api.telegram.org/bot<token>/getUpdates`),
set both secrets, re-run the deploy-monitoring workflow.

Gotcha: provisioned contact points persist in Grafana's DB even after
the provisioning file is removed — unsetting the secrets stops updates
but doesn't delete the contact point (ship a `deleteContactPoints`
reset entry if that ever matters).

## Adding a container to log collection

Logs are allowlisted by container-name substring in
`alloy/config.alloy` (`discovery.docker` filter). Add the name there —
temporal-stack chatter is deliberately excluded.

## Local sanity check

```bash
cd monitoring
GRAFANA_ADMIN_PASSWORD=dev docker-compose config -q   # validate compose
docker run --rm -v $PWD/alloy:/cfg grafana/alloy:v1.9.2 fmt /cfg/config.alloy
```
