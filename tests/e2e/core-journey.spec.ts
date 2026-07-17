import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { Client } from 'pg';

import { assertIsolatedTestDatabase, CORE_JOURNEY_FIXTURE } from './fixtures/core-journey.js';

type Locale = 'zh-Hans' | 'ja' | 'en';
type RegistrationStatus = 'confirmed' | 'pending' | 'waitlisted';
type ItineraryTab = 'upcoming' | 'pending' | 'waitlist';

interface JourneyEvent {
  id: string;
  slug: string;
  title: string;
  questionId?: string;
  answer?: 'true' | 'Product design';
  paid?: boolean;
}

interface JourneyResult {
  status: RegistrationStatus;
  itineraryTab: ItineraryTab;
}

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000';
const outputRoot =
  process.env.SPOTT_E2E_OUTPUT_DIR ?? path.resolve('output/playwright/core-journey');

const copy: Record<
  Locale,
  {
    confirmed: string;
    pending: string;
    waitlisted: string;
  }
> = {
  'zh-Hans': {
    confirmed: '报名已确认',
    pending: '正在等待主办方确认',
    waitlisted: '已加入候补',
  },
  ja: {
    confirmed: '参加が確定しました',
    pending: '主催者の承認待ちです',
    waitlisted: 'キャンセル待ちに登録しました',
  },
  en: {
    confirmed: 'Registration confirmed',
    pending: 'Awaiting host approval',
    waitlisted: 'You’re on the waitlist',
  },
};

const automatic: JourneyEvent = {
  ...CORE_JOURNEY_FIXTURE.automatic,
  questionId: CORE_JOURNEY_FIXTURE.automatic.booleanQuestionId,
  answer: 'true',
};
const approval: JourneyEvent = {
  ...CORE_JOURNEY_FIXTURE.approval,
  questionId: CORE_JOURNEY_FIXTURE.approval.choiceQuestionId,
  answer: 'Product design',
  paid: true,
};
const waitlist: JourneyEvent = { ...CORE_JOURNEY_FIXTURE.waitlist };

test.describe.configure({ mode: 'serial' });

test('fixture refuses to mutate a non-test database', () => {
  expect(() => assertIsolatedTestDatabase('postgres://127.0.0.1/spott')).toThrow(
    /Refusing to seed non-test database/,
  );
});

for (const scenario of [
  {
    name: 'automatic registration',
    event: automatic,
    result: { status: 'confirmed', itineraryTab: 'upcoming' },
  },
  {
    name: 'approval registration',
    event: approval,
    result: { status: 'pending', itineraryTab: 'pending' },
  },
  {
    name: 'full event waitlist',
    event: waitlist,
    result: { status: 'waitlisted', itineraryTab: 'waitlist' },
  },
] as const) {
  test(`${scenario.name} reaches its authoritative itinerary state`, async ({ context, page }) => {
    await applyLocale(context, 'en');
    const pageErrors = collectPageErrors(page);
    await completeJourney(
      page,
      scenario.event,
      scenario.result,
      `status-${scenario.result.status}`,
    );
    await assertItinerary(page, scenario.event.title, scenario.result.itineraryTab);
    expect(pageErrors, 'uncaught browser errors').toEqual([]);
  });
}

test('discovery preserves real content through loading, empty, and offline refresh states', async ({
  context,
  page,
}) => {
  await applyLocale(context, 'en');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const pageErrors = collectPageErrors(page, false);
  await page.goto('/discover');
  const shell = page.locator('main > section');
  const search = page.locator('input[type="search"]');
  await expect(
    page.getByTestId('discovery-event').filter({ hasText: automatic.title }),
  ).toBeVisible();
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  );

  let releaseSearch!: () => void;
  let markSearchIntercepted!: () => void;
  let markSearchContinued!: () => void;
  const searchGate = new Promise<void>((resolve) => {
    releaseSearch = resolve;
  });
  const searchIntercepted = new Promise<void>((resolve) => {
    markSearchIntercepted = resolve;
  });
  const searchContinued = new Promise<void>((resolve) => {
    markSearchContinued = resolve;
  });
  const approvalSearch = (url: URL) =>
    url.pathname === '/v1/events/search' && url.searchParams.get('q') === approval.title;
  await page.route(
    approvalSearch,
    async (route) => {
      markSearchIntercepted();
      await searchGate;
      await route.continue();
      markSearchContinued();
    },
    { times: 1 },
  );
  await search.fill(approval.title);
  await searchIntercepted;
  await expect(shell).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('status')).toContainText('Updating events');
  releaseSearch();
  await searchContinued;
  await expect(
    page.getByTestId('discovery-event').filter({ hasText: approval.title }),
  ).toBeVisible();

  await search.fill('zzqxvnomatch9472');
  await expect(page.getByTestId('discovery-event')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'No events match these filters yet' }),
  ).toBeVisible();

  await search.fill(automatic.title);
  const preserved = page.getByTestId('discovery-event').filter({ hasText: automatic.title });
  await expect(preserved).toBeVisible();
  await context.setOffline(true);
  await search.fill(waitlist.title);
  await expect(page.getByRole('status')).toContainText('could not be refreshed');
  await expect(preserved).toBeVisible();
  await expect(shell).toHaveAttribute('aria-busy', 'false');
  await context.setOffline(false);
  expect(pageErrors, 'uncaught browser errors').toEqual([]);
});

