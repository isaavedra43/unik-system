'use client';

import React from 'react';
import { Phone, Video, PhoneOff } from 'lucide-react';
import { motion } from 'motion/react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/shadcn/dialog';
import { Avatar, AvatarFallback } from '@/components/shadcn/avatar';
import { Button } from '@/components/shadcn/button';
import type { ChatCallDTO } from '@/modules/chat/chat-events';

export interface ChatIncomingCallDialogProps {
  call: ChatCallDTO;
  onAccept: () => void;
  onDecline: () => void;
}

export function ChatIncomingCallDialog({ call, onAccept, onDecline }: ChatIncomingCallDialogProps) {
  const isVideo = call.type === 'video';

  return (
    <Dialog open onOpenChange={(v) => !v && onDecline()}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-sm gap-0 p-0 overflow-hidden"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>
            {isVideo ? 'Videollamada entrante' : 'Llamada entrante'}
          </DialogTitle>
          <DialogDescription>{call.callerName} te está llamando</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 p-6">
          <motion.div
            initial={{ scale: 0.9 }}
            animate={{ scale: 1 }}
            transition={{ duration: 0.3 }}
          >
            <Avatar className="size-20">
              <AvatarFallback className="text-2xl font-semibold bg-primary text-primary-foreground">
                {call.callerName.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          </motion.div>

          <div className="flex flex-col items-center gap-1 text-center">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {isVideo ? <Video size={16} /> : <Phone size={16} />}
              {isVideo ? 'Videollamada entrante' : 'Llamada entrante'}
            </div>
            <div className="text-lg font-semibold text-foreground">{call.callerName}</div>
            <motion.div
              className="flex items-center gap-2 text-sm text-muted-foreground"
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
            >
              <span className="size-2 rounded-full bg-destructive" />
              Llamando...
            </motion.div>
          </div>

          <div className="flex items-center gap-4 pt-2">
            <Button
              variant="destructive"
              size="icon"
              className="size-12 rounded-full"
              onClick={onDecline}
              aria-label="Rechazar"
            >
              <PhoneOff size={24} />
            </Button>
            <Button
              size="icon"
              className="size-12 rounded-full bg-success hover:bg-success/90 text-success-foreground"
              onClick={onAccept}
              aria-label="Aceptar"
            >
              {isVideo ? <Video size={24} /> : <Phone size={24} />}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
