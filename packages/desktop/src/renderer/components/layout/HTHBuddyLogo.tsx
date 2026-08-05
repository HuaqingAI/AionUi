/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useId } from 'react';

type HTHBuddyLogoProps = {
  className?: string;
  title?: string;
};

const HTHBuddyLogo: React.FC<HTHBuddyLogoProps> = ({ className, title }) => {
  const idPrefix = useId().replace(/:/g, '');
  const coreId = `${idPrefix}-hth-logo-core`;
  const glowId = `${idPrefix}-hth-logo-glow`;

  return (
    <svg
      className={className}
      viewBox='0 0 96 96'
      fill='none'
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <radialGradient id={coreId} cx='50%' cy='53%' r='45%'>
          <stop offset='0%' stopColor='#ffd978' />
          <stop offset='62%' stopColor='#f6a10a' />
          <stop offset='100%' stopColor='#c77100' />
        </radialGradient>
        <filter id={glowId} x='-70%' y='-70%' width='240%' height='240%'>
          <feGaussianBlur stdDeviation='7' result='blur' />
          <feColorMatrix in='blur' type='matrix' values='1 0 0 0 0.98 0 0.72 0 0 0.46 0 0 0.36 0 0.04 0 0 0 0.8 0' />
          <feBlend in='SourceGraphic' mode='screen' />
        </filter>
      </defs>
      <rect width='96' height='96' rx='12' fill='#030303' />
      <circle cx='48' cy='58' r='23' fill='#f4a000' opacity='0.5' filter={`url(#${glowId})`} />
      <circle cx='48' cy='58' r='21' fill={`url(#${coreId})`} />
      <text
        x='48'
        y='31'
        textAnchor='middle'
        fill='white'
        fontFamily='Arial, Helvetica, sans-serif'
        fontSize='24'
        fontWeight='800'
        letterSpacing='3'
      >
        HTH
      </text>
    </svg>
  );
};

export default HTHBuddyLogo;
