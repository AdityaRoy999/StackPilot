import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import App from './App';

vi.mock('./context/FontContext', () => ({ FontProvider: ({children}: {children: React.ReactNode}) => children }));
vi.mock('./components/Hero', () => ({ Hero: () => <h1>StackPilot home</h1> }));
vi.mock('./components/Footer', () => ({ Footer: () => null }));
vi.mock('./components/DeferredSection', () => ({ DeferredSection: () => <div>Deferred media</div> }));
vi.mock('./components/Navbar', () => ({ Navbar: ({onNavigateDocs}: {onNavigateDocs: () => void}) => <button onClick={onNavigateDocs}>Documentation</button> }));
vi.mock('./pages/DocsPage', () => ({ DocsPage: ({onNavigateHome}: {onNavigateHome: () => void}) => <button onClick={onNavigateHome}>Return home</button> }));
beforeEach(() => { window.history.replaceState({}, '', '/'); vi.stubGlobal('scrollTo', vi.fn()); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('returns home immediately without an exit animation or blocking preloader', async () => {
  render(<App />);
  fireEvent.click(screen.getByText('Documentation'));
  fireEvent.click(await screen.findByText('Return home'));
  expect(screen.getByText('StackPilot home')).toBeTruthy();
  expect(window.location.pathname).toBe('/');
  expect(screen.queryByText('Click to Skip')).toBeNull();
});

it('restores a page through browser history', async () => {
  render(<App />);
  window.history.pushState({}, '', '/docs');
  fireEvent(window, new PopStateEvent('popstate'));
  expect(await screen.findByText('Return home')).toBeTruthy();
  window.history.pushState({}, '', '/');
  fireEvent(window, new PopStateEvent('popstate'));
  expect(screen.getByText('StackPilot home')).toBeTruthy();
});
