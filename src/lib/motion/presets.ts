import { type Transition, type Variants } from 'motion/react';

export const duration = {
  fast: 0.15,
  normal: 0.22,
  slow: 0.32,
} as const;

export const ease = {
  default: [0.25, 0.1, 0.25, 1],
  in: [0.4, 0, 1, 1],
  out: [0, 0, 0.2, 1],
  spring: { type: 'spring' as const, stiffness: 300, damping: 30 },
} as const;

const fadeTransition: Transition = {
  duration: duration.normal,
  ease: ease.out,
};

export const listItem: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: fadeTransition },
  exit: { opacity: 0, transition: { duration: duration.fast } },
};
