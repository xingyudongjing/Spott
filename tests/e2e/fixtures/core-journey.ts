import { pathToFileURL } from "node:url";

import { Client } from "pg";

export const CORE_JOURNEY_FIXTURE = {
  hostUserId: "019d0000-0000-7000-8000-000000000001",
  capacityUserId: "019d0000-0000-7000-8000-000000000002",
  automatic: {
    id: "019d0000-0000-7000-8100-000000000001",
    slug: "core-journey-auto",
    title: "Tokyo Design Walk · Core Journey",
    booleanQuestionId: "019d0000-0000-7000-8110-000000000001",
  },
  approval: {
    id: "019d0000-0000-7000-8100-000000000002",
    slug: "core-journey-approval",
    title: "Kiyosumi Creative Table",
    choiceQuestionId: "019d0000-0000-7000-8110-000000000002",
  },
  waitlist: {
    id: "019d0000-0000-7000-8100-000000000003",
    slug: "core-journey-waitlist",
    title: "Yanaka Night Photo Walk",
  },
  completedHistoryEventId: "019d0000-0000-7000-8100-000000000004",
  capacityRegistrationId: "019d0000-0000-7000-8120-000000000001",
} as const;

const millisecondsPerDay = 86_400_000;

export function assertIsolatedTestDatabase(databaseURL: string): URL {
  const parsed = new URL(databaseURL);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.endsWith("_test")) {
    throw new Error(
      `Refusing to seed non-test database "${databaseName || "(missing)"}". `
      + "The database name must end in _test.",
    );
  }
  return parsed;
}

