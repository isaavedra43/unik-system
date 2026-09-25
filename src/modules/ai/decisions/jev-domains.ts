import { decide, answerProbability } from './decision-engine';
import { domainPickDecision } from './decision-points';
import { domainCatalog, detectDomains } from '../tool-selector';

/**
 * Jev-augmented domain detection: the regex pass (`detectDomains`) is fast but
 * misses phrasing it was never taught; Jev answers one noul per domain in a
 * single cheap request. The result is the UNION — regex hits never regress.
 *
 * Returns [] when Jev is disabled or unconfident, so callers can spread the
 * result into `selectToolsForTurn({extraDomains})` unconditionally.
 */
export async function detectDomainsWithJev(
  message: string,
  opts: { userId?: string; conversationId?: string } = {}
): Promise<string[]> {
  if (!message || message.trim().length < 8) return [];
  const domains = domainCatalog();
  if (domains.length === 0) return [];

  const { state, questions } = domainPickDecision(message, domains);
  const result = await decide(state, questions, opts);
  if (!result) return [];

  const regexDomains = new Set(detectDomains(message));
  const picked: string[] = [];
  for (const d of domains) {
    const p = answerProbability(result, `d_${d.domain}`);
    // Loose floor on purpose: a false positive only offers extra tools, while a
    // false negative means the model can't reach the tool it needed at all.
    if (p !== null && p >= 0.6 && !regexDomains.has(d.domain)) picked.push(d.domain);
  }
  return picked;
}
