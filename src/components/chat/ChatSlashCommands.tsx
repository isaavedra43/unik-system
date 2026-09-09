'use client';

import React, { useMemo } from 'react';
import {
  BarChart3,
  Calendar,
  MapPin,
  Mic,
  Video,
  AlertCircle,
  FileText,
  Sparkles,
} from 'lucide-react';

export interface ChatSlashCommand {
  command: string;
  label: string;
  description: string;
  icon: React.ReactNode;
}

export const SLASH_COMMANDS: ChatSlashCommand[] = [
  {
    command: '/encuesta',
    label: 'Encuesta',
    description: 'Crear una encuesta',
    icon: <BarChart3 size={16} />,
  },
  {
    command: '/evento',
    label: 'Evento',
    description: 'Crear un evento de calendario',
    icon: <Calendar size={16} />,
  },
  {
    command: '/ubicacion',
    label: 'Ubicación',
    description: 'Compartir ubicación',
    icon: <MapPin size={16} />,
  },
  {
    command: '/voz',
    label: 'Nota de voz',
    description: 'Grabar nota de voz',
    icon: <Mic size={16} />,
  },
  {
    command: '/video',
    label: 'Nota de video',
    description: 'Grabar nota de video',
    icon: <Video size={16} />,
  },
  {
    command: '/urgente',
    label: 'Urgente',
    description: 'Marcar próximo mensaje como urgente',
    icon: <AlertCircle size={16} />,
  },
  {
    command: '/snippet',
    label: 'Plantilla',
    description: 'Insertar plantilla guardada',
    icon: <FileText size={16} />,
  },
  {
    command: '/ai',
    label: 'Asistente IA',
    description: 'Preguntar al asistente IA',
    icon: <Sparkles size={16} />,
  },
];

export interface ChatSlashCommandsProps {
  query: string;
  onSelect: (command: ChatSlashCommand) => void;
  activeIndex: number;
}

export function ChatSlashCommands({ query, onSelect, activeIndex }: ChatSlashCommandsProps) {
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter((c) => c.command.includes(q) || c.label.toLowerCase().includes(q));
  }, [query]);

  if (filtered.length === 0) return null;

  return (
    <div className="chat-slash-commands" role="listbox">
      {filtered.map((cmd, index) => (
        <button
          key={cmd.command}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={`chat-slash-item ${index === activeIndex ? 'active' : ''}`}
          onClick={() => onSelect(cmd)}
        >
          <span className="chat-slash-icon">{cmd.icon}</span>
          <span className="chat-slash-content">
            <span className="chat-slash-command">{cmd.command}</span>
            <span className="chat-slash-desc">{cmd.description}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
