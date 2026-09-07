'use client';

import { redirect } from 'next/navigation';
import { useState, useEffect } from 'react';
import { getCurrentUser } from '@/modules/auth/authorization';
import { LoginForm } from './login-form';
import { motion } from 'framer-motion';
import { Icon } from '@/components/ui/icons';
import { useTheme } from '@/contexts/theme-context';

const particles = [
  { width: 380, height: 380, top: -100, left: -100, delay: 0, scale: 1 },
  { width: 260, height: 260, bottom: 60, right: -60, delay: 1.5, scale: 0.8 },
  { width: 140, height: 140, top: '35%', right: '18%', delay: 3, scale: 0.6 },
  { width: 80, height: 80, top: 20, right: 10, delay: 5, scale: 0.4 },
  { width: 50, height: 50, bottom: 10, left: 15, delay: 7, scale: 0.3 },
  { width: 210, height: 210, left: -50, top: '60%', delay: 2.5, scale: 0.7 },
  { width: 110, height: 110, bottom: 30, right: 15, delay: 4.5, scale: 0.5 },
];

const FloatingParticle = ({ width, height, top, left, bottom, right, delay, scale }: any) => {
  return (
    <motion.svg
      style={{
        width,
        height,
        [top]: top,
        [left]: left,
        [bottom]: bottom,
        [right]: right,
        transform: `scale(${scale})`,
        opacity: 0.08,
      }}
      animate={{
        y: [
          0,
          (top === -100 ? -4 : -12) / scale,
          0,
          (top === -100 ? 4 : 12) / scale,
          0
        ],
        x: [
          0,
          (left === -100 ? -4 : -12) / scale,
          0,
          (left === -100 ? 4 : 12) / scale,
          0
        ],
        scale: [scale, scale * 1.15, scale, scale * 1.1, scale],
      }}
      transition={{
        duration: 15,
        repeat: Infinity,
        delay,
        ease: easeInOutSine
      }}
      aria-hidden="true"
    >
      <motion.circle
        r={Math.min(width, height) / 2}
        fill="currentColor"
        animate={{ r: [Math.min(width, height) / 2 * 0.85, Math.min(width, height) / 2 * 1.05, Math.min(width, height) / 2] }}
        transition={{
          duration: 4,
          repeat: Infinity,
          delay: delay * 0.7,
        }}
      />
    </motion.svg>
  );
};

function waveAnimation(keyframes) {
  return keyframes.map((k, i) => `${(i + 1) * 10}deg ${k * 25}%`).join(' ');
}

function easeInOutSine(t: number) {
  return -0.5 * Math.cos(t * Math.PI) + 0.5;
}

