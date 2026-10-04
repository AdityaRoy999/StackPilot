import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import InstallSetup from './InstallSetup';
afterEach(cleanup);

it('offers platform-specific guided downloads and keeps terminal options available', () => {
  render(<InstallSetup />);
  const select = screen.getByLabelText('Download for');
  for (const platform of ['windows', 'macos', 'linux']) {
    fireEvent.change(select, { target: { value: platform } });
    expect(screen.getByText('Download guided setup').getAttribute('href')).toBe(`/stackpilot-setup-${platform}.zip`);
  }
  expect(screen.getByText('Advanced: terminal installation / HTTPS server')).toBeTruthy();
  expect(screen.getByText(/Python 3.10\+ opens the wizard/)).toBeTruthy();
});
