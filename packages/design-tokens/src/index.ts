import rawTokens from './tokens.json' with { type: 'json' };

export const tokens = rawTokens;
export type SpottTokens = typeof tokens;

export type ColorScheme = keyof SpottTokens['color'];
export type SemanticColor = keyof SpottTokens['color']['light'];

export function color(scheme: ColorScheme, name: SemanticColor): string {
  return tokens.color[scheme][name];
}
