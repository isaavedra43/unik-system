'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Search, Users, Check, MessageCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/shadcn/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/shadcn/tabs';
import { Input } from '@/components/shadcn/input';
import { Button } from '@/components/shadcn/button';
import { Avatar, AvatarFallback } from '@/components/shadcn/avatar';
import { ScrollArea } from '@/components/shadcn/scroll-area';
import { cn } from '@/lib/utils';

export interface ChatNewDialogProps {
  onClose: () => void;
  onChannelCreated: (id: string) => void;
}

interface UserSearchResult {
  id: string;
  name: string;
  username: string;
  email: string | null;
  status: string;
}

export function ChatNewDialog({ onClose, onChannelCreated }: ChatNewDialogProps) {
  const [mode, setMode] = useState<'dm' | 'group'>('dm');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [selected, setSelected] = useState<UserSearchResult[]>([]);
  const [groupName, setGroupName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (search.trim().length < 1) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/app/chat/api/users/search?q=${encodeURIComponent(search)}`);
        if (res.ok) {
          const json = await res.json();
          setResults(json.data);
        }
      } catch {
        // silent
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);

  const toggleSelect = (user: UserSearchResult) => {
    if (mode === 'dm') {
      setSelected([user]);
    } else {
      setSelected((prev) => {
        const exists = prev.find((u) => u.id === user.id);
        if (exists) return prev.filter((u) => u.id !== user.id);
        return [...prev, user];
      });
    }
  };

  const handleCreate = useCallback(async () => {
    if (selected.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      if (mode === 'dm') {
        const res = await fetch('/app/chat/api/channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'dm', otherUserId: selected[0].id }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Error al crear el chat');
        }
        const data = await res.json();
        onChannelCreated(data.id);
      } else {
        if (!groupName.trim()) {
          setError('Ingresa un nombre para el grupo');
          setLoading(false);
          return;
        }
        const res = await fetch('/app/chat/api/channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'group',
            name: groupName,
            memberIds: selected.map((u) => u.id),
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Error al crear el grupo');
        }
        const data = await res.json();
        onChannelCreated(data.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, [mode, selected, groupName, onChannelCreated]);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nueva conversación</DialogTitle>
          <DialogDescription>Inicia un mensaje directo o crea un grupo</DialogDescription>
        </DialogHeader>

        <Tabs
          value={mode}
          onValueChange={(v) => {
            setMode(v as 'dm' | 'group');
            setSelected([]);
          }}
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="dm">
              <MessageCircle size={16} /> Mensaje directo
            </TabsTrigger>
            <TabsTrigger value="group">
              <Users size={16} /> Grupo
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {mode === 'group' && (
          <Input
            type="text"
            placeholder="Nombre del grupo"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            maxLength={100}
          />
        )}

        <div className="relative">
          <Search
            size={18}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <Input
            type="text"
            placeholder="Buscar por nombre o usuario..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
            autoFocus
          />
        </div>

        <ScrollArea className="max-h-[40vh]">
          <div className="flex flex-col gap-1 pr-3">
            {results.length === 0 && search.trim() && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No se encontraron usuarios
              </div>
            )}
            {results.length === 0 && !search.trim() && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Escribe para buscar usuarios
              </div>
            )}
            {results.map((user) => {
              const isSelected = selected.some((u) => u.id === user.id);
              return (
                <button
                  key={user.id}
                  type="button"
                  className={cn(
                    'flex items-center gap-3 rounded-md p-2 text-left transition-colors',
                    'hover:bg-accent focus:bg-accent focus:outline-none',
                    isSelected && 'bg-accent'
                  )}
                  onClick={() => toggleSelect(user)}
                >
                  <div className="relative">
                    <Avatar className="size-9">
                      <AvatarFallback className="text-xs font-semibold">
                        {user.name.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    {user.status === 'online' && (
                      <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-success ring-2 ring-background" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">{user.name}</div>
                    <div className="text-xs text-muted-foreground truncate">@{user.username}</div>
                  </div>
                  {isSelected && <Check size={18} className="text-primary shrink-0" />}
                </button>
              );
            })}
          </div>
        </ScrollArea>

        {selected.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {selected.map((u) => (
              <span
                key={u.id}
                className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
              >
                {u.name}
                <button
                  type="button"
                  onClick={() => toggleSelect(u)}
                  className="hover:opacity-70"
                  aria-label={`Quitar ${u.name}`}
                >
                  <span className="text-base leading-none">&times;</span>
                </button>
              </span>
            ))}
          </div>
        )}

        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={loading || selected.length === 0}
            onClick={handleCreate}
          >
            {loading ? 'Creando...' : mode === 'dm' ? 'Iniciar chat' : 'Crear grupo'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