test('409 event changes require an explicit live reconfirmation', async ({ context, page }) => {
  await applyLocale(context, 'en');
  const pageErrors = collectPageErrors(page, false);
  await openRegistration(page, automatic, 'changed-409');
  await fillRegistrationDetails(page, automatic);
  const reviewSubmit = await advanceToReview(page);
  await bumpEventVersion(automatic.id);
  await reviewSubmit.click();

  const reconfirmation = page.locator('form input[type="checkbox"]');
  await expect(reconfirmation).toBeVisible();
  await expect(page.locator('form')).toContainText('The event was just updated');
  await reconfirmation.check();
  await expect(reviewSubmit).toBeEnabled({ timeout: 20_000 });
  await reviewSubmit.click();
  await expect(page.locator('main h1')).toHaveText(copy.en.confirmed);
  await assertItinerary(page, automatic.title, 'upcoming');
  expect(pageErrors, 'uncaught browser errors').toEqual([]);
});

const locales: Locale[] = ['zh-Hans', 'ja', 'en'];
const colorSchemes = ['light', 'dark'] as const;
const viewports = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 1024 },
] as const;

let visualIdentity = 100;
for (const locale of locales) {
  for (const colorScheme of colorSchemes) {
    for (const viewport of viewports) {
      test(`visual evidence ${locale} / ${colorScheme} / ${viewport.name}`, async ({
        context,
        page,
      }) => {
        const identity = visualIdentity++;
        const directory = path.join(outputRoot, locale, colorScheme, viewport.name);
        await mkdir(directory, { recursive: true });
        await applyLocale(context, locale);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        const pageErrors = collectPageErrors(page);

        await completeJourney(
          page,
          automatic,
          { status: 'confirmed', itineraryTab: 'upcoming' },
          `visual-${identity}`,
          async (stage) => capture(page, path.join(directory, `${stage}.png`)),
        );
        await capture(page, path.join(directory, '04-confirmation.png'));
        await assertItinerary(page, automatic.title, 'upcoming');
        await capture(page, path.join(directory, '05-itinerary.png'));
        expect(pageErrors, 'uncaught browser errors').toEqual([]);
      });
    }
  }
}

async function completeJourney(
  page: Page,
  event: JourneyEvent,
  result: JourneyResult,
  identity: string,
  captureStage?: (stage: string) => Promise<void>,
): Promise<void> {
  await openRegistration(page, event, identity, captureStage);
  await fillRegistrationDetails(page, event);
  await captureStage?.('03-registration');
  const reviewSubmit = await advanceToReview(page);
  await reviewSubmit.click();

  await expect(page.locator('main h1')).toHaveText(copy[await currentLocale(page)][result.status]);
  await expect(page.locator('a[href="/me/events"]')).toBeVisible();
}

async function openRegistration(
  page: Page,
  event: JourneyEvent,
  identity: string,
  captureStage?: (stage: string) => Promise<void>,
): Promise<void> {
  await page.goto('/discover');
  const search = page.locator('input[type="search"]');
  await expect(search).toBeVisible();
  await search.fill(event.title);
  const card = page.getByTestId('discovery-event').filter({ hasText: event.title });
  await expect(card).toHaveCount(1);
  await expect(card).toBeVisible();
  await captureStage?.('01-discovery');

  await card.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/e/${escapeRegExp(event.slug)}$`));
  await expect(page.locator('main h1')).toContainText(event.title);
  await expect(page.locator('[data-event-primary]')).toHaveCount(1);
  await captureStage?.('02-event-detail');

  await page.locator('[data-event-primary]').click();
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await authenticate(page, identity, event.slug);

  await expect(page).toHaveURL(new RegExp(`/register/${escapeRegExp(event.slug)}$`));
  await expect(page.locator('#registration-partySize')).toBeVisible();
}

async function fillRegistrationDetails(page: Page, event: JourneyEvent): Promise<void> {
  if (event.questionId && event.answer) {
    await page.locator(`#registration-answer-${event.questionId}`).selectOption(event.answer);
  }
  if (event.paid) await page.locator('#registration-terms').check();
}

