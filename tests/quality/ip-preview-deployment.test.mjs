import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const deploymentRoot = join(repositoryRoot, 'infrastructure/deploy/ip-preview');

function source(name) {
  return readFileSync(join(deploymentRoot, name), 'utf8');
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function runBackupDrillHarness(mode) {
  const directory = mkdtempSync(join(tmpdir(), 'spott-backup-drill-test-'));
  const release = join(directory, 'a'.repeat(64));
  const deployment = join(release, 'infrastructure/deploy/ip-preview');
  const backup = join(directory, 'backups');
  const bin = join(directory, 'bin');
  const state = join(directory, 'state');
  const environmentFile = join(directory, 'ip-preview.env');
  mkdirSync(deployment, { recursive: true });
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(join(deployment, 'compose.yaml'), 'services: {}\n');
  writeFileSync(join(deployment, 'compose.internal.yaml'), 'services: {}\n');
  writeFileSync(environmentFile, 'POSTGRES_DB=spott\n');
  writeExecutable(join(bin, 'id'), `#!/usr/bin/env bash
if [[ \${1:-} == -u ]]; then printf '0\\n'; else /usr/bin/id "$@"; fi
`);
  writeExecutable(join(bin, 'install'), `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "\${!#}"
`);
  writeExecutable(join(bin, 'mktemp'), `#!/usr/bin/env bash
set -euo pipefail
path=\${1/XXXXXX/ABC123}
: >"$path"
printf '%s\\n' "$path"
`);
  writeExecutable(join(bin, 'openssl'), `#!/usr/bin/env bash
printf '0123456789abcdef01234567\\n'
`);
  writeExecutable(join(bin, 'sha256sum'), `#!/usr/bin/env bash
printf '%064d  %s\\n' 0 "$1"
`);
  writeExecutable(join(bin, 'mv'), `#!/usr/bin/env bash
set -euo pipefail
count_file="$FAKE_STATE/mv-count"
count=0
if [[ -f $count_file ]]; then read -r count <"$count_file"; fi
count=$((count + 1))
printf '%s\\n' "$count" >"$count_file"
if [[ $FAKE_MODE == finalize-fail && $count -eq 2 ]]; then exit 55; fi
exec /bin/mv "$@"
`);
  writeExecutable(join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
arguments="$*"
case "$arguments" in
  *'pg_restore --list'*) exit 0 ;;
  *'pg_dump'*) printf 'fake-custom-dump'; exit 0 ;;
  *'createdb'*) exit 0 ;;
  *'pg_restore'*)
    if [[ $FAKE_MODE == cleanup-fail ]]; then exit 42; fi
    exit 0
    ;;
  *'dropdb'*)
    if [[ $FAKE_MODE == cleanup-fail ]]; then exit 43; fi
    exit 0
    ;;
  *'psql'*) printf '22\\t3.6.4\\n'; exit 0 ;;
