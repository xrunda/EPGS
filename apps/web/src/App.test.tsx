import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import App from './App';

describe('App', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'ok', version: '0.1.0', uptime: 1.23 }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the placeholder heading', async () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: '内镜中心' })).toBeInTheDocument();

    // Let the ApiStatus effect's fetch promise resolve so this test
    // doesn't leak a pending state update into the next one.
    await waitFor(() => expect(screen.getByTestId('api-status')).toHaveTextContent('API 已连接'));
  });

  it('calls the API /health endpoint and displays connectivity status', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('api-status')).toHaveTextContent('API 已连接');
    });

    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/health'));
  });
});
