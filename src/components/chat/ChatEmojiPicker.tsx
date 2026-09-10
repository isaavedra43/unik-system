'use client';

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/shadcn/popover';
import { Input } from '@/components/shadcn/input';
import { ScrollArea } from '@/components/shadcn/scroll-area';
import { cn } from '@/lib/utils';

export interface ChatEmojiPickerProps {
  onSelect: (emoji: string) => void;
  children: React.ReactNode;
  align?: 'start' | 'center' | 'end';
}

interface EmojiItem {
  char: string;
  name: string;
  keywords: string[];
}

const EMOJI_CATEGORIES: { label: string; emojis: EmojiItem[] }[] = [
  {
    label: 'Gestos',
    emojis: [
      { char: '👍', name: 'Like', keywords: ['like', 'ok', 'yes', 'pulgar'] },
      { char: '👎', name: 'Dislike', keywords: ['dislike', 'no', 'pulgar'] },
      { char: '👌', name: 'OK', keywords: ['ok', 'perfecto'] },
      { char: '🤌', name: 'Dedos', keywords: ['dedos', 'italiano'] },
      { char: '🤝', name: 'Handshake', keywords: ['handshake', 'acuerdo', 'saludo'] },
      { char: '🙏', name: 'Rezos', keywords: ['pray', 'gracias', 'rezos'] },
      { char: '👏', name: 'Applauso', keywords: ['clap', 'aplauso', 'bien'] },
      { char: '🙌', name: 'Celebración', keywords: ['celebrate', 'manos'] },
      { char: '🤲', name: 'Manos juntas', keywords: ['palmas'] },
      { char: '💪', name: 'Fuerza', keywords: ['muscle', 'fuerza', 'fuerte'] },
    ],
  },
  {
    label: 'Caras',
    emojis: [
      { char: '😀', name: 'Sonrisa', keywords: ['smile', 'feliz', 'risa'] },
      { char: '😂', name: 'Carcajada', keywords: ['lol', 'risa', 'llorar'] },
      { char: '🤣', name: 'ROTFL', keywords: ['risa', 'llorar'] },
      { char: '😊', name: 'Tierno', keywords: ['blush', 'tierno'] },
      { char: '😍', name: 'Amor', keywords: ['love', 'corazon', 'amor'] },
      { char: '🤔', name: 'Pensando', keywords: ['think', 'pensar'] },
      { char: '🤨', name: 'Dudoso', keywords: ['duda', 'ceja'] },
      { char: '😐', name: 'Neutral', keywords: ['neutral', 'meh'] },
      { char: '😮', name: 'Sorprendido', keywords: ['wow', 'sorpresa'] },
      { char: '😯', name: 'Asombrado', keywords: ['asombro'] },
      { char: '😢', name: 'Triste', keywords: ['sad', 'triste', 'llorar'] },
      { char: '😭', name: 'Llorando', keywords: ['cry', 'llorar'] },
      { char: '😅', name: 'Sudor', keywords: ['sweat', 'nervioso'] },
      { char: '🤯', name: 'Explosion', keywords: ['mind', 'blown', 'explosion'] },
      { char: '😴', name: 'Dormir', keywords: ['sleep', 'dormir'] },
    ],
  },
  {
    label: 'Corazones',
    emojis: [
      { char: '❤️', name: 'Corazón rojo', keywords: ['love', 'corazon', 'rojo'] },
      { char: '🧡', name: 'Corazón naranja', keywords: ['corazon', 'naranja'] },
      { char: '💛', name: 'Corazón amarillo', keywords: ['corazon', 'amarillo'] },
      { char: '💚', name: 'Corazón verde', keywords: ['corazon', 'verde'] },
      { char: '💙', name: 'Corazón azul', keywords: ['corazon', 'azul'] },
      { char: '💜', name: 'Corazón morado', keywords: ['corazon', 'morado'] },
      { char: '🖤', name: 'Corazón negro', keywords: ['corazon', 'negro'] },
      { char: '🤍', name: 'Corazón blanco', keywords: ['corazon', 'blanco'] },
      { char: '💔', name: 'Corazón roto', keywords: ['broken', 'roto'] },
      { char: '❤️‍🔥', name: 'Corazón fuego', keywords: ['fire', 'fuego'] },
    ],
  },
  {
    label: 'Objetos',
    emojis: [
      { char: '🔥', name: 'Fuego', keywords: ['fire', 'fuego', 'lit'] },
      { char: '⭐', name: 'Estrella', keywords: ['star', 'estrella'] },
      { char: '✅', name: 'Check', keywords: ['check', 'ok', 'si'] },
      { char: '❌', name: 'Cruz', keywords: ['cross', 'no', 'cancelar'] },
      { char: '💯', name: 'Cien', keywords: ['100', 'cien', 'perfecto'] },
      { char: '🎉', name: 'Fiesta', keywords: ['party', 'fiesta', 'celebrar'] },
      { char: '🎊', name: 'Confeti', keywords: ['confetti', 'fiesta'] },
      { char: '👀', name: 'Ojos', keywords: ['eyes', 'ojos', 'ver'] },
      { char: '📌', name: 'Pin', keywords: ['pin', 'fijar'] },
      { char: '📎', name: 'Clip', keywords: ['clip', 'adjunto'] },
    ],
  },
];

export const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

export function ChatEmojiPicker({ onSelect, children, align = 'end' }: ChatEmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!search.trim()) return EMOJI_CATEGORIES;
    const q = search.toLowerCase();
    return EMOJI_CATEGORIES.map((cat) => ({
      ...cat,
      emojis: cat.emojis.filter(
        (e) => e.name.toLowerCase().includes(q) || e.keywords.some((k) => k.includes(q))
      ),
    })).filter((cat) => cat.emojis.length > 0);
  }, [search]);

  const handleSelect = (emoji: string) => {
    onSelect(emoji);
    setOpen(false);
    setSearch('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-72 p-0">
        <div className="flex flex-col gap-2 p-2">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            />
            <Input
              ref={inputRef}
              type="text"
              placeholder="Buscar emoji..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <ScrollArea className="h-48">
            <div className="flex flex-col gap-3 pr-3">
              {filtered.length === 0 && (
                <div className="py-4 text-center text-xs text-muted-foreground">
                  No se encontraron emojis
                </div>
              )}
              {filtered.map((cat) => (
                <div key={cat.label} className="flex flex-col gap-1">
                  <div className="text-[10px] font-semibold uppercase text-muted-foreground px-1">
                    {cat.label}
                  </div>
                  <div className="grid grid-cols-8 gap-0.5">
                    {cat.emojis.map((emoji) => (
                      <button
                        key={emoji.char}
                        type="button"
                        className={cn(
                          'flex items-center justify-center rounded-md p-1 text-lg',
                          'hover:bg-accent transition-colors'
                        )}
                        onClick={() => handleSelect(emoji.char)}
                        title={emoji.name}
                      >
                        {emoji.char}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      </PopoverContent>
    </Popover>
  );
}
