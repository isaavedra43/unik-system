'use client';

import React from 'react';
import {
  Image, FileText, Mic, Video, MapPin, BarChart3, Calendar, FileCode,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/shadcn/popover';
import { cn } from '@/lib/utils';

export interface ChatAttachMenuProps {
  onAttachFile: () => void;
  onPickLocation: () => void;
  onPickPoll: () => void;
  onPickEvent: () => void;
  onPickSnippet: () => void;
  onRecordVoice: () => void;
  onRecordVideo: () => void;
  children: React.ReactNode;
}

interface MenuItem {
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  onClick: () => void;
}

export function ChatAttachMenu({
  onAttachFile, onPickLocation, onPickPoll, onPickEvent, onPickSnippet,
  onRecordVoice, onRecordVideo, children,
}: ChatAttachMenuProps) {
  const items: MenuItem[] = [
    { icon: FileText, label: 'Archivo', onClick: onAttachFile },
    { icon: Image, label: 'Imagen / Video', onClick: onAttachFile },
    { icon: Mic, label: 'Nota de voz', onClick: onRecordVoice },
    { icon: Video, label: 'Nota de video', onClick: onRecordVideo },
    { icon: MapPin, label: 'Ubicación', onClick: onPickLocation },
    { icon: BarChart3, label: 'Encuesta', onClick: onPickPoll },
    { icon: Calendar, label: 'Evento', onClick: onPickEvent },
    { icon: FileCode, label: 'Plantilla', onClick: onPickSnippet },
  ];

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-56 p-1">
        <div className="flex flex-col gap-0.5">
          {items.map((item, i) => (
            <button
              key={i}
              type="button"
              className={cn(
                'flex items-center gap-3 rounded-md px-2.5 py-2 text-sm text-foreground',
                'hover:bg-accent transition-colors text-left'
              )}
              onClick={item.onClick}
            >
              <item.icon size={16} />
              {item.label}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
