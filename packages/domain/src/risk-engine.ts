/**
 * 活动风险引擎：命中规则 -> 分数 -> 解释 -> 建议路线。
 *
 * 这里只放纯函数。规则与阈值由调用方从 admin.config_revisions 读取后传入，
 * 运营后台改一条 config revision 即可调整，无需发版；
 * 下面的 defaultRiskEngineConfig 只是服务端兜底基线，客户端拿不到也改不动。
 * 客户端自报的 riskFlags 只作为输入信号之一，绝不作为结论。
 */

export const riskRoutes = ['auto_approve', 'sample', 'manual_review', 'prohibit'] as const;

export type RiskRoute = (typeof riskRoutes)[number];

/** 产品文档 M3 的六类风险活动，外加禁止类。 */
export const riskTypes = [
  'alcohol_late_night',
  'minors',
  'outdoor_water',
  'high_value_fee',
  'professional_investment',
  'gender_restricted',
  'prohibited_content',
] as const;

export type RiskType = (typeof riskTypes)[number];

export interface RiskRule {
  /** 规则稳定标识，用于运营后台引用与审计。 */
  key: string;
  riskType: string;
  /** 命中即视为触发的关键词（大小写不敏感，按原文子串匹配）。 */
  keywords: readonly string[];
  /** 命中后累加的分数。 */
  score: number;
  /** 禁止类规则：命中即拒绝，不计分数与阈值。 */
  prohibited: boolean;
  /** 给运营与局头看的稳定解释文案。 */
  explanation: string;
}

export interface RiskEngineConfig {
  rules: readonly RiskRule[];
  /** 达到或超过该分数进入人工审核。 */
  manualReviewThreshold: number;
  /** 普通活动进入人工抽样审核的比例，0..1。 */
  sampleRate: number;
  /** 收费金额达到该值（日元）视为高金额收费活动。 */
  highValueFeeThresholdJPY: number;
  /** 起始时间落在该小时（含）之后视为深夜活动，按活动展示时区判断。 */
  lateNightStartHour: number;
  /** 起始时间落在该小时（不含）之前视为深夜活动。 */
  lateNightEndHour: number;
}

export interface RiskSignals {
  title: string;
  description: string;
  tags?: readonly string[];
  attendeeRequirements?: string | null;
  /** 客户端自报的风险标记：只作为输入信号，不能作为结论。 */
  declaredRiskFlags?: readonly string[];
  isFree?: boolean | null;
  amountJPY?: number | null;
  /** 活动开始时间在展示时区下的小时（0..23）。 */
  startHourLocal?: number | null;
}

export interface RiskHit {
  ruleKey: string;
  riskType: string;
  score: number;
  explanation: string;
  /** 该命中来自哪种信号，便于运营判断与申诉。 */
  source: 'keyword' | 'fee' | 'schedule' | 'declared';
}

export interface RiskAssessment {
  hits: RiskHit[];
  /** 服务端计算出的风险类型，去重且顺序稳定。 */
  riskTypes: string[];
  score: number;
  route: RiskRoute;
  /** 逐条解释，按 hits 顺序，供审核队列与拒绝回执展示。 */
  explanations: string[];
}

/**
 * 服务端兜底基线。运营后台通过 admin.config_revisions 的
 * `events.risk.engine` 键整体覆盖，改规则不需要发客户端版本。
 * 禁止类对应产品文档 M3：禁止收益保证、非法招募、无牌金融推介和传销。
 */
