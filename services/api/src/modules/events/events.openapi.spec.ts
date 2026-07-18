import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../../../..');

describe('event collection OpenAPI contracts', () => {
  it('declares favorites as summary items in every generated contract artifact', () => {
    const source = readFileSync(resolve(repositoryRoot, 'packages/contracts/openapi.yaml'), 'utf8');
    const bundle = readFileSync(resolve(repositoryRoot, 'packages/contracts/openapi.bundle.yaml'), 'utf8');
    const generated = readFileSync(resolve(repositoryRoot, 'packages/api-client/src/schema.d.ts'), 'utf8');

    expect(source).toMatch(
      /\/me\/favorite-events:[\s\S]*?schema: \{ \$ref: '#\/components\/schemas\/EventSummaryItems' \}/,
    );
    expect(source).toMatch(
      /EventSummaryItems:[\s\S]*?items: \{ \$ref: '#\/components\/schemas\/EventSummary' \}/,
    );
    expect(bundle).toContain("$ref: '#/components/schemas/EventSummaryItems'");
    expect(generated).toContain('EventSummaryItems:');
    expect(generated).toMatch(/EventSummaryItems:[\s\S]*?items: components\["schemas"\]\["EventSummary"\]\[\];/);
  });

  it('publishes organizer contact only as a nullable event-detail field and draft input', () => {
    const source = readFileSync(resolve(repositoryRoot, 'packages/contracts/openapi.yaml'), 'utf8');
    const bundle = readFileSync(resolve(repositoryRoot, 'packages/contracts/openapi.bundle.yaml'), 'utf8');
    const generated = readFileSync(resolve(repositoryRoot, 'packages/api-client/src/schema.d.ts'), 'utf8');

    for (const artifact of [source, bundle, generated]) {
      expect(artifact).toContain('OrganizerContact');
      expect(artifact).toContain('organizerContact');
    }
    expect(generated).toMatch(
      /OrganizerContact: components\["schemas"\]\["OrganizerEmailContact"\] \| components\["schemas"\]\["OrganizerLineContact"\] \| components\["schemas"\]\["OrganizerWebsiteContact"\]/,
    );
    expect(generated).not.toContain('kind: "OrganizerContact"');
    expect(source).toMatch(
      /EventDetail:[\s\S]*?required:[\s\S]*?- organizerContact[\s\S]*?organizerContact:[\s\S]*?OrganizerContact/,
    );
    expect(source).toMatch(
      /EventDraftInput:[\s\S]*?organizerContact:[\s\S]*?OrganizerContact/,
    );
    const emailContact = source.match(/ {4}OrganizerEmailContact:[\s\S]*?(?=\n {4}\w)/)?.[0];
    const lineContact = source.match(/ {4}OrganizerLineContact:[\s\S]*?(?=\n {4}\w)/)?.[0];
    const websiteContact = source.match(/ {4}OrganizerWebsiteContact:[\s\S]*?(?=\n {4}\w)/)?.[0];
    expect(emailContact).toContain('const: email');
    expect(emailContact).toContain('format: email');
    expect(lineContact).toContain('const: line');
    expect(lineContact).toContain('pattern:');
    expect(websiteContact).toContain('const: website');
    expect(websiteContact).toContain("pattern: '^https://'");
    const summary = source.match(/ {4}EventSummaryBase:[\s\S]*?(?=\n {4}EventSummary:)/)?.[0];
    expect(summary).toBeDefined();
    expect(summary).not.toContain('organizerContact');
  });
});
