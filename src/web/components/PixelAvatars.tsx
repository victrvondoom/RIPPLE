import React from 'react';

export interface PixelAvatarProps {
  type: 'crown' | 'detective' | 'chef' | 'wizard' | 'piggy' | 'scholar' | 'engineer' | 'robot' | 'shield' | 'doctor' | 'tower';
  size?: number;
  className?: string;
}

export function PixelAvatar({ type, size = 32, className = '' }: PixelAvatarProps) {
  // Ultra-crisp SVG pixel-art representations matching the reference aesthetic
  switch (type) {
    case 'crown':
      // The "You" Controller pixel character with golden crown and regal purple mantle
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" className={`pixel-avatar ${className}`} style={{ imageRendering: 'pixelated', shapeRendering: 'crispEdges' }}>
          {/* Hair/Head */}
          <rect x="5" y="3" width="6" height="3" fill="#ffd166" />
          <rect x="4" y="4" width="8" height="2" fill="#ffd166" />
          <rect x="5" y="2" width="1" height="2" fill="#e09f3e" />
          <rect x="7" y="1" width="2" height="3" fill="#e09f3e" />
          <rect x="10" y="2" width="1" height="2" fill="#e09f3e" />
          {/* Crown Jewels */}
          <rect x="6" y="3" width="1" height="1" fill="#ef476f" />
          <rect x="9" y="3" width="1" height="1" fill="#118ab2" />
          {/* Face */}
          <rect x="5" y="6" width="6" height="5" fill="#f8edeb" />
          {/* Eyes */}
          <rect x="6" y="7" width="1" height="2" fill="#1d3557" />
          <rect x="9" y="7" width="1" height="2" fill="#1d3557" />
          {/* Beard / Collar */}
          <rect x="5" y="10" width="6" height="2" fill="#2b2d42" />
          {/* Body / Mantle */}
          <rect x="4" y="12" width="8" height="4" fill="#3a0ca3" />
          <rect x="6" y="12" width="4" height="4" fill="#f8edeb" />
          <rect x="7" y="13" width="2" height="1" fill="#ffd166" />
        </svg>
      );

    case 'detective':
      // GPU Auditor / Forensic Detective with fedora hat & trenchcoat
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" className={`pixel-avatar ${className}`} style={{ imageRendering: 'pixelated', shapeRendering: 'crispEdges' }}>
          {/* Hat Brim */}
          <rect x="3" y="4" width="10" height="2" fill="#9c6644" />
          <rect x="5" y="2" width="6" height="3" fill="#7f4f24" />
          <rect x="5" y="4" width="6" height="1" fill="#4a2810" />
          {/* Face */}
          <rect x="5" y="6" width="6" height="4" fill="#fed9b7" />
          {/* Eyes behind shades / shadow */}
          <rect x="5" y="7" width="2" height="1" fill="#222" />
          <rect x="9" y="7" width="2" height="1" fill="#222" />
          {/* Mustache */}
          <rect x="6" y="9" width="4" height="1" fill="#582f0e" />
          {/* Trenchcoat */}
          <rect x="4" y="10" width="8" height="6" fill="#b08968" />
          <rect x="7" y="10" width="2" height="4" fill="#4a2810" />
          <rect x="7" y="14" width="2" height="2" fill="#6f1d1b" />
        </svg>
      );

    case 'chef':
      // Cost Allocator / Ledger Chef with toque / mint visor
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" className={`pixel-avatar ${className}`} style={{ imageRendering: 'pixelated', shapeRendering: 'crispEdges' }}>
          {/* Chef Hat / Visor */}
          <rect x="5" y="1" width="6" height="4" fill="#f8f9fa" />
          <rect x="4" y="3" width="8" height="2" fill="#e9ecef" />
          <rect x="4" y="5" width="8" height="1" fill="#06d6a0" />
          {/* Face */}
          <rect x="5" y="6" width="6" height="4" fill="#fceade" />
          <rect x="6" y="7" width="1" height="1" fill="#264653" />
          <rect x="9" y="7" width="1" height="1" fill="#264653" />
          <rect x="7" y="9" width="2" height="1" fill="#e76f51" />
          {/* Uniform */}
          <rect x="4" y="10" width="8" height="6" fill="#f8f9fa" />
          <rect x="5" y="11" width="1" height="1" fill="#2a9d8f" />
          <rect x="5" y="13" width="1" height="1" fill="#2a9d8f" />
          <rect x="10" y="11" width="1" height="1" fill="#2a9d8f" />
          <rect x="10" y="13" width="1" height="1" fill="#2a9d8f" />
        </svg>
      );

    case 'wizard':
      // Vendor Liaison with mystical beard and turquoise hat
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" className={`pixel-avatar ${className}`} style={{ imageRendering: 'pixelated', shapeRendering: 'crispEdges' }}>
          {/* Wizard Hat */}
          <rect x="7" y="1" width="2" height="2" fill="#3a86ff" />
          <rect x="6" y="3" width="4" height="2" fill="#3a86ff" />
          <rect x="4" y="5" width="8" height="1" fill="#8338ec" />
          {/* Face */}
          <rect x="5" y="6" width="6" height="3" fill="#ffe5d9" />
          <rect x="6" y="7" width="1" height="1" fill="#03045e" />
          <rect x="9" y="7" width="1" height="1" fill="#03045e" />
          {/* White Beard */}
          <rect x="5" y="9" width="6" height="4" fill="#f8f9fa" />
          <rect x="6" y="13" width="4" height="2" fill="#e9ecef" />
          {/* Robe */}
          <rect x="4" y="11" width="8" height="5" fill="#8338ec" />
        </svg>
      );

    case 'piggy':
      // Budget Analyst / Piggy bank avatar
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" className={`pixel-avatar ${className}`} style={{ imageRendering: 'pixelated', shapeRendering: 'crispEdges' }}>
          {/* Ears */}
          <rect x="4" y="3" width="2" height="2" fill="#ff70a6" />
          <rect x="10" y="3" width="2" height="2" fill="#ff70a6" />
          {/* Head/Face */}
          <rect x="4" y="5" width="8" height="6" fill="#ff97b7" />
          <rect x="5" y="7" width="1" height="1" fill="#4a0e17" />
          <rect x="10" y="7" width="1" height="1" fill="#4a0e17" />
          {/* Snout */}
          <rect x="6" y="8" width="4" height="2" fill="#ff70a6" />
          <rect x="7" y="8" width="1" height="1" fill="#4a0e17" />
          <rect x="8" y="8" width="1" height="1" fill="#4a0e17" />
          {/* Body */}
          <rect x="3" y="11" width="10" height="4" fill="#ff70a6" />
          <rect x="7" y="12" width="2" height="1" fill="#ffd166" />
        </svg>
      );

    case 'scholar':
      // Controls Lead with graduation cap & purple spectacles
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" className={`pixel-avatar ${className}`} style={{ imageRendering: 'pixelated', shapeRendering: 'crispEdges' }}>
          {/* Mortarboard */}
          <rect x="3" y="3" width="10" height="2" fill="#2b2d42" />
          <rect x="7" y="2" width="2" height="1" fill="#495057" />
          <rect x="12" y="4" width="1" height="3" fill="#ffd166" />
          {/* Face */}
          <rect x="5" y="5" width="6" height="5" fill="#f8edeb" />
          {/* Glasses */}
          <rect x="5" y="6" width="3" height="2" fill="#7209b7" />
          <rect x="8" y="6" width="3" height="2" fill="#7209b7" />
          <rect x="6" y="7" width="1" height="1" fill="#fff" />
          <rect x="9" y="7" width="1" height="1" fill="#fff" />
          {/* Gown */}
          <rect x="4" y="10" width="8" height="6" fill="#3d348b" />
          <rect x="7" y="10" width="2" height="6" fill="#e0b1cb" />
        </svg>
      );

    case 'engineer':
      // Capacity Planner with yellow hard-hat
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" className={`pixel-avatar ${className}`} style={{ imageRendering: 'pixelated', shapeRendering: 'crispEdges' }}>
          {/* Hard Hat */}
          <rect x="5" y="2" width="6" height="3" fill="#ffb703" />
          <rect x="3" y="4" width="10" height="2" fill="#fb8500" />
          {/* Face */}
          <rect x="5" y="6" width="6" height="4" fill="#ffddb0" />
          <rect x="6" y="7" width="1" height="1" fill="#023047" />
          <rect x="9" y="7" width="1" height="1" fill="#023047" />
          {/* Overalls / Vest */}
          <rect x="4" y="10" width="8" height="6" fill="#023047" />
          <rect x="5" y="11" width="6" height="2" fill="#fb8500" />
          <rect x="6" y="12" width="4" height="1" fill="#ffb703" />
        </svg>
      );

    case 'robot':
      // Independent Verifier / AI Agent
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" className={`pixel-avatar ${className}`} style={{ imageRendering: 'pixelated', shapeRendering: 'crispEdges' }}>
          {/* Antenna */}
          <rect x="7" y="1" width="2" height="2" fill="#64748b" />
          <rect x="7" y="0" width="2" height="1" fill="#06d6a0" />
          {/* Head */}
          <rect x="4" y="3" width="8" height="6" fill="#94a3b8" />
          <rect x="3" y="5" width="1" height="2" fill="#64748b" />
          <rect x="12" y="5" width="1" height="2" fill="#64748b" />
          {/* Visor / Eyes */}
          <rect x="5" y="5" width="6" height="2" fill="#0f172a" />
          <rect x="6" y="5" width="1" height="2" fill="#38bdf8" />
          <rect x="9" y="5" width="1" height="2" fill="#38bdf8" />
          {/* Chassis */}
          <rect x="4" y="9" width="8" height="6" fill="#64748b" />
          <rect x="6" y="10" width="4" height="2" fill="#06d6a0" />
        </svg>
      );

    case 'doctor':
      // Clinical / Healthcare Director
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" className={`pixel-avatar ${className}`} style={{ imageRendering: 'pixelated', shapeRendering: 'crispEdges' }}>
          {/* Head / Cap */}
          <rect x="4" y="3" width="8" height="3" fill="#06d6a0" />
          <rect x="5" y="6" width="6" height="4" fill="#fed9b7" />
          <rect x="6" y="7" width="1" height="1" fill="#073b4c" />
          <rect x="9" y="7" width="1" height="1" fill="#073b4c" />
          {/* Mask */}
          <rect x="5" y="8" width="6" height="3" fill="#f8f9fa" />
          <rect x="7" y="9" width="2" height="1" fill="#118ab2" />
          {/* Scrubs */}
          <rect x="4" y="11" width="8" height="5" fill="#06d6a0" />
          <rect x="7" y="11" width="2" height="2" fill="#ef476f" />
        </svg>
      );

    case 'tower':
      // Telecom Mediation Agent
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" className={`pixel-avatar ${className}`} style={{ imageRendering: 'pixelated', shapeRendering: 'crispEdges' }}>
          <rect x="7" y="1" width="2" height="14" fill="#3b82f6" />
          <rect x="5" y="3" width="6" height="2" fill="#60a5fa" />
          <rect x="3" y="6" width="10" height="2" fill="#93c5fd" />
          <rect x="1" y="9" width="14" height="2" fill="#bfdbfe" />
          <rect x="7" y="0" width="2" height="1" fill="#ef4444" />
        </svg>
      );

    case 'shield':
    default:
      // Security / Fraud Defender
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" className={`pixel-avatar ${className}`} style={{ imageRendering: 'pixelated', shapeRendering: 'crispEdges' }}>
          <rect x="5" y="2" width="6" height="3" fill="#1e293b" />
          <rect x="5" y="5" width="6" height="4" fill="#ffedd5" />
          <rect x="6" y="6" width="1" height="1" fill="#0f172a" />
          <rect x="9" y="6" width="1" height="1" fill="#0f172a" />
          {/* Shield */}
          <path d="M4,9 L12,9 L12,12 L8,15 L4,12 Z" fill="#3b82f6" />
          <rect x="7" y="10" width="2" height="3" fill="#fbbf24" />
        </svg>
      );
  }
}