export const defaultRiskEngineConfig: RiskEngineConfig = {
  manualReviewThreshold: 50,
  sampleRate: 0.15,
  highValueFeeThresholdJPY: 10_000,
  lateNightStartHour: 22,
  lateNightEndHour: 5,
  rules: [
    {
      key: 'prohibited.income_guarantee',
      riskType: 'prohibited_content',
      keywords: ['保证收益', '稳赚不赔', '包赚', '保本高息', '月入百万', '躺赚'],
      score: 100,
      prohibited: true,
      explanation: '含收益保证承诺，平台禁止发布。',
    },
    {
      key: 'prohibited.pyramid_scheme',
      riskType: 'prohibited_content',
      keywords: ['传销', '拉人头', '发展下线', '入门费'],
      score: 100,
      prohibited: true,
      explanation: '涉嫌传销或发展下线，平台禁止发布。',
    },
    {
      key: 'prohibited.unlicensed_finance',
      riskType: 'prohibited_content',
      keywords: ['无牌照', '内幕消息', '代客理财', '荐股'],
      score: 100,
      prohibited: true,
      explanation: '涉嫌无牌金融推介，平台禁止发布。',
    },
    {
      key: 'prohibited.illegal_recruitment',
      riskType: 'prohibited_content',
      keywords: ['非法招募', '黑工', '偷渡'],
      score: 100,
      prohibited: true,
      explanation: '涉嫌非法招募，平台禁止发布。',
    },
    {
      key: 'risk.alcohol',
      riskType: 'alcohol_late_night',
      keywords: ['酒局', '居酒屋', '畅饮', '喝酒', '通宵', '飲み会'],
      score: 30,
      prohibited: false,
      explanation: '涉及饮酒或深夜时段，需确认年龄与散场安排。',
    },
    {
      key: 'risk.minors',
      riskType: 'minors',
      keywords: ['亲子', '未成年', '小学生', '中学生', '儿童', '幼儿'],
      score: 40,
      prohibited: false,
      explanation: '涉及未成年人参与，需确认监护与安全责任。',
    },
    {
      key: 'risk.outdoor_water',
      riskType: 'outdoor_water',
      keywords: ['登山', '徒步', '攀岩', '潜水', '浮潜', '漂流', '皮划艇', '露营', '滑雪'],
      score: 35,
      prohibited: false,
      explanation: '涉及户外或水上活动，需确认保险与应急预案。',
    },
    {
      key: 'risk.investment',
      riskType: 'professional_investment',
      keywords: ['投资', '理财', '股票', '基金', '外汇', '炒币'],
      score: 35,
      prohibited: false,
      explanation: '涉及投资或职业交流，需确认无金融推介。',
    },
    {
      key: 'risk.gender_restricted',
      riskType: 'gender_restricted',
      keywords: ['限女性', '仅限男性', '仅限女性', '限男性', '女士专场'],
      score: 25,
      prohibited: false,
      explanation: '设置了性别限定，需确认限定理由正当。',
    },
  ],
};

/**
 * 解析运营后台下发的规则配置。任何字段缺失或类型不对都退回兜底基线，
 * 避免一条写坏的 config revision 把整个风险引擎变成「全部放行」。
 */
export function parseRiskEngineConfig(value: unknown): RiskEngineConfig {
  if (typeof value !== 'object' || value === null) return defaultRiskEngineConfig;
  const candidate = value as Record<string, unknown>;
  const rules = Array.isArray(candidate.rules)
    ? candidate.rules.filter((rule): rule is RiskRule => {
        if (typeof rule !== 'object' || rule === null) return false;
        const entry = rule as Record<string, unknown>;
        return (
          typeof entry.key === 'string' &&
          typeof entry.riskType === 'string' &&
          Array.isArray(entry.keywords) &&
          entry.keywords.every((keyword) => typeof keyword === 'string') &&
          entry.keywords.length > 0 &&
          typeof entry.score === 'number' &&
          typeof entry.prohibited === 'boolean' &&
          typeof entry.explanation === 'string'
        );
      })
    : undefined;
  const numeric = (key: string, fallback: number): number =>
    typeof candidate[key] === 'number' && Number.isFinite(candidate[key]) ? candidate[key] : fallback;
  return {
    rules: rules && rules.length > 0 ? rules : defaultRiskEngineConfig.rules,
    manualReviewThreshold: numeric('manualReviewThreshold', defaultRiskEngineConfig.manualReviewThreshold),
    sampleRate: numeric('sampleRate', defaultRiskEngineConfig.sampleRate),
    highValueFeeThresholdJPY: numeric(
      'highValueFeeThresholdJPY',
      defaultRiskEngineConfig.highValueFeeThresholdJPY,
    ),
    lateNightStartHour: numeric('lateNightStartHour', defaultRiskEngineConfig.lateNightStartHour),
    lateNightEndHour: numeric('lateNightEndHour', defaultRiskEngineConfig.lateNightEndHour),
  };
}

