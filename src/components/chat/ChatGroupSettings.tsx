'use client';

import React, { useState, useEffect } from 'react';
import { Users, UserPlus, UserMinus, Trash2, Search } from 'lucide-react';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/shadcn/sheet';
import { Input } from '@/components/shadcn/input';
import { Button } from '@/components/shadcn/button';
import { Avatar, AvatarFallback } from '@/components/shadcn/avatar';
import { ScrollArea } from '@/components/shadcn/scroll-area';
import { cn } from '@/lib/utils';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { ChatChannelDTO } from '@/modules/chat/chat-events';

export interface ChatGroupSettingsProps {
  channel: ChatChannelDTO;
  user: CurrentUser;
  onClose: () => void;
  onRefresh: () => void;
}

export function ChatGroupSettings({ channel, user, onClose, onRefresh }: ChatGroupSettingsProps) {
  const [name, setName] = useState(channel.name ?? '');
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<
    { id: string; name: string; username: string }[]
  >([]);
  const [error, setError] = useState<string | null>(null);

  const isGroup = channel.type === 'group';
  const isOwner = channel.members.find((m) => m.userId === user.id)?.role === 'owner';
  const isAdmin = isOwner || channel.members.find((m) => m.userId === user.id)?.role === 'admin';

  useEffect(() => {
    setName(channel.name ?? '');
  }, [channel]);

  useEffect(() => {
    if (search.trim().length < 1) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/app/chat/api/users/search?q=${encodeURIComponent(search)}`);
        if (res.ok) {
          const json = await res.json();
          const memberIds = new Set(channel.members.map((m) => m.userId));
          setSearchResults(json.data.filter((u: { id: string }) => !memberIds.has(u.id)));
        }
      } catch {
        // silent
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [search, channel.members]);

  const handleSaveName = async () => {
    if (name.trim() === channel.name) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/app/chat/api/channels/${channel.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Error');
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setSaving(false);
    }
  };

  const handleAddMember = async (userId: string) => {
    setError(null);
    try {
      const res = await fetch(`/app/chat/api/channels/${channel.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [userId] }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Error');
      }
      setSearch('');
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  };

  const handleRemoveMember = async (userId: string) => {
    setError(null);
    try {
      const res = await fetch(`/app/chat/api/channels/${channel.id}/members?userId=${userId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Error');
      }
      if (userId === user.id) {
        onClose();
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  };

  const handleDeleteGroup = async () => {
    if (!confirm('¿Estás seguro de eliminar este grupo? Esta acción no se puede deshacer.')) return;
    setError(null);
    try {
      const res = await fetch(`/app/chat/api/channels/${channel.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Error');
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  };

  const getStatusLabel = (status: string) => {
    if (status === 'online') return 'en línea';
    if (status === 'away') return 'ausente';
    return 'desconectado';
  };

  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 gap-0">
        <SheetHeader className="border-b border-border px-4 py-3">
          <SheetTitle>Información</SheetTitle>
          <SheetDescription>
            {isGroup ? 'Configuración del grupo' : 'Información de la conversación'}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-4 p-4">
            <div className="flex flex-col items-center gap-2">
              <Avatar className="size-16">
                <AvatarFallback className="text-xl font-semibold bg-primary text-primary-foreground">
                  {isGroup ? (
                    <Users size={28} />
                  ) : (
                    channel.members
                      .find((m) => m.userId !== user.id)
                      ?.name.slice(0, 2)
                      .toUpperCase()
                  )}
                </AvatarFallback>
              </Avatar>
              {isGroup && isAdmin ? (
                <div className="flex items-center gap-2 w-full">
                  <Input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={100}
                    placeholder="Nombre del grupo"
                  />
                  <Button
                    size="sm"
                    onClick={handleSaveName}
                    disabled={saving || name.trim() === channel.name}
                  >
                    {saving ? '...' : 'Guardar'}
                  </Button>
                </div>
              ) : (
                <div className="text-lg font-semibold text-foreground text-center">
                  {isGroup
                    ? channel.name
                    : channel.members.find((m) => m.userId !== user.id)?.name}
                </div>
              )}
              <div className="text-sm text-muted-foreground">
                {channel.members.length} {channel.members.length === 1 ? 'miembro' : 'miembros'}
              </div>
            </div>

            {isGroup && isAdmin && (
              <div className="flex flex-col gap-2">
                <div className="relative">
                  <Search
                    size={16}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                  />
                  <Input
                    type="text"
                    placeholder="Agregar miembros..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-9"
                  />
                </div>
                {searchResults.length > 0 && (
                  <div className="flex flex-col gap-1 rounded-md border border-border p-1">
                    {searchResults.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        className={cn(
                          'flex items-center gap-3 rounded-md p-2 text-left transition-colors',
                          'hover:bg-accent focus:bg-accent focus:outline-none'
                        )}
                        onClick={() => handleAddMember(u.id)}
                      >
                        <Avatar className="size-8">
                          <AvatarFallback className="text-xs font-semibold">
                            {u.name.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-foreground truncate">{u.name}</div>
                          <div className="text-xs text-muted-foreground truncate">@{u.username}</div>
                        </div>
                        <UserPlus size={18} className="text-primary shrink-0" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-col gap-1">
              {channel.members.map((m) => (
                <div
                  key={m.userId}
                  className={cn(
                    'flex items-center gap-3 rounded-md p-2',
                    'transition-colors hover:bg-accent'
                  )}
                >
                  <div className="relative">
                    <Avatar className="size-9">
                      <AvatarFallback className="text-xs font-semibold">
                        {m.name.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    {m.status === 'online' && (
                      <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-success ring-2 ring-background" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">
                      {m.name}
                      {m.userId === user.id && (
                        <span className="text-muted-foreground"> (tú)</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">{getStatusLabel(m.status)}</div>
                  </div>
                  {m.role === 'owner' && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                      admin
                    </span>
                  )}
                  {isGroup && isAdmin && m.userId !== user.id && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleRemoveMember(m.userId)}
                      aria-label={`Remover ${m.name}`}
                      className="text-muted-foreground hover:text-destructive shrink-0"
                    >
                      <UserMinus size={16} />
                    </Button>
                  )}
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-2 pt-2 border-t border-border">
              <Button
                variant="outline"
                onClick={() => handleRemoveMember(user.id)}
                className="w-full"
              >
                {isGroup ? 'Salir del grupo' : 'Cerrar conversación'}
              </Button>
              {isGroup && isOwner && (
                <Button
                  variant="destructive"
                  onClick={handleDeleteGroup}
                  className="w-full"
                >
                  <Trash2 size={16} /> Eliminar grupo
                </Button>
              )}
            </div>

            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
