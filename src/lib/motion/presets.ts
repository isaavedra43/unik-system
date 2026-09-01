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

export const fadeTransition: Transition = {
  duration: duration.normal,
  ease: ease.out,
};

export const fadeIn: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: fadeTransition },
  exit: { opacity: 0, transition: { duration: duration.fast } },
};

export const fadeUp: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: fadeTransition },
  exit: { opacity: 0, y: 4, transition: { duration: duration.fast } },
};

export const scaleIn: Variants = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: fadeTransition },
  exit: { opacity: 0, scale: 0.98, transition: { duration: duration.fast } },
};

export const slideInRight: Variants = {
  initial: { x: '100%' },
  animate: { x: 0, transition: { duration: duration.slow, ease: ease.out } },
  exit: { x: '100%', transition: { duration: duration.normal } },
};

export const slideInUp: Variants = {
  initial: { y: '100%' },
  animate: { y: 0, transition: { duration: duration.slow, ease: ease.out } },
  exit: { y: '100%', transition: { duration: duration.normal } },
};

export const stagger: Variants = {
  animate: {
    transition: {
      staggerChildren: 0.05,
    },
  },
};

export const listItem: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: fadeTransition },
  exit: { opacity: 0, transition: { duration: duration.fast } },
};