async function advanceToReview(page: Page) {
  const detailsSubmit = page.locator('form button[type="submit"]');
  await expect(detailsSubmit).toBeEnabled();
  await detailsSubmit.click();
  await expect(page.locator('#registration-partySize')).toHaveCount(0);
  const reviewSubmit = page.locator('form button[type="submit"]');
  await expect(reviewSubmit).toBeEnabled({ timeout: 20_000 });
  return reviewSubmit;
}

async function authenticate(page: Page, identity: string, eventSlug: string): Promise<void> {
  const suffix = numericIdentity(identity);
  const email = `core-${identity}@e2e.spott.test`;
  const phone = `0901000${String(suffix).padStart(4, '0')}`;

  await page.locator('form.login-form input[type="email"]').fill(email);
  await page.locator('form.login-form button.primary-action').click();
  const emailCode = page.locator('form.login-form input[inputmode="numeric"]');
  await expect(emailCode).toHaveValue(/^\d{6}$/);
  await page.locator('form.login-form button.primary-action').click();

  await expect(page).toHaveURL(/\/phone-verification\?returnTo=/, { timeout: 20_000 });
  await page.locator('input[type="tel"]').fill(phone);
  await page.locator('form.flow-card button.primary-action').click();
  const phoneCode = page.locator('form.flow-card input[inputmode="numeric"]');
  await expect(phoneCode).toHaveValue(/^\d{6}$/);
  await page.locator('form.flow-card button.primary-action').click();
  await expect(page).toHaveURL(new RegExp(`/register/${escapeRegExp(eventSlug)}$`), {
    timeout: 20_000,
  });
}

async function assertItinerary(page: Page, eventTitle: string, tab: ItineraryTab): Promise<void> {
  await page.locator('a[href="/me/events"]').click();
  await expect(page).toHaveURL(/\/me\/events$/);
  const tabButton = page.locator(`#itinerary-tab-${tab}`);
  await expect(tabButton).toBeVisible();
  await tabButton.click();
  await expect(tabButton).toHaveAttribute('aria-selected', 'true');
  const panel = page.locator(`#itinerary-panel-${tab}`);
  await expect(panel).toContainText(eventTitle);
  await expect(panel.getByTestId('itinerary-primary-action')).toHaveCount(1);

  const tabs = ['upcoming', 'waitlist', 'pending', 'past'] as const;
  const next = tabs[(tabs.indexOf(tab) + 1) % tabs.length]!;
  await tabButton.focus();
  await tabButton.press('ArrowRight');
  await expect(page.locator(`#itinerary-tab-${next}`)).toHaveAttribute('aria-selected', 'true');
  await page.locator(`#itinerary-tab-${next}`).press('ArrowLeft');
  await expect(tabButton).toHaveAttribute('aria-selected', 'true');
}

async function bumpEventVersion(eventId: string): Promise<void> {
  const databaseURL = process.env.SPOTT_TEST_DATABASE_URL;
  if (!databaseURL) {
    throw new Error('SPOTT_TEST_DATABASE_URL is required for the real 409 journey');
  }
  const client = new Client({ connectionString: databaseURL });
  await client.connect();
  try {
    const result = await client.query(
      `UPDATE events.events
       SET version = version + 1, updated_at = clock_timestamp()
       WHERE id = $1`,
      [eventId],
    );
    if (result.rowCount !== 1)
      throw new Error(`Expected one event update, received ${result.rowCount ?? 0}`);
  } finally {
    await client.end();
  }
}

async function applyLocale(context: BrowserContext, locale: Locale): Promise<void> {
  await context.addCookies([{ name: 'spott_locale', value: locale, url: baseURL }]);
  await context.addInitScript((selectedLocale) => {
    try {
      window.localStorage.setItem('spott_locale', selectedLocale);
    } catch {
      // The server cookie remains authoritative when storage is unavailable.
    }
  }, locale);
}

async function currentLocale(page: Page): Promise<Locale> {
  const locale = await page.locator('html').getAttribute('lang');
  if (locale === 'zh-Hans' || locale === 'ja' || locale === 'en') return locale;
  throw new Error(`Unexpected document locale: ${locale ?? 'missing'}`);
}

async function capture(page: Page, filePath: string): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({
    path: filePath,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  });
}

function collectPageErrors(page: Page, includeConsoleErrors = true): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  if (includeConsoleErrors) {
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
  }
  return errors;
}

function numericIdentity(identity: string): number {
  const digits = identity.replace(/\D/g, '');
  if (digits) return Number(digits) % 10_000;
  let value = 0;
  for (const character of identity) value = (value * 31 + character.charCodeAt(0)) % 10_000;
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
