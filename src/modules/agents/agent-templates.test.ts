import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_TEAMS, AGENT_TEMPLATES, teamMembers } from './agent-templates';

/** Every tool name registered in the codebase (static scan — no DB, no side effects). */
function registeredToolNames(): Set<string> {
  const root = path.join(process.cwd(), 'src', 'modules');
  const files = [
    ...readdirSync(path.join(root, 'ai', 'tools'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => path.join(root, 'ai', 'tools', f)),
    path.join(root, 'venues', 'venue-playbook-tools.ts'),
    path.join(root, 'memory', 'memory-tools.ts'),
    path.join(root, 'missions', 'mission-tools.ts'),
  ];
  const names = new Set<string>(['generateImage', 'generateVideo']); // registered in a loop
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/^\s+name:\s*'(\w+)',\s*$/gm)) names.add(m[1]);
  }
  return names;
}

describe('agent templates', () => {
  it('have unique ids and valid limits', () => {
    const ids = AGENT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of AGENT_TEMPLATES) {
      expect(t.name.length).toBeLessThanOrEqual(60);
      expect(t.purpose.length).toBeLessThanOrEqual(200);
      expect(t.persona.length).toBeGreaterThan(80);
      expect(t.starters.length).toBeGreaterThan(0);
      if (t.routine) {
        expect(t.routine.action.goal.length).toBeGreaterThanOrEqual(3);
        expect(t.routine.action.goal.length).toBeLessThanOrEqual(500);
        expect(t.routine.spec.everyMinutes ?? t.routine.spec.atHour).toBeDefined();
      }
    }
  });

  it('only allow tools that exist in the registry', () => {
    const names = registeredToolNames();
    expect(names.size).toBeGreaterThan(100);
    for (const t of AGENT_TEMPLATES) {
      const missing = t.toolAllowlist.filter((n) => !names.has(n));
      expect({ template: t.id, missing }).toEqual({ template: t.id, missing: [] });
    }
  });

  it('teams reference existing templates and fit the delegation fan-out', () => {
    for (const team of AGENT_TEAMS) {
      expect(teamMembers(team).length).toBe(team.members.length);
      expect(team.members.length).toBeLessThanOrEqual(10);
      expect(team.kickoff.length).toBeGreaterThan(20);
    }
  });
});
