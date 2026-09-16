import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ACTOR_TYPES,
  ALLOCATION_SOURCES,
  ALLOCATION_STATUSES,
  APPROVAL_SCOPES,
  APPROVAL_STATUSES,
  AREA_KEYS,
  AREA_REQUEST_KINDS,
  AREA_REQUEST_STATUSES,
  CASE_KINDS,
  CASE_PHASES,
  CASE_SOURCE_TYPES,
  CASE_STATUSES,
  DEMAND_STATUSES,
  EVIDENCE_KINDS,
  COMMAND_STATUSES,
  INCIDENT_KINDS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  PRIORITIES,
  REQUEST_CREATOR_TYPES,
  STEP_KINDS,
  STEP_SCOPES,
  STEP_STATUSES,
  WORK_ITEM_KINDS,
  WORK_ITEM_STATUSES,
} from './types';

/**
 * El §2.1 del plan decide que «todos los estados son `String` comentados»: el
 * comentario `///` del campo ES la enumeración documentada del modelo, y quien
 * lee el esquema no tiene otra fuente.
 *
 * Nada obligaba a que ese comentario siguiera al código, así que se quedó
 * atrás: `AreaRequest.kind` listaba 14 valores cuando `AREA_REQUEST_KINDS` ya
 * tenía 15 (faltaba `direct_delivery`, que el motor crea en `case-service.ts` y
 * el catálogo declara en `request-kinds.ts`). Un comentario desfasado no rompe
 * ninguna consulta —por eso sobrevivió—, pero manda a quien lee el modelo a
 * implementar contra una enumeración que ya no existe.
 *
 * Esta prueba es la única red: obliga a que el comentario de cada campo
 * enumerado del núcleo operativo sea EXACTAMENTE su constante de `types.ts`
 * (mismos valores y mismo orden) y a que ningún campo enumerado nuevo entre sin
 * quedar cubierto aquí.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const schemaPath = path.join(repoRoot, 'prisma', 'schema.prisma');
const schemaRelative = 'prisma/schema.prisma';

/** Modelos del núcleo operativo (§2.1) cuyos comentarios se vigilan. */
const CORE_MODELS = [
  'Area',
  'OperationalCase',
  'CaseDemand',
  'DemandAllocation',
  'CaseStep',
  'WorkItem',
  'AreaRequest',
  'Incident',
  'OperationalEvent',
  'OperationalCommand',
  'EvidenceLink',
  'ApprovalPolicy',
  'ApprovalRequest',
] as const;

/**
 * `Modelo.campo` → constante que el comentario debe reproducir. Si se añade un
 * campo enumerado a un modelo del núcleo hay que añadirlo aquí: la prueba de
 * cobertura de abajo falla mientras no esté.
 */
const ENUM_FIELDS: Record<string, readonly string[]> = {
  'Area.key': AREA_KEYS,
  'OperationalCase.kind': CASE_KINDS,
  'OperationalCase.sourceType': CASE_SOURCE_TYPES,
  'OperationalCase.status': CASE_STATUSES,
  'OperationalCase.phase': CASE_PHASES,
  'OperationalCase.priority': PRIORITIES,
  'CaseDemand.status': DEMAND_STATUSES,
  'DemandAllocation.source': ALLOCATION_SOURCES,
  'DemandAllocation.status': ALLOCATION_STATUSES,
  'CaseStep.scope': STEP_SCOPES,
  'CaseStep.kind': STEP_KINDS,
  'CaseStep.status': STEP_STATUSES,
  'WorkItem.kind': WORK_ITEM_KINDS,
  'WorkItem.status': WORK_ITEM_STATUSES,
  'AreaRequest.kind': AREA_REQUEST_KINDS,
  'AreaRequest.priority': PRIORITIES,
  'AreaRequest.status': AREA_REQUEST_STATUSES,
  'AreaRequest.createdByType': REQUEST_CREATOR_TYPES,
  'Incident.kind': INCIDENT_KINDS,
  'Incident.severity': INCIDENT_SEVERITIES,
  'Incident.status': INCIDENT_STATUSES,
  'OperationalEvent.actorType': ACTOR_TYPES,
  'OperationalCommand.actorType': ACTOR_TYPES,
  'OperationalCommand.status': COMMAND_STATUSES,
  'EvidenceLink.kind': EVIDENCE_KINDS,
  'ApprovalPolicy.scope': APPROVAL_SCOPES,
  'ApprovalRequest.scope': APPROVAL_SCOPES,
  'ApprovalRequest.status': APPROVAL_STATUSES,
};

