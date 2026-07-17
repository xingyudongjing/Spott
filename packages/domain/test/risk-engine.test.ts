import { describe, expect, it } from 'vitest';
import {
  assessEventRisk,
  defaultRiskEngineConfig,
  parseRiskEngineConfig,
  riskReviewState,
  sampleRoll,
  type RiskEngineConfig,
} from '../src/index.js';

const benign = {
  title: '周末公园散步',
  description: '一起在代代木公园散步聊天，欢迎新朋友加入。',
};

/** 抽样率 0，让分流只由分数决定。 */
const noSampling: RiskEngineConfig = { ...defaultRiskEngineConfig, sampleRate: 0 };

describe('assessEventRisk', () => {
  it('auto-approves an ordinary event', () => {
    const assessment = assessEventRisk(benign, noSampling, 0.5);

    expect(assessment.route).toBe('auto_approve');
    expect(assessment.score).toBe(0);
    expect(assessment.riskTypes).toEqual([]);
  });

  it('prohibits income guarantees regardless of score thresholds', () => {
    const assessment = assessEventRisk(
      { title: '投资分享', description: '保证收益，稳赚不赔。' },
      // 即使运营把阈值调到不可能达到，禁止类依然直接拒绝。
      { ...noSampling, manualReviewThreshold: 10_000 },
      0.5,
    );

    expect(assessment.route).toBe('prohibit');
    expect(assessment.riskTypes).toContain('prohibited_content');
    expect(assessment.explanations.join()).toContain('禁止发布');
  });

  it('never lets a self-declared clean flag lower a detected risk', () => {
    const assessment = assessEventRisk(
      { ...benign, description: '一起去登山，路线有点难度。', declaredRiskFlags: [] },
      noSampling,
      0.5,
    );

    expect(assessment.riskTypes).toContain('outdoor_water');
  });

  it('treats a declared flag as an additional signal, not a conclusion', () => {
    const assessment = assessEventRisk(
      { ...benign, declaredRiskFlags: ['minors'] },
      noSampling,
      0.5,
    );

    expect(assessment.riskTypes).toContain('minors');
    expect(assessment.hits.find((hit) => hit.riskType === 'minors')?.source).toBe('declared');
  });

  it('derives high fee and late night risk from structured fields, not wording', () => {
    const assessment = assessEventRisk(
      { ...benign, isFree: false, amountJPY: 50_000, startHourLocal: 23 },
      noSampling,
      0.5,
    );

    expect(assessment.riskTypes).toContain('high_value_fee');
    expect(assessment.riskTypes).toContain('alcohol_late_night');
    expect(assessment.hits.some((hit) => hit.source === 'fee')).toBe(true);
    expect(assessment.hits.some((hit) => hit.source === 'schedule')).toBe(true);
  });

  it('samples ordinary events only when the roll falls under the configured rate', () => {
    const config = { ...defaultRiskEngineConfig, sampleRate: 0.2 };

    expect(assessEventRisk(benign, config, 0.1).route).toBe('sample');
    expect(assessEventRisk(benign, config, 0.9).route).toBe('auto_approve');
  });

  it('caps the score so one event cannot exceed the scale', () => {
    const assessment = assessEventRisk(
      {
        title: '亲子登山酒局',
        description: '亲子登山后去居酒屋畅饮，顺便聊投资理财，仅限女性。',
        isFree: false,
        amountJPY: 90_000,
        startHourLocal: 23,
      },
      noSampling,
      0.5,
    );

    expect(assessment.score).toBeLessThanOrEqual(100);
    expect(assessment.route).toBe('manual_review');
  });
});

describe('sampleRoll', () => {
  it('is stable for an event so retries cannot reroll the verdict', () => {
    expect(sampleRoll('019b0000-0000-7000-8100-000000000001')).toBe(
      sampleRoll('019b0000-0000-7000-8100-000000000001'),
    );
  });

  it('stays inside the unit interval and separates different events', () => {
    const first = sampleRoll('019b0000-0000-7000-8100-000000000001');
    const second = sampleRoll('019b0000-0000-7000-8100-000000000002');

    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
    expect(first).not.toBe(second);
  });
});

describe('parseRiskEngineConfig', () => {
  it('falls back to the server baseline when the revision is unusable', () => {
    expect(parseRiskEngineConfig(null)).toEqual(defaultRiskEngineConfig);
    expect(parseRiskEngineConfig('nonsense')).toEqual(defaultRiskEngineConfig);
    // 一条写坏的规则配置不能把引擎变成「全部放行」。
    expect(parseRiskEngineConfig({ rules: [{ key: 'broken' }] }).rules).toEqual(
      defaultRiskEngineConfig.rules,
    );
  });

  it('applies operator-supplied thresholds and rules', () => {
    const parsed = parseRiskEngineConfig({
      manualReviewThreshold: 10,
      sampleRate: 0.5,
      rules: [
        {
          key: 'custom.ban',
          riskType: 'prohibited_content',
          keywords: ['禁忌词'],
          score: 100,
          prohibited: true,
          explanation: '运营新增规则。',
        },
      ],
    });

    expect(parsed.manualReviewThreshold).toBe(10);
    expect(parsed.sampleRate).toBe(0.5);
    expect(parsed.rules).toHaveLength(1);
    // 未提供的阈值退回基线，而不是变成 0。
    expect(parsed.highValueFeeThresholdJPY).toBe(defaultRiskEngineConfig.highValueFeeThresholdJPY);
    expect(assessEventRisk({ title: '禁忌词', description: '' }, parsed, 0.9).route).toBe('prohibit');
  });
});

describe('riskReviewState', () => {
  it('maps every route onto the events.review_state enum', () => {
    expect(riskReviewState('auto_approve')).toBe('approved');
    expect(riskReviewState('sample')).toBe('pending');
    expect(riskReviewState('manual_review')).toBe('pending');
    expect(riskReviewState('prohibit')).toBe('rejected');
  });
});