esac
exit 0
`);
  const result = spawnSync(
    '/bin/bash',
    [join(deploymentRoot, 'backup-restore-check.sh'), release, backup],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_MODE: mode,
        FAKE_STATE: state,
        PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        SPOTT_ENV_FILE: environmentFile,
      },
    },
  );
  return { backup, directory, result };
}

test('IP preview uses a digest-pinned production runtime and immutable PostGIS image', () => {
  const dockerfile = source('Runtime.Dockerfile');
  const compose = yaml.load(source('compose.yaml'), { json: true });
  assert.match(
    dockerfile,
    /^FROM node:24\.18\.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d$/mu,
  );
  assert.match(dockerfile, /pnpm@11\.5\.2/u);
  assert.match(dockerfile, /COREPACK_HOME=\/opt\/corepack/u);
  assert.match(dockerfile, /corepack enable --install-directory "\$PNPM_HOME"/u);
  assert.match(dockerfile, /chmod -R a\+rX "\$PNPM_HOME" "\$COREPACK_HOME"/u);
  assert.match(dockerfile, /pnpm --filter @spott\/domain build/u);
  assert.match(dockerfile, /pnpm --filter @spott\/api build/u);
  assert.match(dockerfile, /pnpm --filter @spott\/web build/u);
  assert.match(dockerfile, /NEXT_PUBLIC_MAP_STYLE_URL/u);
  assert.match(dockerfile, /! grep -R -E '\/Users\/\|\\\.worktrees\/\|\/private\/tmp\/'/u);
  assert.match(source('Runtime.Dockerfile.dockerignore'), /\*\*\/\.vinext/u);
  assert.match(source('compose.yaml'), /NEXT_PUBLIC_MAP_STYLE_URL/u);
  assert.equal(
    compose.services.postgres.image,
    'postgis/postgis@sha256:05d68c7f0f19b9aa0bf7c4a2049b2e8b38b44a63116392b95726a4c913766cf6',
  );
});

test('only Web and API bind loopback and the database remains private', () => {
  const compose = yaml.load(source('compose.yaml'), { json: true });
  assert.deepEqual(Object.keys(compose.services).toSorted(), [
    'api',
    'migrate',
    'postgres',
    'seed',
    'web',
  ]);
  assert.deepEqual(compose.services.web.ports, ['127.0.0.1:3000:3000']);
  assert.deepEqual(compose.services.api.ports, ['127.0.0.1:4100:4100']);
  assert.equal(compose.services.postgres.ports, undefined);
  assert.deepEqual(compose.services.postgres.volumes, [
    "postgres_data:/var/lib/postgresql",
  ]);
  for (const name of ['api', 'web']) {
    assert.equal(compose.services[name].read_only, true);
    assert.deepEqual(compose.services[name].cap_drop, ['ALL']);
    assert.deepEqual(compose.services[name].security_opt, ['no-new-privileges:true']);
  }
});

test('API runs production-only with generated secrets and no development authentication', () => {
  const composeSource = source('compose.yaml');
  const bootstrap = source('bootstrap-secrets.sh');
  assert.match(composeSource, /NODE_ENV: production/u);
  assert.match(composeSource, /OTP_PROVIDER: primary/u);
  assert.match(composeSource, /ACCOUNT_MERGE_EXECUTION_ENABLED: 'false'/u);
  assert.doesNotMatch(composeSource, /NODE_ENV:\s*development/u);
  assert.doesNotMatch(composeSource, /replace-with|spott-local-secret|developmentCode/u);
  assert.match(bootstrap, /umask 077/u);
  assert.match(bootstrap, /openssl rand/u);
  assert.match(bootstrap, /chmod 600/u);
  assert.doesNotMatch(bootstrap, /set -x|echo .*SECRET|cat .*\.env/u);
});

test('secret bootstrap creates distinct protected credentials and refuses overwrite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'spott-ip-preview-secret-test-'));
  const environmentPath = join(directory, 'ip-preview.env');
  const bootstrap = join(deploymentRoot, 'bootstrap-secrets.sh');
  try {
    execFileSync('/usr/bin/env', ['bash', bootstrap, environmentPath, '203.0.113.42'], {
      stdio: 'pipe',
    });
    assert.equal(statSync(environmentPath).mode & 0o777, 0o600);
    const values = new Map(
      readFileSync(environmentPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    assert.equal(values.get('POSTGRES_ADMIN_USER'), 'spott_admin');
    assert.equal(values.get('APP_DATABASE_USER'), 'spott_app');
    assert.notEqual(values.get('POSTGRES_ADMIN_PASSWORD'), values.get('APP_DATABASE_PASSWORD'));
    assert.equal(values.has('POSTGRES_USER'), false);
    assert.equal(values.has('POSTGRES_PASSWORD'), false);
    assert.throws(
      () =>
        execFileSync('/usr/bin/env', ['bash', bootstrap, environmentPath, '203.0.113.42'], {
          stdio: 'pipe',
        }),
      (error) => typeof error === 'object' && error !== null && error.status === 73,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migration owner and runtime database roles are separated and least-privileged', () => {
  const compose = source('compose.yaml');
  const grantRuntime = source('grant-runtime-access.ts');
  const deploy = source('deploy.sh');

  assert.match(compose, /POSTGRES_USER: \$\{POSTGRES_ADMIN_USER/u);
  assert.match(compose, /DATABASE_URL: postgres:\/\/\$\{APP_DATABASE_USER/u);
  assert.match(compose, /DATABASE_URL: postgres:\/\/\$\{POSTGRES_ADMIN_USER/u);
  assert.match(grantRuntime, /NOSUPERUSER/u);
  assert.match(grantRuntime, /NOBYPASSRLS/u);
  assert.match(grantRuntime, /account_merge_transfer_authorizations/u);
  assert.match(grantRuntime, /current_owner_id/u);
  assert.match(grantRuntime, /REVOKE ALL ON FUNCTION media\.apply_account_merge/u);
  assert.doesNotMatch(grantRuntime, /GRANT EXECUTE ON FUNCTION media\.apply_account_merge/u);
  assert.match(grantRuntime, /REVOKE CREATE ON SCHEMA/u);
  assert.match(grantRuntime, /REVOKE TEMPORARY ON DATABASE/u);
  assert.match(grantRuntime, /spatial_ref_sys/u);
  assert.doesNotMatch(grantRuntime, /\bBYPASSRLS\b(?!\s*=\s*false)/u);
  assert.match(deploy, /grant-runtime-access\.ts/u);
});

test('HTTP IP preview is anonymous read-only and strips credential/debug headers', () => {
  const nginx = source('nginx-spott.conf');
  assert.match(nginx, /listen 80 default_server/u);
  assert.match(nginx, /return 405/u);
  assert.match(nginx, /location \^~ \/v1\/ops/u);
  assert.match(nginx, /location \^~ \/v1\/shares\//u);
  assert.match(nginx, /location \^~ \/s\//u);
  assert.match(nginx, /proxy_set_header Authorization ""/u);
  assert.match(nginx, /proxy_set_header Cookie ""/u);
  assert.match(nginx, /proxy_set_header X-Spott-User-Id ""/u);
  assert.match(nginx, /proxy_set_header X-Spott-Role ""/u);
  for (const header of ['Version', 'Kid', 'Timestamp', 'Nonce', 'Signature']) {
    assert.match(nginx, new RegExp(`proxy_set_header X-Spott-BFF-${header} ""`, 'u'));
  }
  assert.doesNotMatch(nginx, /X-Spott-Web-Bff/u);
  assert.match(nginx, /map \$http_cookie \$spott_public_locale_cookie/u);
  assert.match(nginx, /proxy_set_header Cookie \$spott_public_locale_cookie/u);
  assert.match(nginx, /limit_req zone=spott_preview_web/u);
  assert.match(nginx, /limit_conn spott_preview_connections/u);
  assert.match(nginx, /gzip on/u);
  assert.match(nginx, /gzip_vary on/u);
  assert.match(nginx, /gzip_types[^;]+application\/javascript/su);
  assert.ok((nginx.match(/proxy_hide_header Set-Cookie/g) ?? []).length >= 2);
  assert.ok((nginx.match(/return 405/g) ?? []).length >= 2);
  assert.match(nginx, /X-Spott-Preview-Mode "read-only"/u);
  assert.match(nginx, /proxy_set_header X-Spott-Preview-Mode read-only/u);
  assert.match(nginx, /return 302 \/discover\?preview=readonly/u);
  assert.doesNotMatch(nginx, /proxy_pass\s+http:\/\/[^;]*(?:postgres|5432)/u);
});

test('deployment script validates config, migrates, seeds synthetic data, and proves health', () => {
  const deploy = source('deploy.sh');
  assert.match(deploy, /docker compose/u);
  assert.match(deploy, /config --quiet/u);
  assert.match(deploy, /run --rm migrate/u);
  assert.match(deploy, /run --rm seed/u);
  assert.match(deploy, /\/v1\/health/u);
  assert.match(deploy, /\/discover/u);
  assert.match(deploy, /nginx -t/u);
  assert.match(deploy, /flock/u);
  assert.match(deploy, /nginx_candidate/u);
  assert.match(deploy, /--app-only/u);
  assert.match(deploy, /MemAvailable/u);
  assert.match(deploy, /compose ps --quiet api web/u);
  assert.match(deploy, /df -Pk \/var\/lib\/docker/u);
  assert.match(deploy, /--max-time/u);
  assert.match(deploy, /ip-preview-'"\$release_id"'"/u);
  assert.match(deploy, /public "\$release_id"/u);
  assert.match(deploy, /internal "\$release_id"/u);
  assert.match(source('verify.sh'), /--max-time/u);
  assert.doesNotMatch(deploy, /git reset|docker system prune|rm -rf/u);
});

test('backup restore drill targets the immutable deployed release and existing Compose project', () => {
  const backup = source('backup-restore-check.sh');

  assert.match(backup, /release_directory=\$\(cd "\$release_root" && pwd -P\)/u);
  assert.match(backup, /release_id=\$\(basename "\$release_directory"\)/u);
  assert.match(backup, /\^\[a-f0-9\]\{12,64\}\$/u);
  assert.match(backup, /env "SPOTT_RELEASE_ID=\$release_id" docker compose/u);
  assert.match(backup, /--project-name spott-ip-preview/u);
  assert.match(backup, /pg_dump/u);
  assert.match(backup, /pg_restore/u);
  assert.match(backup, /exec -T postgres pg_restore --list <"\$dump_tmp"/u);
  assert.doesNotMatch(backup, /pg_restore --list -/u);
  assert.match(backup, /schema_migrations/u);
  assert.doesNotMatch(backup, /rm -f "\$dump_path" "\$checksum_path"/u);
  assert.doesNotMatch(backup, /dropdb[\s\S]{0,240}\|\| true/u);
  assert.match(backup, /Failed to remove restore-check database/u);
  assert.doesNotMatch(backup, /set -x|cat .*ip-preview\.env/u);
});

test('backup restore drill reports a throwaway-database cleanup failure', () => {
  const harness = runBackupDrillHarness('cleanup-fail');
  try {
    assert.notEqual(harness.result.status, 0);
    assert.match(harness.result.stderr, /Failed to remove restore-check database/u);
  } finally {
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

test('backup restore drill preserves a finalized dump if sidecar publication fails', () => {
  const harness = runBackupDrillHarness('finalize-fail');
  try {
    assert.notEqual(harness.result.status, 0);
    const dumps = readdirSync(harness.backup).filter(
      (name) => !name.startsWith('.') && name.endsWith('.dump'),
    );
    assert.equal(dumps.length, 1);
    assert.ok(statSync(join(harness.backup, dumps[0])).size > 0);
  } finally {
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

test('internal functional-test entry stays loopback-only and uses same-origin browser API calls', () => {
  const compose = source('compose.yaml');
  const internal = yaml.load(source('compose.internal.yaml'), { json: true });
  const nginx = source('nginx-spott.conf');
  const readme = source('README.md');

  assert.match(compose, /NEXT_PUBLIC_API_URL: \/v1/u);
  assert.equal(internal.services.api.environment.OTP_PROVIDER, 'console');
  assert.match(nginx, /listen 127\.0\.0\.1:8080/u);
  assert.match(nginx, /X-Spott-Preview-Mode "internal-test"/u);
  assert.match(nginx, /proxy_set_header X-Spott-Preview-Mode internal-test/u);
  assert.equal(
    nginx.match(/proxy_set_header X-Spott-Preview-Mode internal-test/g)?.length,
    2,
  );
  assert.equal(nginx.match(/proxy_set_header Host 18\.178\.203\.117/g)?.length, 2);
  assert.equal(nginx.match(/proxy_set_header Host \$http_host/g)?.length, 2);
  assert.match(nginx, /\$http_host !~\* \^\(\?:localhost\|127\\\.0\\\.0\\\.1\):8080\$/u);
  assert.doesNotMatch(nginx, /listen (?:0\.0\.0\.0:)?8080/u);
  assert.match(readme, /ssh -N -L 8080:127\.0\.0\.1:8080/u);
  assert.match(readme, /Do not expose port 8080/u);
  assert.match(source('verify.sh'), /307 http:\/\/18\.178\.203\.117\/discover/u);
  assert.match(source('verify.sh'), /307 \$\{origin\}\/discover/u);
  assert.match(source('verify.sh'), /Rendered discovery response leaked an absolute build path/u);
  assert.match(source('verify.sh'), /assets\/_vinext_fonts/u);
});

test('OTP helper extracts only the latest exact email or phone match', () => {
  const parser = join(deploymentRoot, 'extract-latest-otp.awk');
  const log = [
    'unrelated code=000000',
    '[Spott OTP] email=other@example.invalid code=111111',
    '[Spott OTP] email=internal-tester@example.invalid code=222222 extra=ignored',
    '[Spott OTP] user=11111111-1111-1111-1111-111111111111 phone=+819012345678 code=333333',
    '[Spott OTP] phone=+8190123456789 code=444444',
    '[Spott OTP] email=internal-tester@example.invalid code=55x555',
    '[Spott OTP] email=internal-tester@example.invalid code=666666',
  ].join('\n');
  const extract = (kind, subject) => execFileSync(
    '/usr/bin/awk',
    ['-v', `kind=${kind}`, '-v', `subject=${subject}`, '-f', parser],
    { input: log, encoding: 'utf8' },
  ).trim();

  assert.equal(extract('email', 'internal-tester@example.invalid'), '666666');
  assert.equal(extract('phone', '+819012345678'), '333333');
  assert.equal(extract('email', 'missing@example.invalid'), '');
  const helper = source('latest-otp.sh');
  assert.match(helper, /extract-latest-otp\.awk/u);
  assert.doesNotMatch(helper, /grep -F/u);
});

test('preview seed is synthetic, future-relative, and creates no privileged or account state', () => {
  const seed = readFileSync(join(repositoryRoot, 'database/seeds/ip-preview.sql'), 'utf8');
  assert.match(seed, /interval '8 days'/u);
  assert.match(seed, /Synthetic public-preview data only/u);
  assert.match(seed, /primary_locale/u);
  assert.match(seed, /supported_locales/u);
  assert.match(seed, /locale_confirmed_at/u);
  assert.match(seed, /ON CONFLICT \(user_id\) DO UPDATE/su);
  assert.match(seed, /ON CONFLICT \(id\) DO UPDATE/su);
  assert.match(seed, /preview_event\.organizer_id = EXCLUDED\.organizer_id/u);
  assert.match(seed, /md5\(preview_profile\.bio\) IN/u);
  assert.match(seed, /md5\(preview_event\.description\) IN/u);
  const capacitySeed = seed.slice(
    seed.indexOf('INSERT INTO events.event_capacity'),
    seed.indexOf('INSERT INTO events.event_locations'),
  );
  assert.match(capacitySeed, /ON CONFLICT \(event_id\) DO NOTHING;/u);
  assert.doesNotMatch(capacitySeed, /DO UPDATE/u);
  assert.doesNotMatch(
    seed,
    /'[^']*(?:Synthetic preview|合成预览|界面预览|プレビュー専用)[^']*'/u,
  );
  assert.doesNotMatch(
    seed,
    /admin\.|identity\.(?:sessions|devices|auth_identities|phone_bindings)|commerce\.(?:wallets|point_)/u,
  );
});

test('preview seed gives the public community routes substantive read-only content', () => {
  const seed = readFileSync(join(repositoryRoot, 'database/seeds/ip-preview.sql'), 'utf8');
  assert.match(seed, /INSERT INTO community\.groups AS preview_group/u);
  assert.match(seed, /INSERT INTO community\.group_memberships AS preview_membership/u);
  assert.match(seed, /INSERT INTO community\.announcements AS preview_announcement/u);
  assert.match(seed, /'东京慢走与光线观察'/u);
  assert.match(seed, /'下北沢一枚聴く会'/u);
  assert.match(seed, /'public'/u);
  assert.match(seed, /group_id = EXCLUDED\.group_id/u);
});
