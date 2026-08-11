import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  localStorage.clear();
});