interface DocumentedField {
  /** `Modelo.campo`. */
  key: string;
  /** Última línea `///` inmediatamente anterior al campo. */
  doc: string;
  /** Línea (1-indexada) del comentario, para que el fallo sea accionable. */
  line: number;
}

/**
 * Devuelve, por cada campo de los modelos indicados, el comentario `///`
 * inmediatamente anterior. Sólo se mira la última línea de un bloque de
 * comentarios: la enumeración siempre es la línea pegada al campo.
 */
function readDocumentedFields(schema: string, models: readonly string[]): DocumentedField[] {
  const lines = schema.split('\n');
  const found: DocumentedField[] = [];
  let model: string | null = null;
  let doc: { text: string; line: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const modelStart = line.match(/^model\s+(\w+)\s*\{/);
    if (modelStart) {
      model = modelStart[1];
      doc = null;
      continue;
    }
    if (/^\}/.test(line)) {
      model = null;
      doc = null;
      continue;
    }
    const comment = line.match(/^\s*\/\/\/\s*(.*)$/);
    if (comment) {
      doc = { text: comment[1].trim(), line: index + 1 };
      continue;
    }
    const field = line.match(/^\s{2}(\w+)\s+\w/);
    if (field) {
      if (model && doc && models.includes(model)) {
        found.push({ key: `${model}.${field[1]}`, doc: doc.text, line: doc.line });
      }
      doc = null;
      continue;
    }
    // Líneas en blanco, atributos de bloque (@@index) y demás no cortan el comentario.
    if (line.trim() === '' || /^\s*@@/.test(line)) doc = null;
  }

  return found;
}

/** ¿El comentario tiene forma de enumeración (`a | b | c` o un único valor)? */
function looksLikeEnumeration(doc: string): boolean {
  const segments = doc.split(' | ').map((segment) => segment.trim());
  return segments.every((segment) => /^[a-z][a-z0-9_]*$/.test(segment));
}

const schema = readFileSync(schemaPath, 'utf8');
const documented = readDocumentedFields(schema, CORE_MODELS);
const byKey = new Map(documented.map((entry) => [entry.key, entry]));

describe(`comentarios de enumeración de ${schemaRelative}`, () => {
  it('encuentra los modelos del núcleo operativo', () => {
    for (const model of CORE_MODELS) {
      expect(schema, `${schemaRelative} ya no declara el modelo ${model}`).toContain(
        `model ${model} {`
      );
    }
    expect(documented.length).toBeGreaterThan(0);
  });

  it.each(Object.keys(ENUM_FIELDS))('%s documenta su enumeración real', (key) => {
    const entry = byKey.get(key);
    expect(
      entry,
      `${key} no tiene comentario /// en ${schemaRelative}: el §2.1 exige que el estado quede documentado en el campo`
    ).toBeDefined();

    const values = entry!.doc.split(' | ').map((segment) => segment.trim());
    expect(
      values,
      `${schemaRelative}:${entry!.line} — el comentario de ${key} no coincide con su constante de ` +
        'src/modules/operations/types.ts. Actualiza el comentario (mismos valores y mismo orden).'
    ).toEqual([...ENUM_FIELDS[key]]);
  });

  it('no deja campos enumerados del núcleo sin vigilar', () => {
    const uncovered = documented
      .filter((entry) => !(entry.key in ENUM_FIELDS) && looksLikeEnumeration(entry.doc))
      .map((entry) => `${entry.key} (${schemaRelative}:${entry.line})`);

    expect(
      uncovered,
      'Campos enumerados nuevos en un modelo del núcleo: añádelos a ENUM_FIELDS con su constante de types.ts'
    ).toEqual([]);
  });
});