export default function LoginPage() {
  const [isLoadingUser, setIsLoadingUser] = useState(false);

  useEffect(() => {
    const checkUser = async () => {
      const user = await getCurrentUser();
      if (user) {
        setIsLoadingUser(true);
        setTimeout(() => {
          redirect(user.mustChangePassword ? '/change-password' : '/app');
        }, 350);
      } else {
        setIsLoadingUser(false);
      }
    };
    checkUser();
  }, []);

  const { theme } = useTheme();
  const brandColor = theme === 'dark' ? 'rgba(59, 130, 246, 0.12)' : 'rgba(37, 99, 235, 0.15)';

  if (isLoadingUser) {
    return (
      <div className="auth-page">
        <div className="auth-hero-loading" style={{ width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="sparkle" size={48} className="spin" color="var(--unik-brand)" />
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page overflow-hidden relative bg-white dark:bg-navy-950">
      {/* Animated background gradient */}
      <motion.div
        className="absolute inset-0 bg-gradient-to-br"
        style={{ backgroundSize: 'cover', transition: 'background-size 60s ease' }}
        initial={{ backgroundSize: '200% 200%' }}
        animate={{ backgroundSize: '400% 400%' }}
        transition={{
          duration: 20,
          repeat: Infinity,
          ease: 'linear'
        }}
      >
        <motion.div className="opacity-30 blur-2xl" style={{ background: brandColor }} />
      </motion.div>

      {/* Floating animated particles */}
      {particles.map((p, i) => (
        <FloatingParticle key={i} {...p} />
      ))}

      {/* Left side - Hero */}
      <motion.div
        className="auth-hero hidden lg:flex flex-col justify-center items-center text-center w-[55vw] min-h-[90vh] p-12"
        style={{ position: 'relative', zIndex: 1 }}
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.2 }}
      >
        {/* Animated wave separator */}
        <div className="absolute inset-x-0 -bottom-16 h-24" aria-hidden="true">
          <svg viewBox="0 0 1440 320" className="w-full h-full">
            <motion.path
              fill="rgba(255,255,255,0.05)"
              d="M0,0L168,11.7C336,23.4,672,47,1008,59.3C1344,71.7,1680,100,1848,110L1920,128L1920,336L1440,336L960,336C480,336,0,336,0,0Z"
              style={{ fill: theme === 'dark' ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.08)' }}
              initial={false}
            />
          </svg>
        </div>

        {/* Animated logo/brand */}
        <motion.div
          className="relative"
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.3 }}
        >
          <motion.div
            className="absolute -inset-4 rounded-3xl bg-gradient-to-r"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1, delay: 0.5 }}
            style={{
              background: theme === 'dark' ? 'rgba(59,130,246,0.2)' : 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
              borderRadius: '2.5rem',
              boxShadow: theme === 'dark' ? '0 0 60px rgba(59,130,246,0.3)' : '0 0 80px rgba(59,130,246,0.4)'
            }}
            animate={{ scale: [1, 1.05, 1, 1.08, 1] }}
            transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
          />

          <div className="relative">
            <div className="text-5xl font-black tracking-tight mt-8 mb-3">
              <span style={{ color: theme === 'dark' ? '#3b82f6' : '#1e293b' }}>UNIK</span>
            </div>
            <div className="h-6 opacity-75">
              <span className="text-xl font-medium">Sistema de operación empresarial</span>
            </div>
          </div>
        </motion.div>

        {/* Statement with floating animation */}
        <motion.p
          className="mt-6 max-w-xl opacity-85 text-sm md:text-base leading-relaxed"
          animate={{ y: [-2, 2, -2] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
        >
          Controla tu operación desde un solo lugar. Seguro, limpio y pensado para escalar.
        </motion.p>

        {/* Animated decorative elements */}
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            className="absolute rounded-full"
            animate={{
              rotate: [0, 120, 240, 360],
              opacity: [0.3, 0.5, 0.3],
            }}
            transition={{
              duration: 8 + i * 0.5,
              repeat: Infinity,
              ease: 'linear',
              delay: 2 + i * 0.5
            }}
            style={{
              width: 6 + i * 3,
              height: 6 + i * 3,
              background: 'rgba(59,130,246,0.15)',
              left: -100 - i * 40,
              top: -100 - i * 20,
              boxShadow: '0 0 20px rgba(59,130,246,0.4)'
            }}
            aria-hidden="true"
          />
        ))}
      </motion.div>

      {/* Right side - Form */}
      <motion.div
        className="auth-form-wrap flex items-center justify-center w-[45vw] lg:h-auto lg:p-10"
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.8, delay: 0.4 }}
      >
        <LoginForm />
      </motion.div>

      {/* Desktop background patterns - animated */}
      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0px) rotate(0deg); }
          25% { transform: translateY(-8px) rotate(2deg); }
          75% { transform: translateY(5px) rotate(-1deg); }
        }

        @keyframes glow {
          0%, 100% { box-shadow: 0 0 20px rgba(59,130,246,0.3); }
          50% { box-shadow: 0 0 40px rgba(59,130,246,0.5), 0 0 60px rgba(59,130,246,0.3); }
        }

        @keyframes gradient-shift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }

        .login-card {
          background: linear-gradient(145deg, ${theme === 'dark' ? 'rgba(30, 41, 59, 0.95)' : 'rgba(255, 255, 255, 0.98)'), rgba(255, 255, 255, 0.5)});
          backdrop-filter: blur(20px);
          border: 1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'};
          border-radius: 24px;
          box-shadow: ${theme === 'dark' ? '0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 100px rgba(59, 130, 246, 0.2)' : '0 25px 50px -12px rgba(17, 19, 22, 0.2), 0 0 80px rgba(59, 130, 246, 0.25)'};
          animation: fadeInUp 0.6s ease-out both, glow 3s ease-in-out infinite;
          overflow: hidden;
        }

        @keyframes fadeInUp {
          0% { opacity: 0; transform: translateY(30px) scale(0.98); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }

        .brand-stripe {
          height: 4px;
          background: linear-gradient(90deg, #3b82f6 33%, #8b5cf6 33%, #8b5cf6 66%, #06b6d4 66%, #06b6d4 100%) !important;
          animation: gradient-shift 3s ease infinite;
          background-size: 400% 400%;
        }

        .login-header {
          text-align: center;
          padding-bottom: 1.5rem;
          border-bottom: 1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'};
          animation: slideDown 0.4s ease-out both;
        }

        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .login-input {
          animation: slideUp 0.3s ease-out both;
          animation-fill-mode: both;
        }

        @keyframes slideUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .login-input:last-of-type {
          animation-delay: 0.07s;
        }

        .submit-btn {
          animation: buttonPulse 2s ease-in-out infinite;
        }

        @keyframes buttonPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(59,130,246,0.4); }
          50% { box-shadow: 0 0 0 8px rgba(59,130,246,0); }
        }

        .remember-forgot {
          animation: rememberFade 0.3s ease-out both;
          animation-delay: 0.42s;
        }

        @keyframes rememberFade {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .login-form {
          animation: cardsStack 0.5s cubic-bezier(0.4, 0, 0.2, 1) both;
          animation-delay: 0.1s;
        }

        @keyframes cardsStack {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .error-message {
          animation: errorShake 0.4s ease-out both;
        }

        @keyframes errorShake {
          0%, 100% { transform: translateX(0); }
          10%, 30%, 50%, 70%, 90% { transform: translateX(-2px); }
          20%, 40%, 60%, 80% { transform: translateX(2px); }
        }

        .particle {
          filter: drop-shadow(0 0 20px rgba(59,130,246,0.3));
        }

        .brand-badge {
          position: absolute;
          top: 28px;
          right: 32px;
          width: 32px;
          height: 32px;
          background: linear-gradient(135deg, rgba(59,130,246,0.2), rgba(139,92,246,0.2));
          backdrop-filter: blur(8px);
          border-radius: var(--unik-radius-full);
          display: flex;
          align-items: center;
          justify-content: center;
          animation: badgeFloat 6s ease-in-out infinite;
        }

        @keyframes badgeFloat {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
      `}</style>

      {/* Floating cards behind */}
      <div className="absolute -left-24 -top-24 pointer-events-none" aria-hidden="true">
        <div className="w-64 h-64 rounded-full" style={{ background: 'rgba(59,130,246,0.1)', backdropFilter: 'blur(10px)' }} />
      </div>
      <div className="absolute -right-24 -bottom-24 pointer-events-none" aria-hidden="true">
        <div className="w-64 h-64 rounded-full" style={{ background: 'rgba(139,92,246,0.1)', backdropFilter: 'blur(10px)' }} />
      </div>
    </div>
  );
}
