'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Code2, Plus, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/shadcn/dialog';
import { Input } from '@/components/shadcn/input';
import { Textarea } from '@/components/shadcn/textarea';
import { Button } from '@/components/shadcn/button';
import { ScrollArea } from '@/components/shadcn/scroll-area';
import { cn } from '@/lib/utils';

export interface ChatSnippetPickerProps {
  onSelect: (content: string) => void;
  onClose: () => void;
}

interface Snippet {
  id: string;
  title: string;
  content: string;
}

export function ChatSnippetPicker({ onSelect, onClose }: ChatSnippetPickerProps) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [creating, setCreating] = useState(false);

  const loadSnippets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/app/chat/api/snippets');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error al cargar snippets');
      }
      const data = await res.json();
      setSnippets(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSnippets();
  }, [loadSnippets]);

  const handleCreate = useCallback(async () => {
    const trimmedTitle = newTitle.trim();
    const trimmedContent = newContent.trim();
    if (!trimmedTitle || !trimmedContent) return;
    setCreating(true);
    try {
      const res = await fetch('/app/chat/api/snippets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmedTitle, content: trimmedContent }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error al crear snippet');
      }
      setNewTitle('');
      setNewContent('');
      setShowCreate(false);
      await loadSnippets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setCreating(false);
    }
  }, [newTitle, newContent, loadSnippets]);

  const handleSelect = useCallback(
    (content: string) => {
      onSelect(content);
      onClose();
    },
    [onSelect, onClose]
  );

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Code2 size={18} /> Plantillas
          </DialogTitle>
          <DialogDescription>
            {showCreate ? 'Crea una nueva plantilla' : 'Inserta una plantilla guardada'}
          </DialogDescription>
        </DialogHeader>

        {!showCreate ? (
          <>
            <ScrollArea className="max-h-[40vh]">
              <div className="flex flex-col gap-1 pr-3">
                {loading && (
                  <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                    <Loader2 size={20} className="animate-spin" /> Cargando...
                  </div>
                )}
                {error && (
                  <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    {error}
                  </div>
                )}
                {!loading && !error && snippets.length === 0 && (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    No tienes plantillas guardadas
                  </div>
                )}
                {snippets.map((snippet) => (
                  <button
                    key={snippet.id}
                    type="button"
                    className={cn(
                      'flex flex-col gap-1 rounded-md p-3 text-left transition-colors',
                      'hover:bg-accent focus:bg-accent focus:outline-none'
                    )}
                    onClick={() => handleSelect(snippet.content)}
                  >
                    <span className="text-sm font-semibold text-foreground">{snippet.title}</span>
                    <span className="text-sm text-muted-foreground line-clamp-2">
                      {snippet.content.slice(0, 120)}
                    </span>
                  </button>
                ))}
              </div>
            </ScrollArea>

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCreate(true)}>
                <Plus size={16} /> Nueva plantilla
              </Button>
            </DialogFooter>
          </>
        ) : (
          <div className="flex flex-col gap-3">
            <Input
              type="text"
              placeholder="Título"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              maxLength={100}
              autoFocus
            />
            <Textarea
              placeholder="Contenido de la plantilla..."
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              rows={6}
            />
            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowCreate(false);
                  setNewTitle('');
                  setNewContent('');
                  setError(null);
                }}
              >
                Cancelar
              </Button>
              <Button
                disabled={creating || !newTitle.trim() || !newContent.trim()}
                onClick={handleCreate}
              >
                {creating ? 'Guardando...' : 'Guardar'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
