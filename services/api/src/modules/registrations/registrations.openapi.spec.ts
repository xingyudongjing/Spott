import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../../../..');
const forbiddenSummaryFields = [
  'description',
  'exactAddress',
  'coordinate',
  'joinURL',
  'joinInstructions',
  'registrationQuestions',
  'organizer',
];

describe('registration itinerary OpenAPI contract', () => {
  it('publishes the exact page wrapper and generated client types', () => {
    const source = readFileSync(resolve(repositoryRoot, 'packages/contracts/openapi.yaml'), 'utf8');
    const bundle = readFileSync(resolve(repositoryRoot, 'packages/contracts/openapi.bundle.yaml'), 'utf8');
    const generated = readFileSync(resolve(repositoryRoot, 'packages/api-client/src/schema.d.ts'), 'utf8');

    expect(source).toMatch(
      /\/me\/registrations:[\s\S]*?schema: \{ \$ref: '#\/components\/schemas\/RegistrationItineraryPage' \}/,
    );
    for (const artifact of [source, bundle, generated]) {
      expect(artifact).toContain('ItineraryEventSummary');
      expect(artifact).toContain('RegistrationItineraryItem');
      expect(artifact).toContain('RegistrationItineraryPage');
    }
    expect(generated).toMatch(
      /RegistrationItineraryPage:[\s\S]*?items: components\["schemas"\]\["RegistrationItineraryItem"\]\[\];[\s\S]*?serverTime: string;/,
    );
  });

  it('limits itinerary event summaries to the approved privacy-safe property set', () => {
    const source = readFileSync(resolve(repositoryRoot, 'packages/contracts/openapi.yaml'), 'utf8');
    const summary = source.match(/ {4}ItineraryEventSummary:[\s\S]*?(?=\n {4}RegistrationItineraryItem:)/)?.[0];

    expect(summary).toBeDefined();
    expect(summary).toContain('additionalProperties: false');
    expect(summary).toContain('required: [id, publicSlug, status, title, startsAt, endsAt, displayTimeZone, region, publicArea, coverURL, format, primaryLocale, localeConfirmed, version, updatedAt]');
    for (const field of forbiddenSummaryFields) expect(summary).not.toContain(`${field}:`);
  });
});