export async function seedCoreJourneyFixture(databaseURL: string): Promise<void> {
  assertIsolatedTestDatabase(databaseURL);
  const client = new Client({ connectionString: databaseURL });
  const startsAt = new Date(Date.now() + (7 * millisecondsPerDay));
  startsAt.setUTCMinutes(0, 0, 0);
  const endsAt = new Date(startsAt.getTime() + (2 * 60 * 60 * 1_000));
  const deadlineAt = new Date(startsAt.getTime() - millisecondsPerDay);
  const completedStartsAt = new Date(Date.now() - (30 * millisecondsPerDay));
  const completedEndsAt = new Date(completedStartsAt.getTime() + (2 * 60 * 60 * 1_000));
  const f = CORE_JOURNEY_FIXTURE;

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO identity.users(id, public_handle, phone_verified_at)
       VALUES ($1, 'core_journey_host', clock_timestamp()),
              ($2, 'core_journey_capacity', clock_timestamp())`,
      [f.hostUserId, f.capacityUserId],
    );
    await client.query(
      `INSERT INTO identity.profiles(
         user_id, nickname, bio, region_id, source_language, preferred_locale, content_languages
       ) VALUES
         ($1, '东京共创局', '在东京组织小型、清晰、认真的创意聚会。', 'tokyo', 'ja', 'ja', ARRAY['zh-Hans','ja','en']),
         ($2, '测试名额用户', '', 'tokyo', 'ja', 'ja', ARRAY['ja'])`,
      [f.hostUserId, f.capacityUserId],
    );
    await client.query(
      `INSERT INTO events.events(
         id, public_slug, organizer_id, status, title, description, category_id,
         starts_at, ends_at, deadline_at, display_time_zone, capacity,
         registration_mode, waitlist_enabled, tags, attendee_requirements,
         format, primary_locale, supported_locales, locale_confirmed_at,
         created_by, updated_by
       ) VALUES
         ($1,$2,$4,'published',$3,
          '从街区建筑、字体与公共空间出发，与真正想要交流的人走完一段东京。',
          'art',$5,$6,$7,'Asia/Tokyo',100,'automatic',true,
          ARRAY['design','city-walk','tokyo'],
          '请穿适合步行的鞋，并携带饮用水。',
          'in_person','ja',ARRAY['zh-Hans','ja','en'],clock_timestamp(),$4,$4),
         ($8,$9,$4,'published',$10,
          '小组共创桌，主办方会在报名后根据目标和席位进行确认。',
          'learning',$5,$6,$7,'Asia/Tokyo',100,'approval',true,
          ARRAY['creative','learning'],NULL,
          'in_person','ja',ARRAY['zh-Hans','ja','en'],clock_timestamp(),$4,$4),
         ($11,$12,$4,'published',$13,
          '夜色与街巷摄影活动，名额已满时会进入候补。',
          'city-walk',$5,$6,$7,'Asia/Tokyo',2,'automatic',true,
          ARRAY['photo','night-walk'],NULL,
          'in_person','ja',ARRAY['zh-Hans','ja','en'],clock_timestamp(),$4,$4)`,
      [
        f.automatic.id,
        f.automatic.slug,
        f.automatic.title,
        f.hostUserId,
        startsAt,
        endsAt,
        deadlineAt,
        f.approval.id,
        f.approval.slug,
        f.approval.title,
        f.waitlist.id,
        f.waitlist.slug,
        f.waitlist.title,
      ],
    );
    await client.query(
      `INSERT INTO events.events(
         id, public_slug, organizer_id, status, title, description, category_id,
         starts_at, ends_at, deadline_at, capacity, registration_mode,
         waitlist_enabled, format, primary_locale, supported_locales,
         locale_confirmed_at, created_by, updated_by
       ) VALUES ($1,'core-journey-history',$2,'ended','Past Core Journey',
         '用于验证主办经历的已完成活动。','art',$3,$4,$3,20,
         'automatic',true,'in_person','ja',ARRAY['ja'],clock_timestamp(),$2,$2)`,
      [f.completedHistoryEventId, f.hostUserId, completedStartsAt, completedEndsAt],
    );
    await client.query(
      `INSERT INTO events.event_capacity(event_id, confirmed_count, pending_count, waitlist_count, offered_count)
       VALUES ($1,0,0,0,0),($2,0,0,0,0),($3,2,0,0,0),($4,3,0,0,0)`,
      [f.automatic.id, f.approval.id, f.waitlist.id, f.completedHistoryEventId],
    );
    await client.query(
      `INSERT INTO events.event_locations(
         event_id, region_id, public_area, point, visibility, exact_address_visibility
       ) VALUES
         ($1,'tokyo','清澄白河站附近',ST_GeogFromText('POINT(139.7997 35.6826)'),'confirmed_only','confirmed'),
         ($2,'tokyo','清澄庭园附近',ST_GeogFromText('POINT(139.7977 35.6812)'),'confirmed_only','confirmed'),
         ($3,'tokyo','谷中银座附近',ST_GeogFromText('POINT(139.7668 35.7270)'),'confirmed_only','confirmed')`,
      [f.automatic.id, f.approval.id, f.waitlist.id],
    );
    await client.query(
      `INSERT INTO events.event_fees(
         event_id, is_free, amount_jpy, collector_name, method,
         payment_deadline_text, refund_policy
       ) VALUES
         ($1,true,NULL,NULL,NULL,NULL,NULL),
         ($2,false,1800,'东京共创局','现场 PayPay','活动开始前 24 小时','活动开始前 48 小时可全额退款'),
         ($3,true,NULL,NULL,NULL,NULL,NULL)`,
      [f.automatic.id, f.approval.id, f.waitlist.id],
    );
    await client.query(
      `INSERT INTO events.registration_questions(
         id, event_id, prompt, kind, required, options, sort_order
       ) VALUES
         ($1,$2,'是否可以完成约 4 公里步行？','boolean',true,'[]'::jsonb,0),
         ($3,$4,'你更想加入哪个主题桌？','single_choice',true,
          '["Product design","Local culture","Creative coding"]'::jsonb,0)`,
      [
        f.automatic.booleanQuestionId,
        f.automatic.id,
        f.approval.choiceQuestionId,
        f.approval.id,
      ],
    );
    await client.query(
      `INSERT INTO events.registrations(
         id, event_id, user_id, status, party_size, confirmed_at
       ) VALUES ($1,$2,$3,'confirmed',2,clock_timestamp())`,
      [f.capacityRegistrationId, f.waitlist.id, f.capacityUserId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databaseURL = process.env.DATABASE_URL;
  if (!databaseURL) throw new Error("DATABASE_URL is required");
  await seedCoreJourneyFixture(databaseURL);
  console.info(`core journey fixture applied to ${new URL(databaseURL).pathname.slice(1)}`);
}
