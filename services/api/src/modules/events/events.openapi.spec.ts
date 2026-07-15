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
});
