import { z } from 'zod';

const developmentFieldKey = Buffer.alloc(32).toString('base64');
const booleanFromEnvironment = z.preprocess(
  (value) => value === true || value === 'true' || value === '1',
  z.boolean(),
);
const optionalString = z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  WORKER_ID: z.string().min(3).default(`worker-${process.pid}`),
  WORKER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(12),

  FIELD_ENCRYPTION_KEY_BASE64: z.string().default(developmentFieldKey),

  OBJECT_STORE_PROVIDER: z.enum(['s3', 'disabled']).default('s3'),
  S3_ENDPOINT: z.string().url().default('http://127.0.0.1:9100'),
  S3_REGION: z.string().min(1).default('ap-northeast-1'),
  S3_BUCKET: z.string().min(3).default('spott-media'),
  S3_ACCESS_KEY_ID: z.string().min(1).default('spott-local'),
  S3_SECRET_ACCESS_KEY: z.string().min(8).default('spott-local-secret'),
  S3_FORCE_PATH_STYLE: booleanFromEnvironment.default(true),
  MEDIA_PUBLIC_ORIGIN: z.string().url().default('http://127.0.0.1:9100/spott-media'),
  MEDIA_MAX_PIXELS: z.coerce.number().int().min(1_000_000).max(200_000_000).default(50_000_000),
  MEDIA_SCAN_PROVIDER: z.enum(['clamav', 'disabled']).default('disabled'),
  CLAMAV_HOST: z.string().min(1).default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65_535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(30_000),

  EMAIL_PROVIDER: z.enum(['smtp', 'console', 'disabled']).default('console'),
  SMTP_HOST: z.string().min(1).default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(1025),
  SMTP_SECURE: booleanFromEnvironment.default(false),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_FROM: z.string().min(3).default('Spott <notifications@spott.local>'),

  PUSH_PROVIDER: z.enum(['apns', 'console', 'disabled']).default('console'),
  APNS_TEAM_ID: optionalString,
  APNS_KEY_ID: optionalString,
  APNS_BUNDLE_ID: z.string().min(3).default('com.yaokai.Spott'),
  APNS_PRIVATE_KEY: optionalString,
}).superRefine((value, context) => {
  const fieldKey = Buffer.from(value.FIELD_ENCRYPTION_KEY_BASE64, 'base64');
  if (fieldKey.byteLength !== 32) {
    context.addIssue({ code: 'custom', path: ['FIELD_ENCRYPTION_KEY_BASE64'], message: 'must decode to exactly 32 bytes' });
  }
  if (value.NODE_ENV !== 'production') return;
  if (value.FIELD_ENCRYPTION_KEY_BASE64 === developmentFieldKey) {
    context.addIssue({ code: 'custom', path: ['FIELD_ENCRYPTION_KEY_BASE64'], message: 'development key is forbidden in production' });
  }
  if (value.OBJECT_STORE_PROVIDER !== 's3') {
    context.addIssue({ code: 'custom', path: ['OBJECT_STORE_PROVIDER'], message: 'production media storage cannot be disabled' });
  }
  if (value.MEDIA_SCAN_PROVIDER !== 'clamav') {
    context.addIssue({ code: 'custom', path: ['MEDIA_SCAN_PROVIDER'], message: 'production malware scanning cannot be disabled' });
  }
  if (value.EMAIL_PROVIDER !== 'smtp') {
    context.addIssue({ code: 'custom', path: ['EMAIL_PROVIDER'], message: 'production email must use SMTP' });
  }
  if (value.PUSH_PROVIDER !== 'apns') {
    context.addIssue({ code: 'custom', path: ['PUSH_PROVIDER'], message: 'production push must use APNs' });
  }
  for (const key of ['APNS_TEAM_ID', 'APNS_KEY_ID', 'APNS_PRIVATE_KEY'] as const) {
    if (!value[key]) context.addIssue({ code: 'custom', path: [key], message: 'is required for production APNs' });
  }
});

export type WorkerConfig = z.infer<typeof schema>;

export function parseConfig(environment: NodeJS.ProcessEnv): WorkerConfig {
  return schema.parse(environment);
}

export function loadConfig(): WorkerConfig {
  return parseConfig(process.env);
}