/** 路由到 events.review_state，用于写入 events.event_risks。 */
export function riskReviewState(route: RiskRoute): 'approved' | 'pending' | 'rejected' {
  if (route === 'prohibit') return 'rejected';
  if (route === 'auto_approve') return 'approved';
  return 'pending';
}

function haystack(signals: RiskSignals): string {
  return [
    signals.title,
    signals.description,
    signals.attendeeRequirements ?? '',
    ...(signals.tags ?? []),
  ]
    .join('\n')
    .toLowerCase();
}

/**
 * 抽样必须对同一活动稳定：同一 eventId 反复提交/幂等重放要得到同一结论，
 * 否则局头可以靠重试把活动「摇」成自动通过。
 */
export function sampleRoll(eventId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < eventId.length; index += 1) {
    hash ^= eventId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash / 4_294_967_296;
}

export function assessEventRisk(
  signals: RiskSignals,
  config: RiskEngineConfig,
  roll: number,
): RiskAssessment {
  const text = haystack(signals);
  const hits: RiskHit[] = [];

  for (const rule of config.rules) {
    const matched = rule.keywords.some((keyword) => text.includes(keyword.toLowerCase()));
    if (!matched) continue;
    hits.push({
      ruleKey: rule.key,
      riskType: rule.riskType,
      score: rule.score,
      explanation: rule.explanation,
      source: 'keyword',
    });
  }

  // 高金额收费：金额是结构化字段，比关键词可靠，单独判定。
  if (signals.isFree === false && (signals.amountJPY ?? 0) >= config.highValueFeeThresholdJPY) {
    hits.push({
      ruleKey: 'fee.high_value',
      riskType: 'high_value_fee',
      score: 40,
      explanation: `收费金额达到 ${signals.amountJPY} 日元，超过高金额阈值 ${config.highValueFeeThresholdJPY} 日元。`,
      source: 'fee',
    });
  }

  // 深夜时段同样来自结构化字段，不依赖局头怎么写文案。
  const hour = signals.startHourLocal;
  if (
    typeof hour === 'number' &&
    (hour >= config.lateNightStartHour || hour < config.lateNightEndHour)
  ) {
    hits.push({
      ruleKey: 'schedule.late_night',
      riskType: 'alcohol_late_night',
      score: 20,
      explanation: `活动开始时间为当地 ${hour} 点，属于深夜时段。`,
      source: 'schedule',
    });
  }

  // 客户端自报只会「加」风险，永远不会「减」风险。
  for (const declared of signals.declaredRiskFlags ?? []) {
    if (hits.some((hit) => hit.riskType === declared)) continue;
    hits.push({
      ruleKey: `declared.${declared}`,
      riskType: declared,
      score: 20,
      explanation: '局头自行申报的风险项。',
      source: 'declared',
    });
  }

  const prohibitedKeys = new Set(
    config.rules.filter((rule) => rule.prohibited).map((rule) => rule.key),
  );
  const prohibited = hits.some((hit) => prohibitedKeys.has(hit.ruleKey));
  const score = Math.min(
    100,
    hits.reduce((total, hit) => total + hit.score, 0),
  );

  let route: RiskRoute;
  if (prohibited) route = 'prohibit';
  else if (score >= config.manualReviewThreshold) route = 'manual_review';
  else if (roll < config.sampleRate) route = 'sample';
  else route = 'auto_approve';

  const riskTypes = [...new Set(hits.map((hit) => hit.riskType))];
  return { hits, riskTypes, score, route, explanations: hits.map((hit) => hit.explanation) };
}
