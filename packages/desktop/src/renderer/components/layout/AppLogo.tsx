/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import HuaqingLogo from '@renderer/assets/logos/huaqing-logo.svg';
import React from 'react';

type AppLogoProps = {
  className?: string;
  title?: string;
};

const AppLogo: React.FC<AppLogoProps> = ({ className, title }) => {
  return (
    <img
      className={className}
      src={HuaqingLogo}
      alt={title ?? ''}
      aria-hidden={title ? undefined : true}
    />
  );
};

export default AppLogo;
