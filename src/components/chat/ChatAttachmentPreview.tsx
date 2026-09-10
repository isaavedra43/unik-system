'use client';

import React, { useState } from 'react';
import Image from 'next/image';
import { FileText, Film, Music, Download, X, ImageIcon } from 'lucide-react';
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from '@/components/shadcn/dialog';
import { Progress } from '@/components/shadcn/progress';
import { Button } from '@/components/shadcn/button';
import { cn } from '@/lib/utils';
import type { ChatAttachmentDTO } from '@/modules/chat/chat-events';

export interface ChatAttachmentPreviewProps {
  attachment: ChatAttachmentDTO;
  onRemove?: () => void;
  compact?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isImage(mime: string) { return mime.startsWith('image/'); }
function isVideo(mime: string) { return mime.startsWith('video/'); }
function isAudio(mime: string) { return mime.startsWith('audio/'); }

export function ChatAttachmentPreview({ attachment, onRemove, compact }: ChatAttachmentPreviewProps) {
  const [lightbox, setLightbox] = useState(false);
  const url = `/app/chat/api/attachments/${attachment.id}`;

  if (isImage(attachment.mimeType)) {
    return (
      <>
        <div className={cn('chat-att-image', compact && 'compact')}>
          <Image
            src={url}
            alt={attachment.fileName}
            onClick={() => setLightbox(true)}
            width={200}
            height={200}
            unoptimized
            className="chat-att-img"
          />
          {onRemove && (
            <button
              type="button"
              className="chat-att-remove"
              onClick={onRemove}
              aria-label="Quitar"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <Dialog open={lightbox} onOpenChange={setLightbox}>
          <DialogContent
            showCloseButton={false}
            className="sm:max-w-3xl p-0 overflow-hidden bg-black/95 border-0"
          >
            <DialogTitle className="sr-only">{attachment.fileName}</DialogTitle>
            <DialogDescription className="sr-only">Imagen adjunta</DialogDescription>
            <div className="relative w-full h-[80vh] flex items-center justify-center">
              <Image
                src={url}
                alt={attachment.fileName}
                fill
                unoptimized
                className="object-contain"
              />
            </div>
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2">
              <Button asChild variant="secondary" size="sm">
                <a href={url} download={attachment.fileName}>
                  <Download size={16} /> Descargar
                </a>
              </Button>
              <Button
                variant="secondary"
                size="icon"
                onClick={() => setLightbox(false)}
                aria-label="Cerrar"
              >
                <X size={18} />
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  if (isVideo(attachment.mimeType)) {
    return (
      <div className={cn('chat-att-video', compact && 'compact')}>
        <video src={url} controls preload="metadata" />
        {onRemove && (
          <button type="button" className="chat-att-remove" onClick={onRemove} aria-label="Quitar">
            <X size={14} />
          </button>
        )}
      </div>
    );
  }

  if (isAudio(attachment.mimeType)) {
    return (
      <div className={cn('chat-att-audio', compact && 'compact')}>
        <div className="chat-att-audio-icon">
          <Music size={20} />
        </div>
        <audio src={url} controls preload="metadata" />
        {onRemove && (
          <button type="button" className="chat-att-remove" onClick={onRemove} aria-label="Quitar">
            <X size={14} />
          </button>
        )}
      </div>
    );
  }

  return (
    <a
      href={url}
      download={attachment.fileName}
      className={cn('chat-att-doc', compact && 'compact')}
    >
      <div className="chat-att-doc-icon">
        <FileText size={24} />
      </div>
      <div className="chat-att-doc-info">
        <div className="chat-att-doc-name">{attachment.fileName}</div>
        <div className="chat-att-doc-size">{formatSize(attachment.sizeBytes)}</div>
      </div>
      <Download size={18} className="chat-att-doc-download" />
      {onRemove && (
        <button
          type="button"
          className="chat-att-remove"
          onClick={(e) => {
            e.preventDefault();
            onRemove();
          }}
          aria-label="Quitar"
        >
          <X size={14} />
        </button>
      )}
    </a>
  );
}

export function ChatPendingAttachment({
  fileName,
  mimeType,
  sizeBytes,
  progress,
}: {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  progress: number;
}) {
  return (
    <div className="chat-att-pending">
      <div className="chat-att-doc-icon">
        {isImage(mimeType) ? (
          <ImageIcon size={24} />
        ) : isVideo(mimeType) ? (
          <Film size={24} />
        ) : isAudio(mimeType) ? (
          <Music size={24} />
        ) : (
          <FileText size={24} />
        )}
      </div>
      <div className="chat-att-doc-info">
        <div className="chat-att-doc-name">{fileName}</div>
        <div className="chat-att-doc-size">{formatSize(sizeBytes)}</div>
        <Progress value={progress} className="h-1.5 mt-1" />
      </div>
    </div>
  );
}
