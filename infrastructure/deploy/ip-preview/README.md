# Spott IP and internal-test runbook

This deployment intentionally exposes two different trust boundaries:

- `http://18.178.203.117`: public anonymous read-only product-website preview.
- `http://localhost:8080`: internal functional-test entry, reachable only
  through an authenticated SSH local-forward tunnel.

It is not the final domain/TLS production topology.

## Security boundary

- Public Nginx is the only internet listener, on HTTP port 80.
- Web and API bind to loopback only; PostgreSQL has no published port.
- The public server blocks authentication, Ops and every non-read API method,
  and removes credentials and debug authority before proxying.
- The internal server listens only on `127.0.0.1:8080` and exposes interactive
  Web/API testing through the encrypted SSH tunnel. Background workers, object
  storage processing and production Apple/Google identity are separate
  acceptance gates and are not implied by this entry.
- Account-merge commit is deliberately unavailable in this preview:
  `ACCOUNT_MERGE_EXECUTION_ENABLED=false` makes the API return 503 and the
  ordinary runtime database role cannot execute the ownership-transfer
  function. Do not re-grant that function to make a test pass; it requires a
  separately authenticated execution service.
- Migrations run as `spott_admin`; the API connects as a separate
  `NOSUPERUSER`/`NOBYPASSRLS` `spott_app` role. Runtime access to migration,
  quarantine and account-transfer authorization records is denied.
- API still runs with `NODE_ENV=production`. The internal override selects the
  console OTP adapter because no email/SMS provider credential has been supplied;
  codes are available only to an SSH user with passwordless sudo.
- The seed inserts fixed synthetic organizers, public groups and future-dated
  preview events once. Exact legacy-copy hashes may receive a one-time
  presentation-only upgrade; a later deployment never rewrites event state,
  dates or capacity counters, so internal-test registrations are preserved. It
  creates no administrator, session, registration, device, wallet, point,
  phone or email data.
- The preview build enables MapLibre with MapLibre's public demo style. This is
  suitable for the internal preview only; select a production tile provider,
  license and availability target before a public production launch.

Do not expose port 8080 in the AWS security group. Do not remove the public
restrictions until a stable address, TLS, the Web HttpOnly-session migration,
production identity providers and remaining security acceptance gates pass.
The current address is an EC2 auto-assigned public IPv4 address rather than an
Elastic IP. A reboot normally retains it, but an EC2 stop/start can replace it
and would require a rebuild/redeploy because origins and browser links contain
the address. Do not stop/start the instance without first allocating an
Elastic IP or planning the address migration.

## First deployment

The source archive must already be extracted to an immutable directory under
`/opt/spott/releases/<release-id>`. Record both the archive SHA-256 and release
ID in the handoff log.

```bash
sudo install -d -m 0700 /opt/spott/shared
sudo infrastructure/deploy/ip-preview/bootstrap-secrets.sh \
  /opt/spott/shared/ip-preview.env 18.178.203.117
sudo chown root:root /opt/spott/shared/ip-preview.env
sudo infrastructure/deploy/ip-preview/deploy.sh \
  /opt/spott/releases/<release-id> <release-id>
```

The secret bootstrap is fail-closed and never overwrites an existing file.
Never print, copy into a document or commit that environment file.
Deployments are serialized with `/run/lock/spott-ip-preview-deploy.lock`, and
the Nginx candidate is validated before an atomic configuration replacement.

## Public and internal verification

```bash
infrastructure/deploy/ip-preview/verify.sh http://127.0.0.1 public
infrastructure/deploy/ip-preview/verify.sh http://127.0.0.1:8080 internal
curl --fail http://18.178.203.117/v1/health
```

Create a private PostgreSQL custom-format backup and prove that it restores into
an isolated throwaway database before retaining it:

```bash
sudo /opt/spott/current/infrastructure/deploy/ip-preview/backup-restore-check.sh
```

The command writes a mode-`0600` dump and SHA-256 sidecar under
`/opt/spott/backups`. It never prints database credentials and removes the
throwaway restore database on both success and failure. Retention and off-host
copying remain an explicit operator decision.

Open the encrypted internal-test entry from the development Mac:

```bash
ssh -N -L 8080:127.0.0.1:8080 \
  -i /Users/yaokai/Code/xingyu/STOPP.pem \
  ec2-user@18.178.203.117
```

Then browse `http://localhost:8080`. After requesting a code, retrieve only the
latest exact-match OTP in a separate SSH session. The helper supports both the
email and Japanese E.164 phone flows and never prints unrelated container logs:

```bash
sudo /opt/spott/current/infrastructure/deploy/ip-preview/latest-otp.sh \
  email internal-tester@example.invalid

sudo /opt/spott/current/infrastructure/deploy/ip-preview/latest-otp.sh \
  phone +819012345678
```

From a separate machine, confirm ports 3000, 4100, 5432 and 8080 are
unreachable. After a reboot, confirm Docker, both application containers,
PostgreSQL and Nginx recover before declaring the preview available.

## Operations and rollback

```bash
sudo env SPOTT_RELEASE_ID=<release-id> docker compose \
  --project-name spott-ip-preview \
  --env-file /opt/spott/shared/ip-preview.env \
  --file /opt/spott/current/infrastructure/deploy/ip-preview/compose.yaml \
  --file /opt/spott/current/infrastructure/deploy/ip-preview/compose.internal.yaml ps

sudo journalctl -u nginx --since '30 minutes ago'
sudo docker logs --since 30m spott-ip-preview-api-1
sudo docker logs --since 30m spott-ip-preview-web-1
```

Database migrations are forward-only. After proving an older application is
compatible with the current schema, perform an application-only rollback with
the previous immutable release (releases created before `--app-only` support
cannot use this path):

```bash
sudo /opt/spott/releases/<previous-release-id>/infrastructure/deploy/ip-preview/deploy.sh \
  /opt/spott/releases/<previous-release-id> <previous-release-id> --app-only
```

The application-only mode deliberately skips migrations, runtime grants and
seed. Its health and route verification must pass before `/opt/spott/current`
is changed. Never delete the PostgreSQL volume or protected environment file
during rollback.
