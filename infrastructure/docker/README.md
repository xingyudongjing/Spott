# Spott local services

Run the complete local data, media and delivery stack from the repository root:

```bash
docker compose -f infrastructure/docker/compose.yaml up --build
```

The stack exposes PostgreSQL on `55432`, Redis on `6379`, the S3-compatible MinIO API on `9100`, the MinIO console on `9101`, SMTP on `1025`, and the Mailpit inbox on `8025`.

The MinIO development policy deliberately permits unauthenticated `PUT` only below `original/`, matching the current API upload-intent contract. It permits public `GET` only below `public/`; report evidence and original uploads remain private. Never use this development policy in production. Production must use short-lived, signed S3 upload URLs and a private bucket/CDN origin.

The worker scans uploaded bytes with ClamAV, verifies the declared byte count and SHA-256 hash, decodes the image with a pixel limit, and writes immutable WebP derivatives. Mail is delivered to Mailpit through real SMTP. Development push delivery is logged; production configuration validation requires APNs credentials and rejects console or disabled providers.
