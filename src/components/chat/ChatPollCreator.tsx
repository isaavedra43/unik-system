'use client';

import React, { useState, useCallback } from 'react';
import { Plus, Trash2, BarChart3 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/shadcn/dialog';
import { Input } from '@/components/shadcn/input';
import { Button } from '@/components/shadcn/button';
import { Checkbox } from '@/components/shadcn/checkbox';
import { ScrollArea } from '@/components/shadcn/scroll-area';

export interface ChatPollCreatorProps {
  onCreate: (poll: {
    question: string;
    options: string[];
    isMulti: boolean;
    isAnonymous: boolean;
  }) => void;
  onCancel: () => void;
}

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

export function ChatPollCreator({ onCreate, onCancel }: ChatPollCreatorProps) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [isMulti, setIsMulti] = useState(false);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateOption = useCallback((index: number, value: string) => {
    setOptions((prev) => prev.map((opt, i) => (i === index ? value : opt)));
  }, []);

  const addOption = useCallback(() => {
    setOptions((prev) => (prev.length < MAX_OPTIONS ? [...prev, ''] : prev));
  }, []);

  const removeOption = useCallback((index: number) => {
    setOptions((prev) => (prev.length > MIN_OPTIONS ? prev.filter((_, i) => i !== index) : prev));
  }, []);

  const handleCreate = useCallback(() => {
    const trimmedQuestion = question.trim();
    const trimmedOptions = options.map((o) => o.trim()).filter(Boolean);

    if (!trimmedQuestion) {
      setError('Escribe una pregunta');
      return;
    }
    if (trimmedOptions.length < MIN_OPTIONS) {
      setError('Agrega al menos 2 opciones');
      return;
    }
    setError(null);
    onCreate({
      question: trimmedQuestion,
      options: trimmedOptions,
      isMulti,
      isAnonymous,
    });
  }, [question, options, isMulti, isAnonymous, onCreate]);

  return (
    <Dialog open onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BarChart3 size={18} /> Crear encuesta
          </DialogTitle>
          <DialogDescription>Crea una encuesta para esta conversación</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Input
            type="text"
            placeholder="Escribe la pregunta..."
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={300}
          />

          <ScrollArea className="max-h-[30vh]">
            <div className="flex flex-col gap-2 pr-3">
              {options.map((option, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    type="text"
                    placeholder={`Opción ${index + 1}`}
                    value={option}
                    onChange={(e) => updateOption(index, e.target.value)}
                    maxLength={200}
                  />
                  {options.length > MIN_OPTIONS && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeOption(index)}
                      aria-label={`Quitar opción ${index + 1}`}
                      className="text-muted-foreground hover:text-destructive shrink-0"
                    >
                      <Trash2 size={16} />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>

          {options.length < MAX_OPTIONS && (
            <Button variant="outline" size="sm" onClick={addOption} className="w-fit">
              <Plus size={16} /> Agregar opción
            </Button>
          )}

          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={isMulti}
                onCheckedChange={(checked) => setIsMulti(checked === true)}
              />
              <span>Selección múltiple</span>
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={isAnonymous}
                onCheckedChange={(checked) => setIsAnonymous(checked === true)}
              />
              <span>Voto anónimo</span>
            </label>
          </div>

          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancelar
          </Button>
          <Button onClick={handleCreate}>Crear encuesta</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
