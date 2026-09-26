'use client';

import React from 'react';
import { motion } from 'motion/react';
import { ArrowUpRight, Code, FileSearch, Globe, HandCoins, Rocket, Sun, Users } from 'lucide-react';
import { AGENT_TEAMS, type AgentTeamTemplate } from '@/modules/agents/agent-templates';
import { fadeUp } from '@/lib/motion';
import type { AgentInfo } from '../lib/types';
import { firstName, greeting } from '../lib/format';
import { AgentAvatar } from '../ui';

/**
 * Empty thread: who you're talking to, the composer in the middle and real
 * starting points — each card sends a complete, executable request.
 */

interface Starter {
  icon: React.ReactNode;
  title: string;
  sub: string;
  prompt: string;
}

const STARTERS: Starter[] = [
  {
    icon: <Sun size={16} />,
    title: 'Arranca mi día',
    sub: 'Ventas, pendientes, cobranza y alertas en un vistazo',
    prompt:
      'Dame el arranque del día: ventas de ayer, pedidos atrasados, cobranza vencida, cotizaciones sin respuesta y las 3 decisiones que necesito tomar hoy.',
  },
  {
    icon: <HandCoins size={16} />,
    title: 'Recupera cotizaciones',
    sub: 'Las que llevan días sin respuesta, con seguimiento listo',
    prompt:
      '¿Qué cotizaciones llevan más de 3 días sin respuesta? Prioriza por monto y prepara un mensaje de seguimiento para cada una.',
  },
  {
    icon: <FileSearch size={16} />,
    title: 'Investiga un pedido',
    sub: 'Por qué va atrasado y qué hacer',
    prompt:
      'Investiga el pedido más atrasado: qué pasó en cada etapa, quién lo tiene detenido y qué hacemos para entregarlo.',
  },
  {
    icon: <Globe size={16} />,
    title: 'Prospecta clientes',
    sub: 'Empresas reales con contacto y por qué nos convienen',
    prompt:
      'Busca en internet 20 constructoras en México que puedan comprarnos mármol: sitio web, contacto, ciudad y por qué nos convienen. Entrégalo en una tabla.',
  },
  {
    icon: <Code size={16} />,
    title: 'Prueba mi sistema',
    sub: 'Abre el navegador y revisa producción como un QA',
    prompt:
      'Abre el navegador, entra a mi sistema en producción y prueba el módulo de ventas como un QA: dime qué falla, con capturas y pasos para reproducirlo.',
  },
  {
    icon: <Rocket size={16} />,
    title: 'Crea un sitio web',
    sub: 'Lo diseña, lo publica y te da el enlace',
    prompt:
      'Crea y publica una página de aterrizaje para nuestra promoción de mármol: título claro, beneficios, galería y botón de WhatsApp.',
  },
];

const SPECIALIST_STARTERS = [
  'Empieza con tu tarea principal de hoy',
  'Dame un estado en 3 líneas',
  'Propón una misión para esta semana',
];

export function Welcome({
  agent,
  userName,
  composer,
  onSend,
  onTeam,
  teamSize,
}: {
  agent: AgentInfo;
  userName?: string | null;
  composer: React.ReactNode;
  onSend: (text: string) => void;
  /** Open the "new team" dialog with a template preselected. */
  onTeam?: (team: AgentTeamTemplate) => void;
  teamSize: number;
}) {
  const principal = agent.kind === 'principal';
  const who = firstName(userName);
  return (
    <motion.div className="uv-welcome" variants={fadeUp} initial="initial" animate="animate">
      <div className="uv-welcome-hero">
        <AgentAvatar agent={agent} size="lg" />
        <h1 className="uv-welcome-title">
          {principal ? `${greeting()}${who ? `, ${who}` : ''}` : agent.name}
        </h1>
        <p className="uv-welcome-sub">
          {principal
            ? teamSize > 1
              ? `Dirijo a tus ${teamSize - 1} especialistas: pídeme algo y lo reparto, lo reviso y te entrego el resultado.`
              : 'Pídeme cualquier trabajo: investigo, uso el navegador y la computadora, programo, preparo documentos y coordino a un equipo de agentes.'
            : (agent.purpose ?? 'Especialista de tu equipo: dale una tarea o pide un estado.')}
        </p>
      </div>
      {composer}
      {principal ? (
        <div className="uv-cap-grid" aria-label="Ideas para empezar">
          {STARTERS.map((s) => (
            <button key={s.title} type="button" className="uv-cap" onClick={() => onSend(s.prompt)}>
              <span className="uv-cap-icon">{s.icon}</span>
              <span>
                <span className="uv-cap-title">{s.title}</span>
                <span className="uv-cap-sub">{s.sub}</span>
              </span>
              <ArrowUpRight size={14} className="uv-cap-go" aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : (
        <div className="uv-followups" style={{ justifyContent: 'center' }}>
          {SPECIALIST_STARTERS.map((s) => (
            <button key={s} type="button" className="uv-chip" onClick={() => onSend(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      {principal && onTeam && (
        <div className="uv-welcome-teams">
          <div className="uv-welcome-teams-head">
            <span className="uv-inline-label">
              <Users size={13} />
              Arma un equipo que trabaje por ti
            </span>
          </div>
          <div className="uv-team-strip">
            {AGENT_TEAMS.map((t) => (
              <button
                key={t.id}
                type="button"
                className="uv-team-chip"
                onClick={() => onTeam(t)}
                title={t.purpose}
              >
                <AgentAvatar agent={{ name: t.name, color: t.color, icon: t.icon }} size="sm" />
                {t.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
}
